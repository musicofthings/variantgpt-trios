"""ClinVar amino-acid index — the data layer ACMG PS1 and PM5 both need.

PS1 ("same amino-acid change as an established P/LP variant, different
nucleotide change") and PM5 ("novel missense at a residue where a *different*
missense change is established P/LP") can't be decided from a single variant in
isolation: they require knowing every *other* P/LP missense ClinVar has recorded
in the same gene, indexed by residue.

This module builds that index. For the case's gene set it enumerates ClinVar
P/LP missense variants (via myvariant.info's query API, which already aggregates
ClinVar + dbNSFP's per-residue amino-acid coordinates) and indexes them by
(gene, codon). The ACMG context pass (acmg/context.py) then asks the index two
questions per query variant:

  - same_change(gene, change)            → PS1 anchor (same resulting aa)
  - other_change_at_residue(gene, change) → PM5 anchor (different aa, same pos)

The network layer is deliberately thin and defensive — a query failure or an
unparseable record degrades to an empty index (PS1/PM5 stay not-fired), never
an exception. All decision logic lives in pure, unit-tested functions:
parse_protein_change, build_index, and the ClinVarAAIndex lookups.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from typing import Iterable, Optional

import httpx

log = logging.getLogger(__name__)

MYVARIANT_QUERY_URL = "https://myvariant.info/v1/query"
# Bound the work: enumerating ClinVar for every gene in a huge candidate set
# would be wasteful. The caller priority-sorts genes (phenotype-relevant /
# pathogenic first); we cap here as a safety valve.
MAX_GENES = 400
PER_GENE_PAGE_SIZE = 1000          # myvariant fetch_all page size
MAX_RECORDS_PER_GENE = 5000        # stop paging a pathological gene
MAX_CONCURRENT = 8
PER_REQUEST_TIMEOUT = 30.0

# Server-side narrowing: only ClinVar-classified rows that carry a dbNSFP
# amino-acid position (i.e. missense). We still filter P/LP + review stars
# client-side so the gate matches the rest of the engine (acmg/context.py).
_QUERY_FIELDS = ",".join([
    "_id",
    "dbnsfp.genename",
    "dbnsfp.aaref",
    "dbnsfp.aaalt",
    "dbnsfp.aapos",
    "clinvar.gene.symbol",
    "clinvar.rcv.clinical_significance",
    "clinvar.rcv.review_status",
])

# Three-letter → one-letter amino-acid codes (incl. Ter/stop).
_THREE_TO_ONE = {
    "Ala": "A", "Arg": "R", "Asn": "N", "Asp": "D", "Cys": "C",
    "Gln": "Q", "Glu": "E", "Gly": "G", "His": "H", "Ile": "I",
    "Leu": "L", "Lys": "K", "Met": "M", "Phe": "F", "Pro": "P",
    "Ser": "S", "Thr": "T", "Trp": "W", "Tyr": "Y", "Val": "V",
    "Ter": "*", "Sec": "U", "Pyl": "O",
}
_ONE_LETTER = set(_THREE_TO_ONE.values())

# p.His831Tyr / p.(His831Tyr) / p.H831Y — a single-residue substitution.
_THREE_RE = re.compile(
    r"^p\.\(?([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})\)?$"
)
_ONE_RE = re.compile(
    r"^p\.\(?([A-Z*])(\d+)([A-Z*])\)?$"
)

# Same review-status → star map as myvariant.py; duplicated here to keep this
# module free of a dependency on the per-variant projector.
_REVIEW_STAR_MAP = {
    "practice guideline": 4,
    "reviewed by expert panel": 3,
    "criteria provided, multiple submitters, no conflicts": 2,
    "criteria provided, conflicting classifications": 1,
    "criteria provided, conflicting interpretations": 1,
    "criteria provided, single submitter": 1,
    "no assertion criteria provided": 0,
    "no classification provided": 0,
    "no interpretation for the single variant": 0,
}


@dataclass(frozen=True)
class AAChange:
    """A single-residue protein substitution in one-letter codes."""
    ref: str          # one-letter (may be "" if the source omitted the ref aa)
    pos: int
    alt: str          # one-letter ("*" = Ter/stop)


@dataclass(frozen=True)
class EstablishedAA:
    """An established P/LP missense pulled from ClinVar, keyed by residue."""
    gene: str
    change: AAChange
    significance: str
    stars: int
    source_id: Optional[str] = None    # genomic _id, used to skip self-matches


def parse_protein_change(hgvs_p: Optional[str]) -> Optional[AAChange]:
    """Parse an HGVS protein string into a single-residue AAChange.

    Accepts three-letter (p.His831Tyr), parenthesised (p.(His831Tyr)), and
    one-letter (p.H831Y) substitutions. Returns None for anything that isn't a
    clean missense substitution — synonymous (p.(=)), frameshift (fs), in-frame
    indels (del/ins/dup), extensions, and nonsense (p.Arg97Ter is a stop, not a
    missense substitution we want to anchor PS1/PM5 on)."""
    if not hgvs_p:
        return None
    s = hgvs_p.strip()
    if not s.startswith("p."):
        s = "p." + s
    # Reject obvious non-substitutions fast.
    lowered = s.lower()
    if any(tok in lowered for tok in ("fs", "del", "ins", "dup", "ext", "=", "?")):
        return None

    m = _THREE_RE.match(s)
    if m:
        ref3, pos, alt3 = m.group(1), int(m.group(2)), m.group(3)
        ref = _THREE_TO_ONE.get(ref3)
        alt = _THREE_TO_ONE.get(alt3)
        if not ref or not alt:
            return None
        if alt == "*":           # nonsense, not a missense substitution
            return None
        return AAChange(ref=ref, pos=pos, alt=alt)

    m = _ONE_RE.match(s)
    if m:
        ref, pos, alt = m.group(1), int(m.group(2)), m.group(3)
        if ref not in _ONE_LETTER or alt not in _ONE_LETTER:
            return None
        if alt == "*":
            return None
        return AAChange(ref=ref, pos=int(pos), alt=alt)

    return None


def _stars(review_status: Optional[str]) -> int:
    if not review_status:
        return 0
    return _REVIEW_STAR_MAP.get(review_status.lower(), 0)


def classification_is_plp(significance: Optional[str]) -> bool:
    """True for a Pathogenic / Likely-pathogenic classification with no benign
    or conflicting qualifier. Mirrors acmg/context._is_clinvar_pathogenic so
    PS1/PM5 anchors are gated exactly like PM3's trans partner."""
    if not significance:
        return False
    sig = significance.lower()
    if "benign" in sig or "conflicting" in sig:
        return False
    return "pathogenic" in sig


