from __future__ import annotations

from pathlib import Path

from variantgpt_engine.models import Role
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


def test_load_sibling_duo_ped_explicit_role(tmp_path: Path) -> None:
    """Sibling-based duo (proband + one sibling, no parent sequenced) written
    the way `tracks/run_uploaded_case.py::_build_ped` now emits it: role and
    sib_of as trailing columns 7/8. Without the explicit role column, `sib-1`
    would silently round-trip as Role.relative (heuristic can't tell a
    sibling apart from any other relative once no parent id is recorded)."""
    ped = tmp_path / "sib_duo.ped"
    ped.write_text(
        "FAM1 proband 0 0 1 2 proband 0\n"
        "FAM1 sib-1   0 0 2 1 sibling proband\n"
    )
    pedigree = load_ped(ped)
    by_id = {m.id: m for m in pedigree.members}
    assert by_id["proband"].role == Role.proband
    assert by_id["sib-1"].role == Role.sibling
    assert ("sib-1", "proband", "sib") in pedigree.relations


def test_load_ped_without_role_column_falls_back_to_heuristic(tmp_path: Path) -> None:
    """A hand-authored 6-column PED (e.g. GIAB benchmark fixtures) has no
    role/sib_of columns at all — must still load via `_infer_role`."""
    ped = tmp_path / "legacy.ped"
    ped.write_text(
        "FAM1 proband father mother 1 2\n"
        "FAM1 father  0      0      1 1\n"
        "FAM1 mother  0      0      2 1\n"
    )
    pedigree = load_ped(ped)
    by_id = {m.id: m for m in pedigree.members}
    assert by_id["proband"].role == Role.proband
    assert by_id["father"].role == Role.father
    assert by_id["mother"].role == Role.mother
