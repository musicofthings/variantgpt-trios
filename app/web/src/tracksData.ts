/** Reference content for the Tracks & Settings page.
 *
 * This is a hand-mirrored snapshot of engine-side constants — the engine
 * (Python) and this SPA (TypeScript) are separately deployed, so there's no
 * shared module to import from. Source of truth for each section:
 *   - Population tracks: engine/src/variantgpt_engine/annotation_sources/*.py
 *     + engine/src/variantgpt_engine/models.py (PopulationAF.source)
 *   - Predictors: engine/src/variantgpt_engine/models.py (PredictorScores docstring)
 *   - ACMG thresholds: engine/src/variantgpt_engine/acmg/thresholds.py (VCEP_THRESHOLDS)
 * If those files change, update this file to match.
 */

export interface PopulationTrack {
  name: string;
  role: string;
  status: string;
  detail: string;
}

export const POPULATION_TRACKS: PopulationTrack[] = [
  {
    name: "IndiGenomes",
    role: "South-Asian reclassification source",
    status: "Live",
    detail: "Queried live per-gene against IGIB's API, proxied through the Worker (IGIB blocks Fly IPs). No version pinning — always reflects IGIB's current data.",
  },
  {
    name: "GenomeAsia (GenomeAsia100K)",
    role: "South-Asian reclassification source",
    status: "R2-hosted, versioned",
    detail: "Per-chromosome allele-frequency TSVs ingested once via tracks/ingest_genomeasia.py and stored in R2 with a manifest.json (version, checksums). Default prefix: tracks/genomeasia/v1.",
  },
  {
    name: "GenomeIndia",
    role: "South-Asian reclassification source",
    status: "Not yet available",
    detail: "Ingestion is gated on an approved IBDC/FeED data-access extract; the pipeline already has a slot for this source (models.py: \"genomeindia\") but no data is wired in yet.",
  },
  {
    name: "gnomAD v4 (global + SAS)",
    role: "Annotation context only — never a reclassification source",
    status: "Live",
    detail: "gnomAD-SAS is deliberately excluded from South-Asian reclassification: it's Bangladeshi/diaspora-dominated and under-represents pan-Indian sub-populations. It still annotates every variant for context.",
  },
];

export interface Predictor {
  name: string;
  direction: string;
  thresholds: string;
}

export const PREDICTORS: Predictor[] = [
  { name: "REVEL", direction: "high = damaging", thresholds: "PP3 ≥ 0.644 · BP4 ≤ 0.290" },
  { name: "AlphaMissense", direction: "high = damaging", thresholds: "PP3 ≥ 0.564 · BP4 ≤ 0.116" },
  { name: "CADD (phred)", direction: "high = damaging", thresholds: ">20 = top 1% deleterious" },
  { name: "SpliceAI", direction: "high = damaging", thresholds: ">0.5 = high-confidence splice impact" },
  { name: "PolyPhen2 (HVAR)", direction: "high = damaging", thresholds: ">0.957 probably damaging · 0.453–0.957 possibly damaging" },
  { name: "PolyPhen2 (HDIV)", direction: "high = damaging", thresholds: "training set: disease vs. neutral" },
  { name: "SIFT", direction: "low = damaging", thresholds: "<0.05 = deleterious" },
  { name: "FATHMM", direction: "low = damaging", thresholds: "< -1.5 = damaging" },
  { name: "PROVEAN", direction: "low = damaging", thresholds: "< -2.5 = damaging" },
  { name: "MetaSVM", direction: "high = damaging", thresholds: "> 0 = damaging" },
  { name: "MetaLR", direction: "high = damaging", thresholds: "ensemble score, 0..1" },
  { name: "Mutation Taster", direction: "high = damaging", thresholds: "ensemble score, 0..1" },
  { name: "LRT", direction: "high = damaging", thresholds: "ensemble score, 0..1" },
  { name: "VEST4", direction: "high = damaging", thresholds: "ensemble score, 0..1" },
  { name: "PhyloP", direction: "high = conserved", thresholds: "vertebrate rankscore" },
  { name: "GERP", direction: "high = conserved", thresholds: "rejected substitutions" },
];
// All predictors are sourced from dbNSFP via myvariant.info and are optional
// per-variant — a missing score simply doesn't fire its PP3/BP4 criterion.

