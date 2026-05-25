"""Tabix-track adapter for IndiGenomes / GenomeAsia / GenomeIndia (PRD §6.8).

Track file layout (produced by `tracks/ingest_*.py`):
    chrom  pos  ref  alt  ac  an  af  n_hom  n_het
bgzipped + tabix-indexed: `tabix -s1 -b2 -e2`.

The adapter supports both local files and HTTP(S) URLs — pysam handles range
reads transparently when given an http URL whose `.tbi` sibling exists. The
Worker accesses the same tracks via tabix-over-HTTP from R2.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from ..models import PopulationAF

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TrackConfig:
    source: str          # "indigenomes" | "genomeasia" | "genomeindia"
    path: str            # local path or https URL
    version: str = ""


def lookup(
    chrom: str, pos: int, ref: str, alt: str, track: TrackConfig,
) -> Optional[PopulationAF]:
    """Range-read a tabix track for a single variant. Returns None on miss/failure."""
    try:
        import pysam  # type: ignore[import-not-found]
    except ImportError:
        log.debug("pysam unavailable; tabix track lookup skipped")
        return None

    chrom_q = chrom if chrom.startswith("chr") else f"chr{chrom}"
    try:
        with pysam.TabixFile(track.path) as tf:  # type: ignore[attr-defined]
            # Try both with and without `chr` prefix — track conventions vary.
            for q in (chrom_q, chrom_q.removeprefix("chr")):
                try:
                    rows = list(tf.fetch(q, pos - 1, pos))
                except (ValueError, OSError):
                    continue
                for row in rows:
                    parts = row.split("\t")
                    if len(parts) < 7:
                        continue
                    _c, p, r, a, ac, an, af, *rest = parts
                    if int(p) == pos and r == ref and a == alt:
                        n_hom = int(rest[0]) if rest else None
                        n_het = int(rest[1]) if len(rest) > 1 else None
                        return PopulationAF(
                            source=track.source,
                            ac=int(ac) if ac and ac != "." else None,
                            an=int(an) if an and an != "." else None,
                            af=float(af) if af and af != "." else None,
                            n_hom=n_hom,
                            n_het=n_het,
                        )
    except (OSError, ValueError) as exc:
        log.warning("tabix lookup failed for %s @ %s:%d: %s", track.source, chrom, pos, exc)
    return None


def lookup_all(
    chrom: str, pos: int, ref: str, alt: str, tracks: list[TrackConfig],
) -> list[PopulationAF]:
    out: list[PopulationAF] = []
    for t in tracks:
        row = lookup(chrom, pos, ref, alt, t)
        if row is not None:
            out.append(row)
    return out
