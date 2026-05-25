"""Engine runner invoked by the Vite dev middleware (vite.devCaseApi.ts).

Reads data/uploads/<caseId>/manifest.json + the per-role uploaded files,
materializes a PED, runs the engine pipeline, and writes case.json under
app/web/public/cases/<caseId>/ so the SPA can fetch it via /cases/<id>/case.json.

Usage:
    python tracks/run_uploaded_case.py <caseId>
"""
from __future__ import annotations

import gzip
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine" / "src"))

from variantgpt_engine.pedigree import load_ped  # noqa: E402
from variantgpt_engine.pipeline import run_case  # noqa: E402

UPLOAD_ROOT = ROOT / "data" / "uploads"
PUBLIC_CASES = ROOT / "app" / "web" / "public" / "cases"


def main(case_id: str) -> int:
    case_dir = UPLOAD_ROOT / case_id
    manifest_path = case_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"missing manifest: {manifest_path}", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    print(f"[run] case={case_id} members={len(manifest['pedigree'])} files={list(manifest['files'].keys())}")

    # Materialize PED.
    ped_path = case_dir / "family.ped"
    ped_path.write_text(_build_ped(case_id, manifest["pedigree"]), encoding="utf-8")

    # Resolve per-role VCFs. Decompress .gz on the fly so the pure-Python
    # parser (or cyvcf2) can read them; bcftools norm would replace this.
    vcf_map: dict[str, Path] = {}
    for role, fname in manifest["files"].items():
        src = case_dir / fname
        if not src.exists():
            print(f"missing uploaded file: {src}", file=sys.stderr)
            return 1
        member = _find_member(manifest["pedigree"], role)
        if not member:
            print(f"no pedigree member for role={role}", file=sys.stderr)
            return 1
        vcf_path = _ensure_uncompressed_vcf(src, case_dir / f"{member['id']}.vcf")
        vcf_map[member["id"]] = vcf_path

    # PRD §4.1: duo / singleton support. A missing member is fine — the engine
    # just won't have their genotypes. We *require* the proband to be present;
    # without their VCF there's nothing to interpret.
    has_proband = any(
        m["role"] == "proband" and not m.get("missing") and m["id"] in vcf_map
        for m in manifest["pedigree"]
    )
    if not has_proband:
        print("[run] error: proband VCF required (PRD §4.1)", file=sys.stderr)
        return 1

    present_count = sum(1 for m in manifest["pedigree"] if not m.get("missing"))
    print(f"[run] members={len(manifest['pedigree'])} present={present_count} vcfs={len(vcf_map)}")
    if len(vcf_map) < present_count:
        print(f"[run] warning: {present_count - len(vcf_map)} expected member(s) without VCF — running as partial pedigree")

    pedigree = load_ped(ped_path)
    hpo_ids = manifest.get("hpo", [])

    # use_demo_annotations: when True, the engine consults tracks/demo_data.py
    # for coord-matched annotations as a fallback. For unknown coords lookup()
    # returns None and the variant is left un-annotated — so this is safe to
    # enable even for real uploads. When VEP / tabix / live gnomAD become
    # available, those take precedence and this fallback becomes a no-op.
    emission = run_case(
        case_id=case_id,
        pedigree=pedigree,
        vcf_paths=vcf_map,
        hpo_ids=hpo_ids,
        build="auto",
        use_demo_annotations=True,
    )

    out_dir = PUBLIC_CASES / case_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "case.json"
    out.write_text(emission.model_dump_json(indent=2), encoding="utf-8")
    print(f"[run] wrote {out}  variants={len(emission.variants)}  proposals={len(emission.proposals)}")
    return 0


def _build_ped(family_id: str, members: list[dict]) -> str:
    """PED columns: family_id  iid  paternal_id  maternal_id  sex  phenotype.

    Members marked `missing` (no VCF provided — PRD §4.1 duo support) are
    still emitted in the PED so the relationship graph is correct; the engine
    just won't have genotypes for them, which downgrades de novo / phasing
    confidence for the proband (handled in inheritance.py).
    """
    sex_map = {"male": "1", "female": "2", "unknown": "0"}
    aff_map = {True: "2", False: "1"}
    father = next((m for m in members if m["role"] == "father"), None)
    mother = next((m for m in members if m["role"] == "mother"), None)
    rows: list[str] = []
    for m in members:
        if m["role"] in ("father", "mother"):
            pid = mid = "0"
        else:
            pid = father["id"] if father else "0"
            mid = mother["id"] if mother else "0"
        rows.append("\t".join([
            family_id, m["id"], pid, mid,
            sex_map.get(m.get("sex", "unknown"), "0"),
            aff_map.get(bool(m.get("affected")), "0"),
        ]))
    return "\n".join(rows) + "\n"


def _find_member(members: list[dict], role: str) -> dict | None:
    for m in members:
        if m["role"] == role or m["id"] == role:
            return m
    return None


def _ensure_uncompressed_vcf(src: Path, dst: Path) -> Path:
    """If src is .gz/.bgz, gunzip into dst; otherwise copy/symlink. The
    pure-Python parser doesn't handle BGZF random access, so we materialize."""
    name = src.name.lower()
    if name.endswith(".gz") or name.endswith(".bgz"):
        with gzip.open(src, "rb") as fh_in, open(dst, "wb") as fh_out:
            shutil.copyfileobj(fh_in, fh_out)
        return dst
    if name.endswith(".bam") or name.endswith(".bai"):
        # BAM isn't a VCF; would need variant calling. For v1 we error out
        # explicitly — calling from BAM is not in scope (PRD non-goals).
        raise SystemExit(
            f"{src.name} is a BAM (read alignments). VariantGPT v1 expects post-calling "
            "VCFs; BAM-to-VCF calling is out of scope (PRD §1 non-goals). Upload a VCF instead."
        )
    if src != dst:
        shutil.copy2(src, dst)
    return dst


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python tracks/run_uploaded_case.py <caseId>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
