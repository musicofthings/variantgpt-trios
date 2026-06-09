"""Parse AnnotSV output into StructuralVariant models (PRD §4.x — SV pipeline).

AnnotSV is the field-standard SV annotator: it overlays gene overlap, ClinGen
dosage (HI/TS), gnomAD pLI, and benign-SV population frequency onto each SV. Its
TSV emits, per SV, one "full" line (whole-SV annotations + gene_count) plus one
"split" line per overlapping gene (per-gene HI/TS/pLI). We group by AnnotSV_ID,
take SV coordinates + population frequency from the full line, and build the
per-gene DosageRegion list from the split lines.

Column names drift across AnnotSV versions, so every field is looked up with
fallbacks and missing values degrade gracefully — matching the engine's
"deterministic result always renders" contract.
"""
from __future__ import annotations

import csv
import logging
import re
from pathlib import Path
from typing import Iterable, Optional

from ..models import ClinVarRecord, DosageRegion, PopulationAF, StructuralVariant

# AnnotSV review-status → ClinVar star rating (mirrors the SNV ClinVar adapter).
_REVIEW_STARS = {
    "practice guideline": 4,
    "reviewed by expert panel": 3,
    "criteria provided, multiple submitters, no conflicts": 2,
    "criteria provided, single submitter": 1,
}

log = logging.getLogger(__name__)

_SV_TYPE_MAP = {"DEL": "DEL", "DUP": "DUP", "INV": "INV", "INS": "INS", "BND": "BND", "CNV": "CNV"}


def _get(row: dict[str, str], *names: str) -> Optional[str]:
    for n in names:
        v = row.get(n)
        if v not in (None, "", "."):
            return v
    return None


def _int(s: Optional[str]) -> Optional[int]:
    if s is None:
        return None
    m = re.search(r"-?\d+", s)
    return int(m.group()) if m else None


def _float(s: Optional[str]) -> Optional[float]:
    if s is None:
        return None
    m = re.search(r"-?\d+(\.\d+)?([eE]-?\d+)?", s)
    try:
        return float(m.group()) if m else None
    except ValueError:
        return None


def _norm_type(s: Optional[str]) -> str:
    if not s:
        return "CNV"
    u = s.upper()
    for key, val in _SV_TYPE_MAP.items():
        if key in u:
            return val
    # AnnotSV sometimes encodes loss/gain or copy number.
    if "LOSS" in u or "<DEL>" in u:
        return "DEL"
    if "GAIN" in u or "<DUP>" in u:
        return "DUP"
    return "CNV"


def parse_rows(rows: Iterable[dict[str, str]]) -> list[StructuralVariant]:
    """Build StructuralVariants from AnnotSV TSV rows (already dict-parsed)."""
    groups: dict[str, list[dict[str, str]]] = {}
    order: list[str] = []
    for row in rows:
        sid = _get(row, "AnnotSV_ID", "AnnotSV ID", "ID") or \
            f"{_get(row, 'SV_chrom', 'SV chrom')}:{_get(row, 'SV_start', 'SV start')}"
        if sid not in groups:
            groups[sid] = []
            order.append(sid)
        groups[sid].append(row)

    out: list[StructuralVariant] = []
    for sid in order:
        sv = _build(sid, groups[sid])
        if sv is not None:
            out.append(sv)
    return out


def _build(sid: str, rows: list[dict[str, str]]) -> Optional[StructuralVariant]:
    def mode(r: dict[str, str]) -> str:
        return (_get(r, "Annotation_mode", "AnnotSV type") or "").lower()

    full = next((r for r in rows if mode(r) == "full"), rows[0])
    splits = [r for r in rows if mode(r) == "split"] or [r for r in rows if r is not full]

    chrom = _get(full, "SV_chrom", "SV chrom")
    start = _int(_get(full, "SV_start", "SV start"))
    end = _int(_get(full, "SV_end", "SV end"))
    if chrom is None or start is None or end is None:
        log.warning("AnnotSV row %s missing coordinates; skipped", sid)
        return None

    sv_type = _norm_type(_get(full, "SV_type", "SV type"))
    length = _int(_get(full, "SV_length", "SV length")) or (end - start)
    copy_number = _int(_get(full, "CN", "Copy_number"))

    genes: list[str] = []
    overlaps: list[DosageRegion] = []
    seen: set[str] = set()
    for r in splits:
        gene = _get(r, "Gene_name", "Gene name")
        if not gene or gene in seen:
            continue
        seen.add(gene)
        genes.append(gene)
        cds_pct = _float(_get(r, "Overlapped_CDS_percent", "Overlapped CDS percent"))
        overlap = "full" if (cds_pct is not None and cds_pct >= 100.0) else "partial"
        overlaps.append(DosageRegion(
            name=gene, kind="gene",
            hi_score=_int(_get(r, "HI", "ClinGen_HI", "DDD_HI_percent")),
            ts_score=_int(_get(r, "TS", "ClinGen_TS")),
            pli=_float(_get(r, "GnomAD_pLI", "gnomAD_pLI", "pLI")),
            overlap=overlap,
        ))

    populations: list[PopulationAF] = []
    af = _float(_get(full, "B_loss_AFmax", "B_gain_AFmax", "GD_AF", "gnomAD_AF"))
    if af is not None:
        populations.append(PopulationAF(source="gnomad_sv", af=af))

    clinvar = _clinvar(full)

    return StructuralVariant(
        id=sid, chrom=chrom, start=start, end=end, sv_type=sv_type,  # type: ignore[arg-type]
        length=length, copy_number=copy_number,
        genes=genes, dosage_overlaps=overlaps, populations=populations,
        clinvar=clinvar, caller="annotsv",
    )


def _clinvar(full: dict[str, str]) -> Optional[ClinVarRecord]:
    """Extract a ClinVar SV/CNV overlay when AnnotSV (or a custom column) carried
    one. AnnotSV exposes ClinVar SV overlaps via columns that vary by version /
    config; we read a clinical-significance string and (optional) review status."""
    sig = _get(full, "ClinVar_clinsig", "CLNSIG", "ClinVar_significance", "po_P_loss_source")
    if not sig:
        return None
    status = _get(full, "ClinVar_review_status", "CLNREVSTAT", "ClinVar_reviewStatus")
    stars = _REVIEW_STARS.get((status or "").lower().strip()) if status else None
    vid = _get(full, "ClinVar_variation_id", "CLNVID", "ClinVar_id")
    return ClinVarRecord(
        clinical_significance=sig, review_status=status, review_stars=stars,
        variation_id=vid,
    )


def parse_tsv(path: Path) -> list[StructuralVariant]:
    """Parse an AnnotSV .tsv file into StructuralVariants."""
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        return parse_rows(reader)
