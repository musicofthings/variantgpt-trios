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
from variantgpt_engine.acmg import classify  # noqa: E402
from variantgpt_engine.annotation import AnnotationContext, annotate  # noqa: E402
from variantgpt_engine.annotation_sources import myvariant, vep_rest  # noqa: E402
from variantgpt_engine.annotation_sources.csq import pick_canonical  # noqa: E402
from variantgpt_engine.build_detect import detect_build  # noqa: E402
from variantgpt_engine.filter import filter_candidates  # noqa: E402
from variantgpt_engine.inheritance import assign_models, compound_het_pass  # noqa: E402
from variantgpt_engine.joint import merge  # noqa: E402
from variantgpt_engine.models import Build, CaseEmission, HPOTerm, Variant  # noqa: E402
from variantgpt_engine.preprocess import PreprocessConfig, preprocess_vcf  # noqa: E402
from variantgpt_engine.prioritize import priority  # noqa: E402
from variantgpt_engine.qc import compute_qc  # noqa: E402
from variantgpt_engine.reclassify import reclassify_all  # noqa: E402
from run_uploaded_case import _build_ped, _ensure_uncompressed_vcf, _find_member  # noqa: E402


# Demo data has 11 variants; clinical exomes have ~250k post-merge; WGS up to 5M.
# We use this threshold to switch from "demo-data overlay" to "live annotation"
# mode automatically — no UI flag, just the size of the input determines the path.
DEMO_MODE_THRESHOLD = 100
# After the rare-variant + benign-consequence filter, we cap further work at
# this many candidates. Typical exome filters down to ~3-5k; WGS to ~5-10k.
MAX_VARIANTS_AFTER_FILTER = 10000


def _check_bearer(request: Request) -> JSONResponse | None:
    """Reject requests that don't present the shared bearer token. Set via the
    ENGINE_BEARER env / Fly secret. Health endpoint is exempt."""
    expected = os.environ.get("ENGINE_BEARER")
    if not expected:
        # No bearer configured — accept all (dev mode). Log a warning.
        print("[warn] ENGINE_BEARER unset; engine is open. Set it via `fly secrets set`.", flush=True)
        return None
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or auth.removeprefix("Bearer ") != expected:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return None


async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


