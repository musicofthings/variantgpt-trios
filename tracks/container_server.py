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
from typing import Any, Optional

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
from variantgpt_engine.annotation_sources import genomeasia, hpo_genes, indigenomes, mygene, myvariant, vep_rest  # noqa: E402
from variantgpt_engine.annotation_sources.csq import pick_canonical  # noqa: E402
from variantgpt_engine import cache  # noqa: E402
from variantgpt_engine.build_detect import detect_build  # noqa: E402
from variantgpt_engine.filter import filter_candidates, proband_carrier_filter  # noqa: E402
from variantgpt_engine.inheritance import assign_models, compound_het_pass  # noqa: E402
from variantgpt_engine.joint import merge  # noqa: E402
from variantgpt_engine.models import Build, CaseEmission, ClinicalHistory, GeneInfo, HPOTerm, Variant  # noqa: E402
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
    track_urls: dict[str, str] = job.get("track_urls", {})  # signed GET URLs for reference tracks
    indigen_proxy_url: Optional[str] = job.get("indigen_proxy_url")
    indigen_proxy_bearer: Optional[str] = job.get("indigen_proxy_bearer")
    # GenomeAsia AF URL template (see annotation_sources/genomeasia.py).
    # Worker mints this when GENOMEASIA_R2_PREFIX env var is set; when
    # unset, adapter is a silent no-op.
    genomeasia_af_url_template: Optional[str] = job.get("genomeasia_af_url_template")
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

            # IndiGen integration moved to a live API client (clingen.igib.res.in
            # data.php). The bulk VCF has only variant sites with no AF, so we
            # can't pre-build a freq DB. Live lookup happens after annotation
            # (we batch by gene name, which the API supports). See the IndiGen
            # block below the ClinVar overlay.

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
                    # Incremental checkpoint: load whatever was cached from a
                    # prior partial run, then only look up the variants we
                    # don't yet have AFs for. Save the cache after every
                    # chunk so a mid-lookup crash preserves all completed
                    # work.
                    af_map: dict[tuple, float] = {}
                    if cache_urls.get("af_map", {}).get("get"):
                        cached = await cache.load_af_map(cache_urls["af_map"]["get"])
                        if cached:
                            af_map = cached
                            emit(f"myvariant.info: AF cache loaded ({len(af_map)} entries from prior run)")

                    # Variants still needing AF lookup.
                    missing = [jv for jv in joint if jv.key not in af_map]
                    if not missing:
                        emit(f"myvariant.info: AF lookup fully cached ({len(af_map)} entries) — skipping")
                    else:
                        emit(
                            f"myvariant.info: AF lookup for {len(missing)} variants "
                            f"({len(joint) - len(missing)} already cached) "
                            f"(chunks of {AF_LOOKUP_CHUNK_SIZE}, "
                            f"{myvariant.MAX_CONCURRENT}-way concurrent within each chunk)"
                        )
                        chunks = [
                            missing[i:i + AF_LOOKUP_CHUNK_SIZE]
                            for i in range(0, len(missing), AF_LOOKUP_CHUNK_SIZE)
                        ]
                        for idx, chunk in enumerate(chunks, start=1):
                            chunk_start = time.time()
                            chunk_af = await myvariant.fetch_af_for_filtering_async(chunk)
                            af_map.update(chunk_af)
                            elapsed_ms = int((time.time() - chunk_start) * 1000)
                            # Save cache incrementally after every chunk. If the
                            # engine dies on the next chunk, the rerun resumes
                            # from here instead of starting over.
                            saved = True
                            if cache_urls.get("af_map", {}).get("put"):
                                saved = await cache.save_af_map(cache_urls["af_map"]["put"], af_map)
                            emit(
                                f"  myvariant.info chunk {idx}/{len(chunks)}: "
                                f"{len(chunk)} variants, {len(chunk_af)} AFs found "
                                f"({elapsed_ms}ms){'' if saved else ' [cache save FAILED]'}"
                            )
                            await post_status("running")
                            # Reclaim memory between chunks — the httpx client
                            # state and JSON parse buffers can be sizable.
                            gc.collect()
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
                # Incremental checkpoint: load whatever was cached from a prior
                # partial run, restore CSQ onto matching JointVariants, then
                # only call VEP REST for the variants still without CSQ.
                if cache_urls.get("csq", {}).get("get"):
                    cached_csq = await cache.load_csq(cache_urls["csq"]["get"])
                    if cached_csq:
                        hits = cache.apply_csq_cache(joint, cached_csq)
                        emit(f"VEP REST: CSQ cache loaded ({hits} variants from prior run)")

                missing_csq = [jv for jv in joint if not jv.csq]
                if not missing_csq:
                    emit("VEP REST: all variants already have CSQ — skipping lookup")
                else:
                    emit(
                        f"VEP REST: annotating {len(missing_csq)} variants "
                        f"({len(joint) - len(missing_csq)} already cached) "
                        f"({vep_rest.MAX_CONCURRENT}-way concurrent, "
                        f"{vep_rest.BATCH_SIZE}/batch)"
                    )
                    last_prog = [0]

                    def vep_progress(done: int, total: int) -> None:
                        # Lightweight: only log + post_status, no fire-and-forget
                        # cache saves (those were holding refs to `joint` and
                        # adding GC pressure that contributed to downstream OOM).
                        # Cache save happens once at end of stage.
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
                    # Final save in case the throttled saves missed the last batch.
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
                # DO NOT enable per-variant live gnomAD here. _population_af()
                # calls gnomad.lookup() SYNCHRONOUSLY for each variant, which
                # serialized at ~120ms each turns annotate+classify into a
                # 60-second-per-500-variant crawl (network-bound). The same
                # gnomAD AC/AN/AF/SAS data lands on v.populations a few stages
                # later via the batched myvariant.info ClinVar overlay (200
                # vars / round-trip, 10-way concurrent). Setting this to True
                # only duplicates that work and gets overwritten.
                use_gnomad=False,
                gnomad_timeout=5.0,
                use_demo_annotations=not real_mode,
            )

            # Do the entire annotate→classify→priority sweep in a single
            # worker thread per chunk (see chunked loop below).
            # HPO terms — the manifest may carry either bare ids (legacy) or
            # {id, label} objects (post-Intake-clinical-fields). Normalize to
            # a list of (id, label|None) tuples so downstream code is stable.
            # HPO terms — the manifest may carry: bare id strings (legacy),
            # {id, label} objects (post-clinical-fields), or {id, label,
            # definition} objects (post-HPO-descriptions). Normalize to
            # (id, label|None, definition|None) tuples so downstream code is
            # stable regardless of manifest age.
            raw_hpo = manifest.get("hpo", [])
            hpo_entries: list[tuple[str, str | None, str | None]] = []
            for h in raw_hpo:
                if isinstance(h, str):
                    hpo_entries.append((h, None, None))
                elif isinstance(h, dict) and h.get("id"):
                    hpo_entries.append((h["id"], h.get("label"), h.get("definition")))
            hpo_ids = [hid for hid, _, _ in hpo_entries]

            # Checkpoint: load any previously-classified variants from cache,
            # then process the remainder in chunks. Each chunk is 500 variants
            # (~25 MB peak as pydantic objects). After each chunk we update
            # the cache and gc.collect — so a mid-stage OOM at variant 5000
            # of 8454 means a rerun resumes from variant 5000, not 0.
            #
            # Compound-het detection runs at the very end across all
            # variants (it's a global pass; doing it per-chunk would miss
            # trans pairs that span chunks).
            ANNOTATE_CHUNK = 500
            existing_variants: dict[str, Variant] = {}
            if real_mode and cache_urls.get("variants", {}).get("get"):
                cached_variants = await cache.load_variants(cache_urls["variants"]["get"])
                if cached_variants:
                    existing_variants = {v.id: v for v in cached_variants}
                    emit(f"annotate+classify: cache loaded ({len(existing_variants)} variants from prior run)")

            def _vid(jv) -> str:
                return f"{jv.chrom}:{jv.pos}:{jv.ref}:{jv.alt}"

            remaining = [jv for jv in joint if _vid(jv) not in existing_variants]
            variants: list[Variant] = list(existing_variants.values())

            if not remaining:
                emit(f"annotate+classify: all {len(variants)} variants already cached")
            else:
                emit(
                    f"annotate+classify: {len(remaining)} variants to process "
                    f"({len(existing_variants)} already cached, chunks of {ANNOTATE_CHUNK})"
                )

                def _annotate_classify_chunk(sub: list) -> list[Variant]:
                    """Annotate + classify one chunk. compound_het_pass is
                    NOT run here — it's deferred to a global pass after all
                    chunks complete, since it needs cross-chunk gene pairing."""
                    out_chunk: list[Variant] = []
                    for jv in sub:
                        models, conf = assign_models(jv, pedigree)
                        # Pass pedigree so per-member calls + genomic HGVS
                        # land on the Variant for the clinical drawer.
                        v = annotate(jv, ctx, pedigree=pedigree)
                        v.inheritance_models = models
                        v.inheritance_confidence = conf  # type: ignore[assignment]
                        tier, points, ledger = classify(v)
                        v.baseline_tier = tier
                        v.baseline_points = points
                        v.evidence = ledger
                        priority(v, hpo_ids)
                        out_chunk.append(v)
                    return out_chunk

                chunks_an = [remaining[i:i + ANNOTATE_CHUNK]
                             for i in range(0, len(remaining), ANNOTATE_CHUNK)]
                for idx, sub in enumerate(chunks_an, start=1):
                    chunk_start = time.time()
                    sub_variants = await asyncio.to_thread(_annotate_classify_chunk, sub)
                    variants.extend(sub_variants)
                    saved = True
                    if real_mode and cache_urls.get("variants", {}).get("put"):
                        saved = await cache.save_variants(cache_urls["variants"]["put"], variants)
                    elapsed_ms = int((time.time() - chunk_start) * 1000)
                    emit(
                        f"  annotate+classify chunk {idx}/{len(chunks_an)}: "
                        f"+{len(sub_variants)} variants (total {len(variants)}, {elapsed_ms}ms)"
                        f"{'' if saved else ' [cache save FAILED]'}"
                    )
                    await post_status("running")
                    gc.collect()

                # Global compound-het pass across all variants (post-classify
                # update needed for any newly-found compound hets).
                if joint:
                    emit("compound-het: global pass")
                    addl = await asyncio.to_thread(
                        compound_het_pass,
                        [(jv, v.gene) for jv, v in zip(joint, variants)],
                        pedigree,
                    )
                    if addl:
                        for v, jv in zip(variants, joint):
                            if jv.key in addl:
                                v.inheritance_models = list(dict.fromkeys(
                                    v.inheritance_models + addl[jv.key]
                                ))
                        # Re-save the cache to capture comp_het updates.
                        if real_mode and cache_urls.get("variants", {}).get("put"):
                            await cache.save_variants(cache_urls["variants"]["put"], variants)
                    emit(f"compound-het: {sum(len(v) for v in addl.values())} new model assignments")
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

            # IndiGenomes (live API): query data.php by gene name, build a
            # per-case (chrom,pos,ref,alt) → AF map, attach indigenomes
            # PopulationAF rows. This is what the SAS reclassification reads
            # to fire BS1 on Indian-cohort common variants.
            if real_mode and variants:
                last_indi = [0]

                def indi_progress(done: int, total: int) -> None:
                    if done == total or (done - last_indi[0]) >= max(1, total // 10):
                        last_indi[0] = done
                        log.append(f"  IndiGen: {done}/{total} genes queried")
                        loop = asyncio.get_event_loop()
                        loop.create_task(post_status("running"))

                via = "via Worker proxy" if indigen_proxy_url else "DIRECT (Fly IP usually blocked)"
                emit(
                    f"IndiGen: gene-batched API for {len(variants)} variants "
                    f"({via}, cap {indigenomes.MAX_GENES_PER_CASE} genes by priority, "
                    f"{indigenomes.MAX_CONCURRENT}-way concurrent, "
                    f"{int(indigenomes.PER_BATCH_TIMEOUT)}s per-query timeout)"
                )
                try:
                    indi_map = await indigenomes.fetch_for_variants_async(
                        variants, progress=indi_progress,
                        proxy_url=indigen_proxy_url,
                        proxy_bearer=indigen_proxy_bearer,
                    )
                    indi_hits, snv_n, indel_n = indigenomes.apply_indigen_to_variants(variants, indi_map)
                    emit(
                        f"IndiGen: {indi_hits} variants annotated "
                        f"from {len(indi_map)} unique IndiGen records "
                        f"(SNVs attempted: {snv_n}, indels attempted: {indel_n})"
                    )
                    # Echo the first few API responses to the engine log so we
                    # can see whether IGIB is returning data, empty, or errors.
                    last_dbg = getattr(indigenomes.fetch_for_variants_async, "last_debug", None)
                    if last_dbg:
                        for line in last_dbg[:5]:
                            emit(f"  IndiGen debug: {line}")
                except Exception as e:  # noqa: BLE001
                    emit(f"IndiGen: lookup failed (continuing without): {type(e).__name__}: {e}")
                await post_status("running")

            # GenomeAsia 100K AF — only fires when the Worker injected a
            # signed-URL template into the job payload (which it does
            # only when GENOMEASIA_R2_PREFIX env var is set on the
            # Worker). Otherwise the adapter no-ops silently — same
            # pattern as IndiGen pre-proxy.
            if real_mode and variants and genomeasia_af_url_template:
                emit("GenomeAsia: looking up allele frequencies from R2 tracks")
                try:
                    ga_hits = await genomeasia.fetch_for_variants(
                        variants,
                        af_url_template=genomeasia_af_url_template,
                    )
                    emit(f"GenomeAsia: {ga_hits} variants annotated")
                except Exception as e:  # noqa: BLE001
                    emit(f"GenomeAsia: lookup failed (continuing without): {type(e).__name__}: {e}")
                await post_status("running")

            # HPO phenotype matching — for each variant, see if its gene is
            # associated with any of the case's HPO terms in the HPO consortium
            # gene-phenotype catalog. Boosts priority_score for matching
            # variants so they sort to the top in the workbench's default view.
            if real_mode and variants and hpo_ids:
                emit(f"HPO: ensuring genes_to_phenotype catalog is loaded ({len(hpo_ids)} case HPO terms)")
                hpo_ok = await hpo_genes.ensure_loaded()
                if hpo_ok:
                    hpo_hits = 0
                    for v in variants:
                        m = hpo_genes.match_gene(v.gene, hpo_ids)
                        if m:
                            v.hpo_matches = m
                            # Boost priority — each match adds 0.1, capped at +0.5 so
                            # ACMG tier + reclass still dominate the overall score.
                            v.priority_score = (v.priority_score or 0) + min(0.5, 0.1 * len(m))
                            hpo_hits += 1
                    emit(f"HPO: {hpo_hits} variants matched at least one case phenotype")
                else:
                    emit("HPO: catalog unavailable — skipping phenotype matching")
                await post_status("running")

            # Gene-level lookup via mygene.info — OMIM gene id + NCBI Entrez
            # gene summary + full name + type-of-gene. Single batched call;
            # results populate v.omim_id per variant AND a CaseEmission.gene_info
            # dict so the report can render gene-function prose.
            gene_info_map: dict[str, GeneInfo] = {}
            if real_mode and variants:
                unique_genes = {v.gene for v in variants if v.gene}
                if unique_genes:
                    emit(f"mygene.info: gene metadata lookup for {len(unique_genes)} unique genes")
                    try:
                        gene_info_map = await mygene.fetch_gene_info_for_symbols(unique_genes)
                        # Backfill omim_id on each variant from gene_info_map.
                        applied = 0
                        for v in variants:
                            if v.omim_id or not v.gene:
                                continue
                            gi = gene_info_map.get(v.gene)
                            if gi and gi.omim_id:
                                v.omim_id = gi.omim_id
                                applied += 1
                        summarized = sum(1 for gi in gene_info_map.values() if gi.summary)
                        emit(f"mygene.info: resolved {len(gene_info_map)} genes ({summarized} with Entrez summary); set omim_id on {applied} variants")
                    except Exception as e:  # noqa: BLE001
                        emit(f"mygene.info: lookup failed (continuing without): {type(e).__name__}: {e}")
                    await post_status("running")

            emit("reclassifying (Indian-cohort baseline)")
            proposals = await asyncio.to_thread(
                reclassify_all, variants, snapshot_versions=track_versions
            )

            # Clinical history block — passed verbatim from Intake. All
            # fields optional; we still emit the object so the SPA's report
            # layout stays stable.
            ch_raw = manifest.get("clinical_history") or {}
            clinical_history = ClinicalHistory(
                text=ch_raw.get("text") or manifest.get("history", "") or "",
                onset_age=ch_raw.get("onset_age") or None,
                consanguinity_note=ch_raw.get("consanguinity_note") or None,
                prior_testing=ch_raw.get("prior_testing") or None,
                family_history=ch_raw.get("family_history") or None,
            )

            emission = CaseEmission(
                case_id=case_id,
                build=resolved_build,
                pedigree=pedigree,
                hpo=[
                    HPOTerm(hpo_id=hid, label=lbl, definition=defn)
                    for hid, lbl, defn in hpo_entries
                ],
                clinical_history=clinical_history,
                qc=qc,
                gene_info=gene_info_map,
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
