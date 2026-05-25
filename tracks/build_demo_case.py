"""Run the engine end-to-end on the demo trio → emit case.json for the SPA.

Pre-req: run `python tracks/build_demo_vcfs.py` first to produce the trio.

Writes:
    app/web/public/demo/case.json   (consumed by the SPA via fetch('/demo/case.json'))
    data/test/demo_trio/case.json   (canonical engine output)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine" / "src"))

from variantgpt_engine.pedigree import load_ped  # noqa: E402
from variantgpt_engine.pipeline import run_case  # noqa: E402

TRIO = ROOT / "data" / "test" / "demo_trio"
WEB_PUBLIC = ROOT / "app" / "web" / "public" / "demo"


def main() -> None:
    ped_path = TRIO / "family.ped"
    if not ped_path.exists():
        print("missing demo VCFs — run: python tracks/build_demo_vcfs.py", file=sys.stderr)
        sys.exit(1)

    pedigree = load_ped(ped_path)

    # Map roles → VCF paths. The PED's iid identifies the sample; we name the
    # VCF files by role so the wiring is obvious.
    vcf_map = {
        m.id: TRIO / f"{m.role.value}.vcf"
        for m in pedigree.members
    }
    for p in vcf_map.values():
        if not p.exists():
            print(f"missing {p}", file=sys.stderr)
            sys.exit(1)

    # HPO terms relevant to the demo (matches the suggested ones in Intake.tsx).
    hpo = [
        "HP:0001903",  # Anemia (HBB)
        "HP:0002240",  # Hepatomegaly
        "HP:0002910",  # Elevated hepatic transaminases
        "HP:0003124",  # Hypercholesterolemia (placeholder)
    ]

    emission = run_case(
        case_id="demo-trio-001",
        pedigree=pedigree,
        vcf_paths=vcf_map,
        hpo_ids=hpo,
        build="GRCh38",
        use_demo_annotations=True,
    )

    out_engine = TRIO / "case.json"
    out_engine.write_text(emission.model_dump_json(indent=2), encoding="utf-8")

    WEB_PUBLIC.mkdir(parents=True, exist_ok=True)
    (WEB_PUBLIC / "case.json").write_text(emission.model_dump_json(indent=2), encoding="utf-8")

    # Stats summary
    data = json.loads((WEB_PUBLIC / "case.json").read_text(encoding="utf-8"))
    tier_counts: dict[str, int] = {}
    for v in data["variants"]:
        tier_counts[v.get("baseline_tier") or "—"] = tier_counts.get(v.get("baseline_tier") or "—", 0) + 1
    print(f"wrote {out_engine}")
    print(f"wrote {WEB_PUBLIC / 'case.json'}")
    print(f"  variants={len(data['variants'])}  proposals={len(data['proposals'])}")
    print(f"  tiers={tier_counts}")


if __name__ == "__main__":
    main()