export interface GeneThreshold {
  gene: string;
  ba1: number;
  bs1: number;
  source: string;
}

export const DEFAULT_THRESHOLD = { ba1: 0.05, bs1: 0.01, pm2Supporting: 1e-4, source: "ClinGen-SVI default" };

/** Genes with a published ClinGen VCEP frequency threshold — everything else
 *  falls back to DEFAULT_THRESHOLD. BA1 = stand-alone benign; BS1 = strong
 *  benign; both are population allele-frequency cutoffs, tighter for
 *  dominant/rare-disease genes than the SVI default. */
export const GENE_THRESHOLDS: GeneThreshold[] = [
  { gene: "GJB2", ba1: 0.005, bs1: 0.003, source: "Hearing Loss VCEP" },
  { gene: "MYO7A", ba1: 0.005, bs1: 0.003, source: "Hearing Loss VCEP" },
  { gene: "SLC26A4", ba1: 0.005, bs1: 0.003, source: "Hearing Loss VCEP" },
  { gene: "USH2A", ba1: 0.005, bs1: 0.003, source: "Hearing Loss VCEP" },
  { gene: "CDH23", ba1: 0.005, bs1: 0.003, source: "Hearing Loss VCEP" },
  { gene: "TMC1", ba1: 0.005, bs1: 0.003, source: "Hearing Loss VCEP" },
  { gene: "PTPN11", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "SOS1", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "RAF1", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "BRAF", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "KRAS", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "NRAS", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "HRAS", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "MAP2K1", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "MAP2K2", ba1: 0.001, bs1: 0.0001, source: "RASopathy VCEP" },
  { gene: "MYH7", ba1: 0.001, bs1: 0.0001, source: "Cardiomyopathy VCEP" },
  { gene: "MYBPC3", ba1: 0.001, bs1: 0.00004, source: "Cardiomyopathy VCEP" },
  { gene: "TNNT2", ba1: 0.001, bs1: 0.0001, source: "Cardiomyopathy VCEP" },
  { gene: "TNNI3", ba1: 0.001, bs1: 0.0001, source: "Cardiomyopathy VCEP" },
  { gene: "TPM1", ba1: 0.001, bs1: 0.0001, source: "Cardiomyopathy VCEP" },
  { gene: "KCNQ1", ba1: 0.0001, bs1: 0.00002, source: "LQTS VCEP" },
  { gene: "KCNH2", ba1: 0.0001, bs1: 0.00002, source: "LQTS VCEP" },
  { gene: "SCN5A", ba1: 0.0001, bs1: 0.00002, source: "LQTS VCEP" },
  { gene: "PTEN", ba1: 0.00001, bs1: 0.000003, source: "PTEN VCEP" },
  { gene: "TP53", ba1: 0.001, bs1: 0.0003, source: "TP53 VCEP" },
  { gene: "BRCA1", ba1: 0.001, bs1: 0.0001, source: "ENIGMA-aligned" },
  { gene: "BRCA2", ba1: 0.001, bs1: 0.0001, source: "ENIGMA-aligned" },
  { gene: "CDH1", ba1: 0.00002, bs1: 0.000004, source: "CDH1 VCEP" },
  { gene: "MLH1", ba1: 0.00002, bs1: 0.000005, source: "InSiGHT-aligned" },
  { gene: "MSH2", ba1: 0.00002, bs1: 0.000005, source: "InSiGHT-aligned" },
  { gene: "MSH6", ba1: 0.00002, bs1: 0.000005, source: "InSiGHT-aligned" },
  { gene: "PMS2", ba1: 0.00002, bs1: 0.000005, source: "InSiGHT-aligned" },
  { gene: "POLG", ba1: 0.005, bs1: 0.003, source: "Mitochondrial Disease VCEP" },
  { gene: "SURF1", ba1: 0.005, bs1: 0.003, source: "Mitochondrial Disease VCEP" },
];
