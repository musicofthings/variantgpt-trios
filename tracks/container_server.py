"""HTTP shim that runs inside the Cloudflare Container.

The Worker invokes this service per case. We don't accept raw VCF bytes here
(Workers body-size limits + cold-start cost) — instead the Worker signs short-
lived R2 GET URLs for the uploaded VCFs and a PUT URL for the case.json output,
and the container does the data motion itself.

Endpoints
---------
GET  /healthz                       → {"ok": true}
POST /run
    body: {
        "case_id":      str,
        "manifest":     <same shape as data/uploads/<id>/manifest.json>,
        "vcf_urls":     {role: signed-GET-url, ...},
        "case_put_url": signed-PUT-url for cases/<id>/case.json,
        "callback_url": where to POST status + log lines,
        "callback_secret": HMAC key for the X-VGPT-Signature header,
    }
    response: 202 {ok: true, case_id}     # work runs in a background task

Callbacks posted to callback_url
    {"case_id", "status": "running"|"ready"|"error", "log": [...lines...],
     "error": optional, "finishedAt": optional epoch ms}
    Signed with HMAC-SHA256(secret, body_bytes) → header X-VGPT-Signature.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

# tracks/ is on sys.path so we can reuse the existing PED + dispatch helpers
# from run_uploaded_case.py without duplicating them.
THIS = Path(__file__).resolve()
sys.path.insert(0, str(THIS.parent))
sys.path.insert(0, str(THIS.parents[1] / "engine" / "src"))

from variantgpt_engine.pedigree import load_ped  # noqa: E402
from variantgpt_engine.pipeline import run_case  # noqa: E402
from run_uploaded_case import _build_ped, _ensure_uncompressed_vcf, _find_member  # noqa: E402


async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


async def run(request: Request) -> JSONResponse:
    body = await request.json()
    required = ("case_id", "manifest", "vcf_urls", "case_put_url",
                "callback_url", "callback_secret")
    missing = [k for k in required if k not in body]
    if missing:
        return JSONResponse({"error": f"missing fields: {missing}"}, status_code=400)

    # Fire-and-forget — Worker polls /status (backed by callbacks into D1)
    # rather than holding this HTTP connection open for minutes.
    asyncio.create_task(_execute_job(body))
    return JSONResponse({"ok": True, "case_id": body["case_id"]}, status_code=202)


async def _execute_job(job: dict[str, Any]) -> None:
    case_id = job["case_id"]
    manifest = job["manifest"]
    vcf_urls: dict[str, str] = job["vcf_urls"]
    case_put_url: str = job["case_put_url"]
    callback_url: str = job["callback_url"]
    secret: str = job["callback_secret"]

    log: list[str] = []

    def emit(line: str) -> None:
        log.append(line)
        print(f"[{case_id}] {line}", flush=True)

    async def post_status(status: str, **extra: Any) -> None:
        payload = {"case_id": case_id, "status": status, "log": log[-50:], **extra}
        body_bytes = json.dumps(payload).encode("utf-8")
        sig = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    callback_url,
                    content=body_bytes,
                    headers={"content-type": "application/json", "X-VGPT-Signature": sig},
                )
        except Exception as e:  # noqa: BLE001 — callbacks are best-effort
            print(f"[{case_id}] callback failed: {e}", flush=True)

    try:
        await post_status("running")

        with tempfile.TemporaryDirectory(prefix=f"vgpt-{case_id}-") as tmp:
            workdir = Path(tmp)
            emit(f"workdir={workdir}")

            # 1. Download each uploaded VCF from its signed R2 URL.
            async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
                for role, url in vcf_urls.items():
                    # Honor whatever extension the Worker recorded — the engine
                    # gunzips .gz transparently downstream.
                    fname = manifest.get("files", {}).get(role) or f"{role}.vcf"
                    dst = workdir / fname
                    emit(f"download role={role} -> {fname}")
                    async with client.stream("GET", url) as r:
                        r.raise_for_status()
                        with open(dst, "wb") as fh:
                            async for chunk in r.aiter_bytes():
                                fh.write(chunk)

            # 2. Materialize PED + decompress per-member VCFs (reuse existing logic).
            ped_path = workdir / "family.ped"
            ped_path.write_text(_build_ped(case_id, manifest["pedigree"]), encoding="utf-8")

            vcf_map: dict[str, Path] = {}
            for role, fname in manifest.get("files", {}).items():
                src = workdir / fname
                member = _find_member(manifest["pedigree"], role)
                if not member:
                    raise RuntimeError(f"no pedigree member for role={role}")
                vcf_map[member["id"]] = _ensure_uncompressed_vcf(
                    src, workdir / f"{member['id']}.vcf"
                )

            has_proband = any(
                m["role"] == "proband" and not m.get("missing") and m["id"] in vcf_map
                for m in manifest["pedigree"]
            )
            if not has_proband:
                raise RuntimeError("proband VCF required (PRD §4.1)")

            present_count = sum(1 for m in manifest["pedigree"] if not m.get("missing"))
            emit(f"members={len(manifest['pedigree'])} present={present_count} vcfs={len(vcf_map)}")
            await post_status("running")  # surface log/manifest progress

            # 3. Run the engine.
            pedigree = load_ped(ped_path)
            emission = run_case(
                case_id=case_id,
                pedigree=pedigree,
                vcf_paths=vcf_map,
                hpo_ids=manifest.get("hpo", []),
                build="auto",
                use_demo_annotations=True,
            )
            emit(f"variants={len(emission.variants)} proposals={len(emission.proposals)}")

            # 4. Upload case.json to R2 via the signed PUT.
            case_json = emission.model_dump_json(indent=2).encode("utf-8")
            async with httpx.AsyncClient(timeout=60.0) as client:
                put = await client.put(
                    case_put_url,
                    content=case_json,
                    headers={"content-type": "application/json"},
                )
                put.raise_for_status()
            emit("uploaded case.json")

        await post_status("ready", finishedAt=int(time.time() * 1000))

    except Exception as e:  # noqa: BLE001 — convert any failure to a status update
        tb = traceback.format_exc(limit=4)
        emit(f"error: {e}")
        emit(tb)
        await post_status(
            "error",
            error=str(e),
            finishedAt=int(time.time() * 1000),
        )


app = Starlette(
    debug=os.getenv("VGPT_DEBUG") == "1",
    routes=[
        Route("/healthz", healthz, methods=["GET"]),
        Route("/run", run, methods=["POST"]),
    ],
)
