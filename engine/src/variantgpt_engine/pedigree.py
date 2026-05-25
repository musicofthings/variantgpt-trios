"""PED file loader and pedigree graph helpers.

PED columns (whitespace-separated, # comments ok):
    family_id  individual_id  paternal_id  maternal_id  sex  phenotype

sex: 1=male 2=female 0/other=unknown
phenotype: 1=unaffected 2=affected 0/-9=unknown
"""
from __future__ import annotations

from pathlib import Path

from .models import Affected, Member, Pedigree, Role, Sex


def _sex(code: str) -> Sex:
    return {"1": Sex.male, "2": Sex.female}.get(code, Sex.unknown)


def _affected(code: str) -> Affected:
    return {"1": Affected.unaffected, "2": Affected.affected}.get(code, Affected.unknown)


def load_ped(path: Path) -> Pedigree:
    members: list[Member] = []
    relations: list[tuple[str, str, str]] = []
    seen: dict[str, Member] = {}

    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        _fam, iid, pid, mid, sx, ph = parts[:6]
        role = _infer_role(iid, pid, mid)
        m = Member(id=iid, role=role, sex=_sex(sx), affected=_affected(ph), sample_name=iid)
        members.append(m)
        seen[iid] = m
        if pid not in ("0", "."):
            relations.append((pid, iid, "parent"))
        if mid not in ("0", "."):
            relations.append((mid, iid, "parent"))

    return Pedigree(members=members, relations=[(a, b, t) for a, b, t in relations])  # type: ignore[arg-type]


def _infer_role(iid: str, pid: str, mid: str) -> Role:
    """Cheap role inference; UI/intake should set roles explicitly when possible."""
    lower = iid.lower()
    if "proband" in lower or pid not in ("0", ".") or mid not in ("0", "."):
        # Heuristic: someone with declared parents is most likely the proband (or a sib).
        return Role.proband if "proband" in lower or "child" in lower else Role.relative
    if "father" in lower or lower.endswith("_f"):
        return Role.father
    if "mother" in lower or lower.endswith("_m"):
        return Role.mother
    return Role.relative
