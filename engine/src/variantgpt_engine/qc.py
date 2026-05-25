"""QC checks (PRD §4.3).

Per-sample call rate, mean depth, Ti/Tv, Mendelian error rate, sex check,
relatedness/kinship (KING-robust style), contamination heuristic from het
allele balance.

Detailed implementations land alongside the joint matrix; this module
exposes the stable shape consumed by the pipeline.
"""
from __future__ import annotations

from typing import Iterable

from .joint import JointVariant
from .models import Affected, Pedigree, QCMetrics, Sex


def compute_qc(joint: Iterable[JointVariant], pedigree: Pedigree) -> QCMetrics:
    metrics = QCMetrics()
    members = {m.id: m for m in pedigree.members}
    total = 0
    called: dict[str, int] = {m: 0 for m in members}
    depth_sum: dict[str, int] = {m: 0 for m in members}
    depth_n: dict[str, int] = {m: 0 for m in members}
    mendel_violations = 0
    mendel_examined = 0

    parent_pairs = _parent_pairs(pedigree)

    for v in joint:
        total += 1
        for mid in members:
            if v.genotypes.get(mid) is not None:
                called[mid] += 1
            d = v.depths.get(mid)
            if d is not None:
                depth_sum[mid] += d
                depth_n[mid] += 1
        for child, (fa, mo) in parent_pairs.items():
            cgt = v.genotypes.get(child)
            fgt = v.genotypes.get(fa)
            mgt = v.genotypes.get(mo)
            if None in (cgt, fgt, mgt):
                continue
            mendel_examined += 1
            if not _mendelian_ok(cgt, fgt, mgt):
                mendel_violations += 1

    if total:
        metrics.per_sample_call_rate = {m: called[m] / total for m in members}
    metrics.mean_depth = {
        m: (depth_sum[m] / depth_n[m]) if depth_n[m] else 0.0 for m in members
    }
    metrics.mendelian_error_rate = (
        mendel_violations / mendel_examined if mendel_examined else None
    )
    # sex_check, kinship, contamination: implementations land with track wiring.
    metrics.sex_check = {m.id: m.sex for m in pedigree.members}
    metrics.contamination_flag = {m.id: False for m in pedigree.members}
    return metrics


def _parent_pairs(pedigree: Pedigree) -> dict[str, tuple[str, str]]:
    parents: dict[str, list[str]] = {}
    for parent_id, child_id, kind in pedigree.relations:
        if kind != "parent":
            continue
        parents.setdefault(child_id, []).append(parent_id)
    return {c: (p[0], p[1]) for c, p in parents.items() if len(p) == 2}


def _mendelian_ok(child: int, father: int, mother: int) -> bool:
    """Genotypes are alt-allele counts 0/1/2."""
    valid_child_alleles = []
    for parent in (father, mother):
        if parent == 0:
            valid_child_alleles.append({0})
        elif parent == 1:
            valid_child_alleles.append({0, 1})
        else:
            valid_child_alleles.append({1})
    for a in valid_child_alleles[0]:
        for b in valid_child_alleles[1]:
            if a + b == child:
                return True
    return False