class ClinVarAAIndex:
    """Residue-indexed established P/LP missense, queried by the ACMG pass."""

    def __init__(self) -> None:
        # (GENE_UPPER, codon) -> list of established P/LP changes at that residue
        self._by_residue: dict[tuple[str, int], list[EstablishedAA]] = {}

    def __len__(self) -> int:
        return sum(len(v) for v in self._by_residue.values())

    @property
    def gene_count(self) -> int:
        return len({g for (g, _pos) in self._by_residue})

    def add(self, e: EstablishedAA) -> None:
        key = (e.gene.upper(), e.change.pos)
        self._by_residue.setdefault(key, []).append(e)

    def same_change(
        self, gene: str, change: AAChange, *, exclude_id: Optional[str] = None
    ) -> Optional[EstablishedAA]:
        """PS1 anchor: an established P/LP with the *same* resulting amino acid
        at the same residue, originating from a *different* genomic variant
        (exclude_id guards against the query variant matching itself)."""
        for e in self._by_residue.get((gene.upper(), change.pos), []):
            if e.change.alt != change.alt:
                continue
            if exclude_id is not None and e.source_id == exclude_id:
                continue
            return e
        return None

    def other_change_at_residue(
        self, gene: str, change: AAChange, *, exclude_id: Optional[str] = None
    ) -> Optional[EstablishedAA]:
        """PM5 anchor: an established P/LP missense at the same residue but a
        *different* resulting amino acid than the query change."""
        for e in self._by_residue.get((gene.upper(), change.pos), []):
            if e.change.alt == change.alt:
                continue
            if exclude_id is not None and e.source_id == exclude_id:
                continue
            return e
        return None


@dataclass
class _RawRecord:
    """Normalised view of one myvariant ClinVar/dbNSFP hit, pre-filtering."""
    gene: str
    aaref: str
    aaalt: str
    aapos: int
    significance: str
    review_status: str
    source_id: Optional[str] = None
    extra_changes: list[AAChange] = field(default_factory=list)


def build_index(records: Iterable[_RawRecord], *, min_stars: int = 1) -> ClinVarAAIndex:
    """Build a ClinVarAAIndex from normalised records, keeping only P/LP rows
    with >= min_stars review confidence and a parseable single-residue change."""
    idx = ClinVarAAIndex()
    for r in records:
        if not classification_is_plp(r.significance):
            continue
        if _stars(r.review_status) < min_stars:
            continue
        if not r.gene or r.aapos <= 0:
            continue
        ref = _THREE_TO_ONE.get(r.aaref, r.aaref) if r.aaref else ""
        alt = _THREE_TO_ONE.get(r.aaalt, r.aaalt) if r.aaalt else ""
        if alt and alt in _ONE_LETTER and alt != "*":
            idx.add(EstablishedAA(
                gene=r.gene,
                change=AAChange(ref=ref if ref in _ONE_LETTER else "", pos=r.aapos, alt=alt),
                significance=r.significance,
                stars=_stars(r.review_status),
                source_id=r.source_id,
            ))
    return idx


# ────────────────────────── network layer ──────────────────────────

def _first(v):
    """dbNSFP fields are frequently per-transcript lists; take the first
    non-empty scalar."""
    if isinstance(v, list):
        for x in v:
            if x not in (None, ""):
                return x
        return None
    return v


