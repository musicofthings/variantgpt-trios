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
import gc
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
from variantgpt_engine import cache  # noqa: E402
from variantgpt_engine.build_detect import detect_build  # noqa: E402
from variantgpt_engine.filter import filter_candidates, proband_carrier_filter  # noqa: E402
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
# Hard ceiling for the AF lookup stage. ~150k at 10-way concurrency × 200/batch
# ≈ 75 round-trips. Above this, the input almost certainly needs upstream
# filtering and we'd rather fail fast than burn 10+ minutes of compute.
MAX_AF_LOOKUP_CAP = 200000
# Process AF lookup in chunks of N variants so we can post_status() to D1
# (and the UI's RunMonitor) between chunks. 5000 variants = 25 batches per
# chunk = ~3-5 seconds with 10-way concurrency, so ~1 status update every 5s.
AF_LOOKUP_CHUNK_SIZE = 5000


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
    cache_urls: dict[str, dict[str, str]] = job.get("cache_urls", {})
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
                # ── Stage 1: proband-carrier filter ──
                # In trio analysis every inheritance model requires the proband
                # to carry the variant. Sites where proband is 0/0 or ./.
                # cannot be candidates and shouldn't pay the cost of annotation.
                # Typical effect: drops ~50% of post-preprocessing variants.
                emit("filter: proband-carrier")
                joint_pc, dropped_pc = await asyncio.to_thread(
                    proband_carrier_filter, joint, pedigree,
                )
                emit(f"filter: kept={len(joint_pc)} dropped_no_proband_carrier={dropped_pc}")
                joint = joint_pc
                await post_status("running")

                # ── Stage 2: CSQ/INFO-based filter (cheap, in-process) ──
                # Drop variants with AF in CSQ or benign-by-construction
                # consequences. No-op for un-annotated VCFs but free when CSQ
                # IS present (VEP-pre-annotated inputs).
                emit("filter: rare + coding (CSQ-driven if present)")
                joint_filtered, fstats = await asyncio.to_thread(
                    filter_candidates, joint, max_af=0.01, drop_filtered=True,
                )
                emit(
                    f"filter: kept={fstats.kept} "
                    f"dropped_af={fstats.dropped_by_af} "
                    f"dropped_consequence={fstats.dropped_by_consequence} "
                    f"dropped_filter_field={fstats.dropped_by_filter_field}"
                )
                joint = joint_filtered
                await post_status("running")

                # ── Stage 3: live AF filter via myvariant.info ──
                # If the proband filter didn't bring us under the cap, look up
                # gnomAD AF for what remains (batched 200/req, 10-way concurrent)
                # and drop anything with AF ≥ 1% in any cohort. Variants
                # myvariant.info doesn't know are kept (likely rare/novel).
                #
                # Above MAX_AF_LOOKUP_CAP we refuse: ~150k variants at 10-way
                # concurrency still takes ~3min, and above that the user almost
                # certainly needs upstream filtering of their VCFs (the partner
                # lab should have already restricted to coding regions + rare).
                if len(joint) > MAX_AF_LOOKUP_CAP:
                    raise RuntimeError(
                        f"{len(joint)} variants need AF lookup but the cap is "
                        f"{MAX_AF_LOOKUP_CAP}. Pre-filter the upstream VCFs — "
                        f"typical exome should land here at 50-100k after "
                        f"FILTER+proband-carrier passes; over 150k usually means "
                        f"the input includes raw genotypes from non-target "
                        f"regions, low-quality calls, or non-PASS filtered rows. "
                        f"Suggested upstream: `bcftools view -f PASS -i 'TYPE=\"snp\" || TYPE=\"indel\"' input.vcf.gz | "
                        f"bcftools norm -m -any | bcftools view -i 'GT[*]=\"alt\"'`"
                    )
                if len(joint) > MAX_VARIANTS_AFTER_FILTER // 2:
                    # Checkpoint: if a previous run cached the AF lookup
                    # output, skip the lookup entirely. This makes reruns
                    # after a downstream failure ~6 minutes faster.
                    af_map: dict[tuple, float] = {}
                    cached_af = None
                    if cache_urls.get("af_map", {}).get("get"):
                        cached_af = await cache.load_af_map(cache_urls["af_map"]["get"])
                    if cached_af is not None:
                        af_map = cached_af
                        emit(f"myvariant.info: AF cache HIT ({len(af_map)} entries) — skipping lookup")
                    else:
                        emit(
                            f"myvariant.info: AF lookup for {len(joint)} variants "
                            f"(chunks of {AF_LOOKUP_CHUNK_SIZE}, "
                            f"{myvariant.MAX_CONCURRENT}-way concurrent within each chunk)"
                        )
                        chunks = [
                            joint[i:i + AF_LOOKUP_CHUNK_SIZE]
                            for i in range(0, len(joint), AF_LOOKUP_CHUNK_SIZE)
                        ]
                        for idx, chunk in enumerate(chunks, start=1):
                            chunk_start = time.time()
                            chunk_af = await myvariant.fetch_af_for_filtering_async(chunk)
                            af_map.update(chunk_af)
                            emit(
                                f"  myvariant.info chunk {idx}/{len(chunks)}: "
                                f"{len(chunk)} variants, {len(chunk_af)} AFs found "
                                f"({int((time.time() - chunk_start) * 1000)}ms)"
                            )
                            await post_status("running")
                        # Save the cache so a downstream failure doesn't lose this work.
                        if cache_urls.get("af_map", {}).get("put"):
                            saved = await cache.save_af_map(cache_urls["af_map"]["put"], af_map)
                            emit(f"myvariant.info: AF cache {'saved' if saved else 'save FAILED'}")
                    before = len(joint)
                    joint = [jv for jv in joint if af_map.get(jv.key, 0.0) < 0.01]
                    emit(
                        f"myvariant.info: AF lookup done; "
                        f"dropped {before - len(joint)} common variants (kept {len(joint)})"
                    )
                    await post_status("running")

                if len(joint) > MAX_VARIANTS_AFTER_FILTER:
                    raise RuntimeError(
                        f"after all filters, {len(joint)} variants remain (cap: "
                        f"{MAX_VARIANTS_AFTER_FILTER}). The input VCFs may be poorly "
                        f"filtered upstream — consider running bcftools norm + "
                        f"VQSR-passed filter before upload, or relax the cap via "
                        f"MAX_VARIANTS_AFTER_FILTER in container_server.py."
                    )

                # Release the big pre-filter joint matrix now that we've
                # narrowed down. Avoids holding 100k+ JointVariant objects
                # alongside the survivors during the expensive annotation
                # phase. (Python GC doesn't always free large transient
                # data structures promptly without an explicit collect.)
                gc.collect()

                # ── Stage 4: VEP REST for survivors lacking CSQ ──
                # Checkpoint: try the CSQ cache first. If hit, re-attach
                # cached CSQ to surviving JointVariants and skip VEP REST.
                cached_csq = None
                if cache_urls.get("csq", {}).get("get"):
                    cached_csq = await cache.load_csq(cache_urls["csq"]["get"])
                if cached_csq is not None:
                    hits = cache.apply_csq_cache(joint, cached_csq)
                    emit(f"VEP REST: CSQ cache HIT ({hits} variants restored) — skipping lookup")
                else:
                    missing_csq = [jv for jv in joint if not jv.csq]
                    if missing_csq:
                        emit(
                            f"VEP REST: annotating {len(missing_csq)} variants "
                            f"({vep_rest.MAX_CONCURRENT}-way concurrent, "
                            f"{vep_rest.BATCH_SIZE}/batch)"
                        )
                        last_prog = [0]

                        def vep_progress(done: int, total: int) -> None:
                            if done == total or (done - last_prog[0]) >= max(1, total // 10):
                                last_prog[0] = done
                                log.append(f"  VEP REST: {done}/{total} batches done")
                                loop = asyncio.get_event_loop()
                                loop.create_task(post_status("running"))

                        filled = await vep_rest.annotate_batch_async(
                            joint, progress=vep_progress,
                        )
                        emit(f"VEP REST: filled {filled} variants")
                        gc.collect()
                        # Save cache so a downstream failure preserves this work.
                        if cache_urls.get("csq", {}).get("put"):
                            saved = await cache.save_csq(cache_urls["csq"]["put"], joint)
                            emit(f"VEP REST: CSQ cache {'saved' if saved else 'save FAILED'}")
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

            # Checkpoint: try the variants cache. If hit, skip annotate+classify.
            cached_variants = None
            if real_mode and cache_urls.get("variants", {}).get("get"):
                cached_variants = await cache.load_variants(cache_urls["variants"]["get"])
            if cached_variants is not None:
                variants: list[Variant] = cached_variants
                emit(f"annotate+classify: cache HIT ({len(variants)} variants restored)")
            else:
                emit(f"annotating + classifying {len(joint)} variants")
                variants = await asyncio.to_thread(_annotate_classify_all)
                emit("annotation + classification done")
                if real_mode and cache_urls.get("variants", {}).get("put"):
                    saved = await cache.save_variants(cache_urls["variants"]["put"], variants)
                    emit(f"annotate+classify: cache {'saved' if saved else 'save FAILED'}")
            gc.collect()
            await post_status("running")

            # ClinVar + dbNSFP overlay via myvariant.info — concurrent batches
            # with progress emits so the UI sees movement through this stage.
            # Real-mode only (demo path uses curated data).
            if real_mode and variants:
                emit(
                    f"myvariant.info: ClinVar+dbNSFP for {len(variants)} variants "
                    f"({myvariant.MAX_CONCURRENT}-way concurrent, "
                    f"{myvariant.BATCH_SIZE}/batch)"
                )
                last_prog_mv = [0]

                def mv_progress(done: int, total: int) -> None:
                    if done == total or (done - last_prog_mv[0]) >= max(1, total // 10):
                        last_prog_mv[0] = done
                        log.append(f"  myvariant.info: {done}/{total} batches done")
                        loop = asyncio.get_event_loop()
                        loop.create_task(post_status("running"))

                pairs = list(zip(joint, variants))
                filled = await myvariant.annotate_variants_async(
                    pairs, progress=mv_progress,
                )
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