async def run(request: Request) -> JSONResponse:
    reject = _check_bearer(request)
    if reject is not None:
        return reject
    body = await request.json()
    required = ("case_id", "manifest", "vcf_urls", "case_put_url",
                "callback_url", "callback_secret")
    missing = [k for k in required if k not in body]
    if missing:
        return JSONResponse({"error": f"missing fields: {missing}"}, status_code=400)

    # Run synchronously: Fly's auto_stop_machines=stop kills the machine when
    # no HTTP request is in flight, which would orphan a background task. By
    # awaiting the job, the request stays open and the machine stays warm. The
    # Worker holds the connection open via executionCtx.waitUntil — it doesn't
    # block the user, who is already polling /status backed by D1.
    try:
        await _execute_job(body)
    except Exception as e:  # noqa: BLE001 — surface to caller + logs
        print(f"[{body.get('case_id')}] /run crashed: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        return JSONResponse(
            {"ok": False, "case_id": body.get("case_id"), "error": f"{type(e).__name__}: {e}"},
            status_code=500,
        )
    return JSONResponse({"ok": True, "case_id": body["case_id"]}, status_code=200)


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

            # Per-VCF: gunzip if needed → run the standard preprocessing pipeline
            # (validate, normalize chrom, split multi-allelic, trim alleles,
            # apply site + genotype QC, dedupe, sort). Output is the .clean.vcf
            # that the joint matrix consumes — guarantees consistent allele
            # representation across all three samples (critical for the merge
            # to align variants by (chrom, pos, ref, alt)).
            vcf_map: dict[str, Path] = {}
            for role, fname in manifest.get("files", {}).items():
                src = workdir / fname
                member = _find_member(manifest["pedigree"], role)
                if not member:
                    raise RuntimeError(f"no pedigree member for role={role}")
                raw = _ensure_uncompressed_vcf(src, workdir / f"{member['id']}.raw.vcf")
                clean = workdir / f"{member['id']}.clean.vcf"
                emit(f"preprocess {role}: {raw.name} -> {clean.name}")
                rep = await asyncio.to_thread(
                    preprocess_vcf, raw, clean,
                    config=PreprocessConfig(),  # clinical defaults; override later via manifest
                )
                emit(
                    f"  {role}: in={rep.input_records} out={rep.output_records} "
                    f"split={rep.multi_allelic_split} trimmed={rep.trimmed_alleles} "
                    f"dedup={rep.dropped_duplicate} dropped_filter={rep.dropped_filtered} "
                    f"dropped_qual={rep.dropped_low_qual} dropped_homref={rep.dropped_hom_ref} "
                    f"gt_gq_filtered={rep.gt_filtered_low_gq} gt_dp_filtered={rep.gt_filtered_low_dp} "
                    f"gt_ab_filtered={rep.gt_filtered_bad_ab} ({rep.elapsed_ms}ms)"
                )
                for w in rep.warnings[:5]:
                    emit(f"  warn: {w}")
                vcf_map[member["id"]] = clean

            has_proband = any(
                m["role"] == "proband" and not m.get("missing") and m["id"] in vcf_map
                for m in manifest["pedigree"]
            )
            if not has_proband:
                raise RuntimeError("proband VCF required (PRD §4.1)")

            present_count = sum(1 for m in manifest["pedigree"] if not m.get("missing"))
            emit(f"members={len(manifest['pedigree'])} present={present_count} vcfs={len(vcf_map)}")
            await post_status("running")  # surface log/manifest progress

            # 3. Run the engine pipeline step by step. Each step runs in a
            # worker thread (it's CPU-bound, synchronous code) so the event
            # loop stays responsive between phases — gives us crisp log
            # checkpoints to localize hangs.
            emit("loading PED")
            pedigree = load_ped(ped_path)

            emit("detecting build")
            resolved_build: Build = Build.grch38
            for p in vcf_map.values():
                b = await asyncio.to_thread(detect_build, p)
                if b is not None:
                    resolved_build = b
                    break
            emit(f"build={resolved_build.value}")
            await post_status("running")

            emit("merging VCFs")
            joint = await asyncio.to_thread(merge, vcf_map)
            emit(f"merged: {len(joint)} joint variants")
            await post_status("running")

            # Determine pipeline mode by input size. Small inputs route through
            # the curated demo-annotation overlay; everything else hits the live
            # annotation stack (VCF CSQ → VEP REST → gnomAD live).
            real_mode = len(joint) > DEMO_MODE_THRESHOLD
            csq_count = sum(1 for jv in joint if jv.csq)
            emit(f"mode={'real' if real_mode else 'demo'} csq_annotated={csq_count}")

            emit("computing QC")
            qc = await asyncio.to_thread(compute_qc, joint, pedigree)
            emit("QC done")
            await post_status("running")

            if real_mode:
                # Pre-filter: drop common variants and benign-by-construction
                # consequences before any expensive annotation.
                emit("filtering rare + coding")
                joint_filtered, fstats = await asyncio.to_thread(
                    filter_candidates, joint, max_af=0.01, drop_filtered=True,
                )
                emit(
                    f"filter: kept={fstats.kept} "
                    f"dropped_af={fstats.dropped_by_af} "
                    f"dropped_consequence={fstats.dropped_by_consequence} "
                    f"dropped_filter_field={fstats.dropped_by_filter_field}"
                )
                if len(joint_filtered) > MAX_VARIANTS_AFTER_FILTER:
                    raise RuntimeError(
                        f"after rare-variant + consequence filter, {len(joint_filtered)} "
                        f"variants remain (cap: {MAX_VARIANTS_AFTER_FILTER}). The input "
                        f"VCF likely doesn't carry AF annotation, so the AF filter couldn't "
                        f"apply. Either pre-annotate with VEP (so CSQ + AF fields land on "
                        f"each row) or filter the VCF locally before upload."
                    )
                joint = joint_filtered
                await post_status("running")

                # For survivors without CSQ, fall back to Ensembl VEP REST.
                missing_csq = [jv for jv in joint if not jv.csq]
                if missing_csq:
                    emit(f"VEP REST: annotating {len(missing_csq)} variants")
                    filled = await asyncio.to_thread(vep_rest.annotate_batch, joint)
                    emit(f"VEP REST: filled {filled} variants")
                    await post_status("running")

            track_versions = {"engine": "0.1.0"}
            if not real_mode:
                track_versions["demo_dataset"] = "v1"
            ctx = AnnotationContext(
                build=resolved_build.value,
                track_versions=track_versions,
                # Live gnomAD on real-mode survivors (already filtered down).
                use_gnomad=real_mode,
                gnomad_timeout=5.0,
                use_demo_annotations=not real_mode,
            )

            # Do the entire annotate→classify→priority sweep in a single
            # worker thread. The previous per-variant await was paying the
            # full event-loop context-switch cost N times (~50ms each) — at
            # WGS scale that turns minutes of work into hours.
            hpo_ids = manifest.get("hpo", [])

            def _annotate_classify_all() -> list[Variant]:
                out: list[Variant] = []
                for jv in joint:
                    models, conf = assign_models(jv, pedigree)
                    v = annotate(jv, ctx)
                    v.inheritance_models = models
                    v.inheritance_confidence = conf  # type: ignore[assignment]
                    out.append(v)
                # Compound-het pass needs gene assignment from annotation.
                addl = compound_het_pass(
                    [(jv, vv.gene) for jv, vv in zip(joint, out)], pedigree,
                )
                for vv, jv in zip(out, joint):
                    if jv.key in addl:
                        vv.inheritance_models = list(dict.fromkeys(vv.inheritance_models + addl[jv.key]))
                for vv in out:
                    tier, points, ledger = classify(vv)
                    vv.baseline_tier = tier
                    vv.baseline_points = points
                    vv.evidence = ledger
                    priority(vv, hpo_ids)
                return out

            emit(f"annotating + classifying {len(joint)} variants")
            variants: list[Variant] = await asyncio.to_thread(_annotate_classify_all)
            emit("annotation + classification done")
            await post_status("running")

            # ClinVar + dbNSFP overlay via myvariant.info — batched, one POST
            # per 1000 variants. Real-mode only (demo path uses curated data).
            if real_mode and variants:
                emit(f"myvariant.info: ClinVar + dbNSFP for {len(variants)} variants")
                pairs = list(zip(joint, variants))
                filled = await asyncio.to_thread(myvariant.annotate_variants, pairs)
                clinvar_count = sum(1 for v in variants if v.clinvar)
                emit(f"myvariant.info: filled={filled} clinvar_records={clinvar_count}")
                await post_status("running")

            emit("reclassifying (South Asian)")
            proposals = await asyncio.to_thread(
                reclassify_all, variants, snapshot_versions=track_versions
            )

            emission = CaseEmission(
                case_id=case_id,
                build=resolved_build,
                pedigree=pedigree,
                hpo=[HPOTerm(hpo_id=h) for h in hpo_ids],
                qc=qc,
                variants=variants,
                proposals=proposals,
                versions=track_versions,
            )
            emit(f"variants={len(emission.variants)} proposals={len(emission.proposals)}")
            await post_status("running")

            # 4. Upload case.json to R2 via the signed PUT.
            emit("serializing case.json")
            case_json = emission.model_dump_json(indent=2).encode("utf-8")
            emit(f"uploading case.json ({len(case_json)} bytes)")
            async with httpx.AsyncClient(timeout=60.0) as client:
                put = await client.put(
                    case_put_url,
                    content=case_json,
                    headers={"content-type": "application/json"},
                )
                emit(f"case.json upload status={put.status_code}")
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