def _sig_and_review(clinvar: dict) -> tuple[str, str]:
    """Pull the most-confident significance + review status from a clinvar hit.
    rcv may be a dict or a list of submissions."""
    rcv = clinvar.get("rcv")
    rcvs = [rcv] if isinstance(rcv, dict) else (rcv if isinstance(rcv, list) else [])
    best_sig, best_review, best_stars = "", "", -1
    for r in rcvs:
        if not isinstance(r, dict):
            continue
        sig = r.get("clinical_significance")
        review = r.get("review_status")
        sig = _first(sig) or ""
        review = _first(review) or ""
        st = _stars(review)
        if st > best_stars:
            best_stars, best_sig, best_review = st, str(sig), str(review)
    return best_sig, best_review


def _normalise_hit(hit: dict) -> Optional[_RawRecord]:
    """Project a myvariant query hit into a _RawRecord. Defensive: returns None
    on anything malformed."""
    if not isinstance(hit, dict):
        return None
    dbnsfp = hit.get("dbnsfp") or {}
    clinvar = hit.get("clinvar") or {}
    if not isinstance(dbnsfp, dict) or not isinstance(clinvar, dict):
        return None
    aapos_raw = _first(dbnsfp.get("aapos"))
    try:
        aapos = int(aapos_raw)
    except (TypeError, ValueError):
        return None
    gene = (
        _first(dbnsfp.get("genename"))
        or _first((clinvar.get("gene") or {}).get("symbol") if isinstance(clinvar.get("gene"), dict) else None)
        or ""
    )
    sig, review = _sig_and_review(clinvar)
    return _RawRecord(
        gene=str(gene),
        aaref=str(_first(dbnsfp.get("aaref")) or ""),
        aaalt=str(_first(dbnsfp.get("aaalt")) or ""),
        aapos=aapos,
        significance=sig,
        review_status=review,
        source_id=hit.get("_id"),
    )


async def _fetch_gene_records(
    client: httpx.AsyncClient, gene: str, *, assembly: str
) -> list[_RawRecord]:
    """Enumerate ClinVar missense hits for one gene via the myvariant query
    API, paging with fetch_all/scroll_id. Returns normalised records (unfiltered
    by P/LP — build_index applies the clinical gate)."""
    out: list[_RawRecord] = []
    params = {
        "q": f'clinvar.gene.symbol:"{gene}" AND _exists_:dbnsfp.aapos',
        "fields": _QUERY_FIELDS,
        "size": str(PER_GENE_PAGE_SIZE),
        "assembly": assembly,
        "fetch_all": "true",
    }
    try:
        resp = await client.get(MYVARIANT_QUERY_URL, params=params)
        resp.raise_for_status()
        page = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("clinvar_aa: query failed for %s: %s", gene, exc)
        return out

    while isinstance(page, dict):
        for hit in page.get("hits", []) or []:
            rec = _normalise_hit(hit)
            if rec is not None:
                out.append(rec)
        if len(out) >= MAX_RECORDS_PER_GENE:
            break
        scroll_id = page.get("_scroll_id")
        if not scroll_id:
            break
        try:
            resp = await client.get(
                MYVARIANT_QUERY_URL,
                params={"scroll_id": scroll_id, "fetch_all": "true"},
            )
            resp.raise_for_status()
            page = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.debug("clinvar_aa: scroll ended for %s: %s", gene, exc)
            break
        # myvariant returns {"success": false, ...} when the scroll is exhausted.
        if isinstance(page, dict) and not page.get("hits"):
            break
    return out


async def fetch_aa_index(
    genes: Iterable[str],
    *,
    assembly: str = "hg38",
    min_stars: int = 1,
) -> ClinVarAAIndex:
    """Build a ClinVarAAIndex for the given genes. Best-effort: any per-gene
    failure is logged and skipped, so the worst case is an empty/partial index
    (PS1/PM5 simply don't fire for the missing genes)."""
    uniq = []
    seen = set()
    for g in genes:
        if g and g.upper() not in seen:
            seen.add(g.upper())
            uniq.append(g)
    uniq = uniq[:MAX_GENES]
    if not uniq:
        return ClinVarAAIndex()

    sem = asyncio.Semaphore(MAX_CONCURRENT)
    all_records: list[_RawRecord] = []

    async with httpx.AsyncClient(
        timeout=PER_REQUEST_TIMEOUT,
        headers={"User-Agent": "variantgpt-engine/0.1"},
    ) as client:
        async def one(gene: str) -> list[_RawRecord]:
            async with sem:
                return await _fetch_gene_records(client, gene, assembly=assembly)

        for recs in await asyncio.gather(*(one(g) for g in uniq)):
            all_records.extend(recs)

    return build_index(all_records, min_stars=min_stars)


def fetch_aa_index_sync(
    genes: Iterable[str], *, assembly: str = "hg38", min_stars: int = 1
) -> ClinVarAAIndex:
    """Synchronous wrapper for tests / CLI use."""
    return asyncio.run(fetch_aa_index(genes, assembly=assembly, min_stars=min_stars))
