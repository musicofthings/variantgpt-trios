"""PED file loader and pedigree graph helpers.

PED columns (whitespace-separated, # comments ok):
    family_id  individual_id  paternal_id  maternal_id  sex  phenotype  [role]  [sib_of]

sex: 1=male 2=female 0/other=unknown
phenotype: 1=unaffected 2=affected 0/-9=unknown

The trailing `role` and `sib_of` columns are a VariantGPT-specific, backward-
compatible extension (any hand-authored 6-column PED — e.g. GIAB benchmark
fixtures — still loads fine and falls back to `_infer_role`'s heuristic):

  role     One of the `Role` enum values (proband/father/mother/sibling/
            relative), written verbatim by `_build_ped` from the pedigree
            JSON's own `role` field. When present this is authoritative —
            it replaces re-deriving the role from the individual-id string,
            which cannot distinguish a sibling from any other relative (both
            round-trip as bare ids like "sib-1" with no parents recorded).
  sib_of   The id of the member this row is a full sibling of, when that
            relationship isn't already implied by a shared non-"0" parent
            pair — i.e. exactly the case where neither parent was sequenced
            (a sibling-based duo). "0"/"." means none. Recorded as a
            ("sib") relation alongside the ("parent") relations already
            produced from pid/mid.
"""
from __future__ import annotations

from pathlib import Path

from .models import Affected, Member, Pedigree, Role, Sex

_ROLE_BY_VALUE = {r.value: r for r in Role}


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
        explicit_role = parts[6] if len(parts) >= 7 else None
        sib_of = parts[7] if len(parts) >= 8 else None
        role = _ROLE_BY_VALUE.get(explicit_role or "") or _infer_role(iid, pid, mid)
        m = Member(id=iid, role=role, sex=_sex(sx), affected=_affected(ph), sample_name=iid)
        members.append(m)
        seen[iid] = m
        if pid not in ("0", "."):
            relations.append((pid, iid, "parent"))
        if mid not in ("0", "."):
            relations.append((mid, iid, "parent"))
        if sib_of and sib_of not in ("0", "."):
            relations.append((iid, sib_of, "sib"))

    return Pedigree(members=members, relations=[(a, b, t) for a, b, t in relations])  # type: ignore[arg-type]


def _infer_role(iid: str, pid: str, mid: str) -> Role:
    """Fallback role inference for PED files without an explicit `role`
    column (e.g. hand-authored benchmark fixtures). UI/intake should always
    write the explicit column instead of relying on this — it cannot tell a
    sibling apart from any other relative sharing the same id shape."""
    lower = iid.lower()
    if "proband" in lower or pid not in ("0", ".") or mid not in ("0", "."):
        # Heuristic: someone with declared parents is most likely the proband (or a sib).
        return Role.proband if "proband" in lower or "child" in lower else Role.relative
    if "father" in lower or lower.endswith("_f"):
        return Role.father
    if "mother" in lower or lower.endswith("_m"):
        return Role.mother
    if "sib" in lower:
        return Role.sibling
    return Role.relative
