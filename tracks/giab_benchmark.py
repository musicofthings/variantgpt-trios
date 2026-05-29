"""GIAB / ClinVar truth-set benchmark for a VariantGPT case.json.

Two analyses run on the same case:

1. Detection sensitivity (GIAB v4.2.1 truth VCF)
   - Of the truth-set's variants on GIAB high-confidence regions, how
     many appeared in our candidate set (case.json variants)?
   - Reports recall (TP / (TP + FN)), broken out by SNV / indel.
   - Note: VariantGPT's pipeline DROPS sites where the proband isn't a
     carrier and DROPS sites with AF > 1% in gnomAD. Those drops are
     intentional — they're how a clinical workflow narrows millions of
     variants to thousands. So "recall" here is recall of
     *clinically-actionable* variants, not blanket recall.

2. Classification concordance (ClinVar reference VCF)
   - Of ClinVar high-confidence (≥2★) classified variants present in
     our candidate set, what fraction did we tier correctly?
   - Outputs a confusion matrix, per-tier precision / recall / F1,
     Cohen's kappa for tier-level agreement, and a list of every
     discordant variant with the likely cause.

Outputs:
   <out>/benchmark.json     — machine-readable
   <out>/benchmark.md       — human-readable summary

Usage:
   python tracks/giab_benchmark.py \\
       --case-json /path/to/case-XYZ.json \\
       --truth-vcf HG002_GRCh38_1_22_v4.2.1_benchmark.vcf.gz \\
       --truth-bed HG002_GRCh38_1_22_v4.2.1_benchmark_noinconsistent.bed \\
       --clinvar-vcf clinvar.vcf.gz \\
       --out ./benchmark-out
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger("giab_benchmark")

TIERS = ["P", "LP", "VUS", "LB", "B"]

CLNSIG_TO_TIER = {
    "pathogenic": "P",
    "likely_pathogenic": "LP",
    "uncertain_significance": "VUS",
    "likely_benign": "LB",
    "benign": "B",
    # Common composites — pick the most clinically actionable component.
    "pathogenic/likely_pathogenic": "P",
    "benign/likely_benign": "B",
}

CLNREVSTAT_STARS = {
    "practice_guideline": 4,
    "reviewed_by_expert_panel": 3,
    "criteria_provided,_multiple_submitters,_no_conflicts": 2,
    "criteria_provided,_conflicting_interpretations": 1,
    "criteria_provided,_single_submitter": 1,
    "no_assertion_criteria_provided": 0,
}


@dataclass
class CaseVariant:
    chrom: str
    pos: int
    ref: str
    alt: str
    tier: str
    reclass_to: Optional[str] = None
    fired_criteria: list[str] = field(default_factory=list)
    gene: Optional[str] = None
    hgvs_c: Optional[str] = None
    hgvs_p: Optional[str] = None


@dataclass
class TruthVariant:
    chrom: str
    pos: int
    ref: str
    alt: str
    is_snv: bool


@dataclass
class ClinVarVariant:
    chrom: str
    pos: int
    ref: str
    alt: str
    tier: str
    stars: int
    gene: Optional[str] = None


# ───────────────────────── parsers ─────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--case-json", required=True, type=Path)
    p.add_argument("--truth-vcf", type=Path, help="GIAB benchmark VCF (.vcf.gz)")
    p.add_argument("--truth-bed", type=Path, help="GIAB high-confidence regions BED (optional but recommended)")
    p.add_argument("--clinvar-vcf", type=Path, help="ClinVar VCF with CLNSIG / CLNREVSTAT INFO fields")
    p.add_argument("--out", type=Path, default=Path("./benchmark-out"))
    p.add_argument("--min-stars", type=int, default=2, help="Minimum ClinVar review stars to include (default: 2)")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args()


def load_case(path: Path) -> list[CaseVariant]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out: list[CaseVariant] = []
    for v in data.get("variants", []):
        fired = [e["criterion"] for e in (v.get("evidence") or []) if e.get("fired")]
        out.append(CaseVariant(
            chrom=_norm_chrom(v.get("chrom") or ""),
            pos=int(v.get("pos") or 0),
            ref=v.get("ref") or "",
            alt=v.get("alt") or "",
            tier=v.get("baseline_tier") or "VUS",
            reclass_to=(v.get("reclass_tier") if v.get("reclass_tier") else None),
            fired_criteria=fired,
            gene=v.get("gene"),
            hgvs_c=v.get("hgvs_c"),
            hgvs_p=v.get("hgvs_p"),
        ))
    log.info("case.json: %d variants", len(out))
    return out


def load_truth_vcf(path: Path, regions: Optional["IntervalSet"]) -> list[TruthVariant]:
    out: list[TruthVariant] = []
    skipped = 0
    for chrom, pos, ref, alt in _iter_vcf(path):
        if regions and not regions.contains(chrom, pos):
            skipped += 1
            continue
        out.append(TruthVariant(
            chrom=chrom, pos=pos, ref=ref, alt=alt,
            is_snv=(len(ref) == 1 and len(alt) == 1),
        ))
    log.info("truth VCF: %d variants (%d skipped outside high-confidence regions)", len(out), skipped)
    return out


def load_clinvar_vcf(path: Path, min_stars: int) -> list[ClinVarVariant]:
    out: list[ClinVarVariant] = []
    for chrom, pos, ref, alt, info in _iter_vcf(path, want_info=True):
        sig = _info_get(info, "CLNSIG")
        revstat = _info_get(info, "CLNREVSTAT")
        if not sig:
            continue
        sig_key = sig.lower().split(",")[0].split("|")[0]
        tier = CLNSIG_TO_TIER.get(sig_key)
        if tier is None:
            continue
        stars = CLNREVSTAT_STARS.get((revstat or "").lower(), 0)
        if stars < min_stars:
            continue
        out.append(ClinVarVariant(
            chrom=chrom, pos=pos, ref=ref, alt=alt, tier=tier, stars=stars,
            gene=_info_get(info, "GENEINFO", default="").split(":")[0] or None,
        ))
    log.info("ClinVar: %d variants with ≥%d★ classification", len(out), min_stars)
    return out


def _iter_vcf(path: Path, want_info: bool = False) -> Iterable:
    opener = gzip.open if str(path).endswith((".gz", ".bgz")) else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 5:
                continue
            chrom = _norm_chrom(cols[0])
            try:
                pos = int(cols[1])
            except ValueError:
                continue
            ref = cols[3]
            for alt in cols[4].split(","):
                if alt in ("", "."):
                    continue
                if want_info:
                    info = cols[7] if len(cols) > 7 else ""
                    yield chrom, pos, ref, alt, info
                else:
                    yield chrom, pos, ref, alt


def _info_get(info: str, key: str, default: str = "") -> str:
    m = re.search(rf"(?:^|;){re.escape(key)}=([^;]+)", info)
    return m.group(1) if m else default


def _norm_chrom(c: str) -> str:
    c = c.strip()
    return c if c.startswith("chr") else f"chr{c}"


# ───────────────────── interval set (for BED) ─────────────────────

class IntervalSet:
    """Cheap per-chromosome sorted interval list w/ binary search."""

    def __init__(self) -> None:
        self.by_chrom: dict[str, list[tuple[int, int]]] = defaultdict(list)

    def load_bed(self, path: Path) -> None:
        opener = gzip.open if str(path).endswith((".gz", ".bgz")) else open
        with opener(path, "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line or line.startswith(("#", "track", "browser")):
                    continue
                cols = line.rstrip("\n").split("\t")
                if len(cols) < 3:
                    continue
                chrom = _norm_chrom(cols[0])
                try:
                    start = int(cols[1])
                    end = int(cols[2])
                except ValueError:
                    continue
                # BED is 0-based half-open. Convert to 1-based closed for VCF.
                self.by_chrom[chrom].append((start + 1, end))
        for chrom in self.by_chrom:
            self.by_chrom[chrom].sort()
        log.info("BED: loaded %d intervals across %d chromosomes",
                 sum(len(v) for v in self.by_chrom.values()),
                 len(self.by_chrom))

    def contains(self, chrom: str, pos: int) -> bool:
        ivs = self.by_chrom.get(chrom)
        if not ivs:
            return False
        # Binary search for the first interval with start > pos.
        lo, hi = 0, len(ivs)
        while lo < hi:
            mid = (lo + hi) // 2
            if ivs[mid][0] <= pos:
                lo = mid + 1
            else:
                hi = mid
        idx = lo - 1
        if idx < 0:
            return False
        s, e = ivs[idx]
        return s <= pos <= e


# ───────────────────────── analyses ─────────────────────────

def detection_sensitivity(case_vars: list[CaseVariant], truth: list[TruthVariant]) -> dict:
    case_keys = {(v.chrom, v.pos, v.ref, v.alt) for v in case_vars}
    tp_snv = tp_indel = fn_snv = fn_indel = 0
    missed_examples: list[dict] = []
    for t in truth:
        hit = (t.chrom, t.pos, t.ref, t.alt) in case_keys
        if t.is_snv:
            if hit:
                tp_snv += 1
            else:
                fn_snv += 1
        else:
            if hit:
                tp_indel += 1
            else:
                fn_indel += 1
        if not hit and len(missed_examples) < 20:
            missed_examples.append({
                "chrom": t.chrom, "pos": t.pos, "ref": t.ref, "alt": t.alt,
                "type": "SNV" if t.is_snv else "indel",
            })
    recall_snv = tp_snv / (tp_snv + fn_snv) if (tp_snv + fn_snv) else None
    recall_indel = tp_indel / (tp_indel + fn_indel) if (tp_indel + fn_indel) else None
    return {
        "truth_total": len(truth),
        "tp_snv": tp_snv, "fn_snv": fn_snv,
        "tp_indel": tp_indel, "fn_indel": fn_indel,
        "recall_snv": recall_snv,
        "recall_indel": recall_indel,
        "missed_examples": missed_examples,
    }


def classification_concordance(case_vars: list[CaseVariant], cv: list[ClinVarVariant]) -> dict:
    cv_by_key = {(v.chrom, v.pos, v.ref, v.alt): v for v in cv}
    confusion: dict[tuple[str, str], int] = Counter()
    discordant: list[dict] = []
    matched = 0
    for v in case_vars:
        cvv = cv_by_key.get((v.chrom, v.pos, v.ref, v.alt))
        if not cvv:
            continue
        matched += 1
        ours_effective = v.reclass_to or v.tier
        confusion[(ours_effective, cvv.tier)] += 1
        if ours_effective != cvv.tier:
            discordant.append({
                "chrom": v.chrom, "pos": v.pos, "ref": v.ref, "alt": v.alt,
                "gene": v.gene, "hgvs_c": v.hgvs_c, "hgvs_p": v.hgvs_p,
                "ours": v.tier, "ours_reclass": v.reclass_to,
                "clinvar": cvv.tier, "clinvar_stars": cvv.stars,
                "fired_criteria": v.fired_criteria,
                "likely_cause": _hypothesise_cause(v, cvv),
            })

    # Per-tier precision/recall/F1.
    per_tier: dict[str, dict] = {}
    for t in TIERS:
        tp = confusion.get((t, t), 0)
        fp = sum(confusion.get((t, u), 0) for u in TIERS if u != t)
        fn = sum(confusion.get((u, t), 0) for u in TIERS if u != t)
        prec = tp / (tp + fp) if (tp + fp) else None
        rec = tp / (tp + fn) if (tp + fn) else None
        f1 = (2 * prec * rec / (prec + rec)) if (prec and rec) else None
        per_tier[t] = {"tp": tp, "fp": fp, "fn": fn, "precision": prec, "recall": rec, "f1": f1}

    return {
        "matched": matched,
        "confusion_matrix": {f"{o}__{c}": n for (o, c), n in confusion.items()},
        "per_tier": per_tier,
        "overall_accuracy": (sum(confusion.get((t, t), 0) for t in TIERS) / matched) if matched else None,
        "cohen_kappa": _cohen_kappa(confusion),
        "discordant": discordant,
    }


def _hypothesise_cause(v: CaseVariant, cvv: ClinVarVariant) -> str:
    ours = v.reclass_to or v.tier
    cv_tier = cvv.tier
    fired_p = [c for c in v.fired_criteria if c.startswith(("PVS", "PS", "PM", "PP"))]
    fired_b = [c for c in v.fired_criteria if c.startswith(("BA", "BS", "BP"))]
    if cv_tier in ("P", "LP") and ours in ("VUS", "LB", "B"):
        if not fired_p:
            return "We fired NO pathogenic ACMG criteria for a ClinVar P/LP variant — likely a missing criterion (PS3, PM3, PP1, PP4 not yet implemented)."
        return f"We fired {len(fired_p)} pathogenic criteria ({', '.join(fired_p)}) but didn't reach P/LP threshold — likely a strength mis-assignment."
    if cv_tier in ("B", "LB") and ours in ("P", "LP"):
        if not fired_b:
            return "We fired NO benign criteria for a ClinVar B/LB variant — possible AF source gap (gnomAD-only without IndiGen/GenomeAsia)."
        return f"We fired {len(fired_b)} benign criteria but over-counted pathogenic points."
    if abs(TIERS.index(ours) - TIERS.index(cv_tier)) == 1:
        return f"One-tier offset ({ours} vs {cv_tier}); usually a single missing/extra Supporting criterion."
    return f"Multi-tier disagreement ({ours} vs {cv_tier})."


def _cohen_kappa(confusion: dict[tuple[str, str], int]) -> Optional[float]:
    total = sum(confusion.values())
    if total == 0:
        return None
    row_sums = Counter()
    col_sums = Counter()
    for (r, c), n in confusion.items():
        row_sums[r] += n
        col_sums[c] += n
    obs = sum(confusion.get((t, t), 0) for t in TIERS) / total
    exp = sum((row_sums[t] / total) * (col_sums[t] / total) for t in TIERS)
    if exp >= 1:
        return None
    return (obs - exp) / (1 - exp)


# ───────────────────────── report ─────────────────────────

def render_markdown(case_path: Path, detection: Optional[dict], concord: Optional[dict]) -> str:
    lines: list[str] = []
    lines.append("# VariantGPT — Truth-set Benchmark Report")
    lines.append("")
    lines.append(f"Case: `{case_path.name}`")
    lines.append("")
    if detection:
        d = detection
        lines.append("## 1. Detection sensitivity (GIAB truth VCF)")
        lines.append("")
        lines.append("Recall over the GIAB benchmark, restricted to the case's candidate set. Our pipeline intentionally drops common variants and sites where the proband isn't a carrier — so this measures recall on *clinically actionable* truth variants, not blanket recall.")
        lines.append("")
        lines.append(f"- Truth variants considered: **{d['truth_total']:,}**")
        lines.append(f"- SNV recall: **{_fmt_rate(d['recall_snv'])}** (TP={d['tp_snv']:,}, FN={d['fn_snv']:,})")
        lines.append(f"- Indel recall: **{_fmt_rate(d['recall_indel'])}** (TP={d['tp_indel']:,}, FN={d['fn_indel']:,})")
        if d["missed_examples"]:
            lines.append("")
            lines.append("First 20 missed variants:")
            lines.append("")
            lines.append("| Locus | Type |")
            lines.append("|---|---|")
            for m in d["missed_examples"]:
                lines.append(f"| `{m['chrom']}:{m['pos']} {m['ref']}>{m['alt']}` | {m['type']} |")
        lines.append("")
    if concord:
        c = concord
        lines.append("## 2. Classification concordance (ClinVar ≥2★)")
        lines.append("")
        lines.append(f"- Variants matched in both VariantGPT case and ClinVar reference: **{c['matched']:,}**")
        acc = c["overall_accuracy"]
        lines.append(f"- Overall tier accuracy: **{_fmt_rate(acc)}**")
        k = c["cohen_kappa"]
        lines.append(f"- Cohen's κ (agreement adjusted for chance): **{_fmt_float(k)}**  " + _kappa_interpretation(k))
        lines.append("")
        lines.append("### Per-tier precision / recall / F1")
        lines.append("")
        lines.append("| Tier | TP | FP | FN | Precision | Recall | F1 |")
        lines.append("|------|----|----|----|-----------|--------|----|")
        for t in TIERS:
            r = c["per_tier"][t]
            lines.append(f"| **{t}** | {r['tp']} | {r['fp']} | {r['fn']} | {_fmt_rate(r['precision'])} | {_fmt_rate(r['recall'])} | {_fmt_rate(r['f1'])} |")
        lines.append("")
        lines.append("### Confusion matrix")
        lines.append("")
        lines.append("Rows = VariantGPT tier (post-reclassification); Columns = ClinVar tier.")
        lines.append("")
        header = "| Ours\\ClinVar | " + " | ".join(TIERS) + " |"
        sep = "|" + "---|" * (len(TIERS) + 1)
        lines.append(header)
        lines.append(sep)
        for ot in TIERS:
            row_cells = [f"**{ot}**"] + [str(c["confusion_matrix"].get(f"{ot}__{ct}", 0)) for ct in TIERS]
            lines.append("| " + " | ".join(row_cells) + " |")
        lines.append("")
        if c["discordant"]:
            n_show = min(50, len(c["discordant"]))
            lines.append(f"### Discordant variants (first {n_show})")
            lines.append("")
            lines.append("| Gene · HGVS | Locus | Ours | ClinVar | Likely cause |")
            lines.append("|---|---|---|---|---|")
            for d in c["discordant"][:n_show]:
                ours = d["ours"] + (f"→{d['ours_reclass']}" if d["ours_reclass"] else "")
                hgvs = (d["hgvs_c"] or "") + ((" " + d["hgvs_p"]) if d["hgvs_p"] else "")
                lines.append(
                    f"| **{d['gene'] or '—'}** {hgvs} "
                    f"| `{d['chrom']}:{d['pos']} {d['ref']}>{d['alt']}` "
                    f"| {ours} | {d['clinvar']} ({d['clinvar_stars']}★) "
                    f"| {d['likely_cause']} |"
                )
            if len(c["discordant"]) > n_show:
                lines.append(f"\n_+ {len(c['discordant']) - n_show} more (see benchmark.json)_")
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("*Generated by `tracks/giab_benchmark.py`.*")
    return "\n".join(lines)


def _fmt_rate(x: Optional[float]) -> str:
    return f"{x * 100:.1f}%" if x is not None else "—"


def _fmt_float(x: Optional[float]) -> str:
    return f"{x:.3f}" if x is not None else "—"


def _kappa_interpretation(k: Optional[float]) -> str:
    if k is None:
        return ""
    if k < 0:
        return "_(worse than chance — sanity check the input)_"
    if k < 0.2:
        return "_(slight agreement)_"
    if k < 0.4:
        return "_(fair agreement)_"
    if k < 0.6:
        return "_(moderate agreement)_"
    if k < 0.8:
        return "_(substantial agreement)_"
    return "_(near-perfect agreement)_"


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if not args.truth_vcf and not args.clinvar_vcf:
        log.error("at least one of --truth-vcf or --clinvar-vcf is required")
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    case_vars = load_case(args.case_json)

    detection = None
    if args.truth_vcf:
        regions = None
        if args.truth_bed:
            regions = IntervalSet()
            regions.load_bed(args.truth_bed)
        truth = load_truth_vcf(args.truth_vcf, regions)
        detection = detection_sensitivity(case_vars, truth)

    concord = None
    if args.clinvar_vcf:
        cv = load_clinvar_vcf(args.clinvar_vcf, args.min_stars)
        concord = classification_concordance(case_vars, cv)

    report = {
        "case_json": str(args.case_json),
        "case_variants": len(case_vars),
        "detection_sensitivity": detection,
        "classification_concordance": concord,
    }
    json_out = args.out / "benchmark.json"
    md_out = args.out / "benchmark.md"
    json_out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    md_out.write_text(render_markdown(args.case_json, detection, concord), encoding="utf-8")
    log.info("wrote %s", json_out)
    log.info("wrote %s", md_out)
    print("\n" + "-" * 60)
    # stdout on Windows defaults to cp1252; force utf-8 for the markdown
    # preview so the ≥/Δ characters render.
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    print(md_out.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
