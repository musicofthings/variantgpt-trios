from __future__ import annotations

from pathlib import Path

from variantgpt_engine.pedigree import load_ped


def test_load_trio_ped(tmp_path: Path) -> None:
    ped = tmp_path / "trio.ped"
    ped.write_text(
        "# fam id pat mat sex aff\n"
        "FAM1 proband father mother 1 2\n"
        "FAM1 father  0      0      1 1\n"
        "FAM1 mother  0      0      2 1\n"
    )
    pedigree = load_ped(ped)
    ids = [m.id for m in pedigree.members]
    assert ids == ["proband", "father", "mother"]
    assert any(r[1] == "proband" and r[2] == "parent" for r in pedigree.relations)
