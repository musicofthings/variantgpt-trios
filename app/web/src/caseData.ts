/** Loader + adapter for the engine's case.json (data/test/demo_trio/case.json).
 *
 * The Python engine's CaseEmission schema (engine/src/variantgpt_engine/models.py)
 * is the canonical wire format. The SPA's VariantRow/CaseRow types are a
 * UI-friendly projection of it. This module bridges the two.
 */
import { useEffect, useState } from "react";
import { api, apiFetch } from "./apiBase";
import type {
  CaseRow, Criterion, CriterionStrength, EvidenceRow, InheritanceModel,
  PhenotypeScore, PopulationAF, PopulationSource, Predictors, ReclassProposal, Tier, VariantRow,
} from "./types";

/** Subset of the engine's case.json we actually consume. */
export interface EngineCase {
  case_id: string;
  build: string;
  pedigree: {
    members: { id: string; role: string; sex: string; affected: string; sample_name?: string }[];
    consanguinity: boolean;
    relations: [string, string, string][];
  };
  hpo: { hpo_id: string; label?: string; definition?: string; source?: string }[];
  gene_info?: Record<string, {
    symbol: string;
    name?: string;
    summary?: string;
    type_of_gene?: string;
    omim_id?: string;
  }>;
  clinical_history?: {
    text?: string;
    onset_age?: string;
    consanguinity_note?: string;
    prior_testing?: string;
    family_history?: string;
  } | null;
  qc: Record<string, unknown>;
  variants: EngineVariant[];
  proposals: EngineProposal[];
  versions: Record<string, string>;
}

/** HPO term as used by the report's patient-details section. */
export interface HPOTermRow {
  hpo_id: string;
  label?: string;
  definition?: string;
}

/** Per-gene metadata from mygene.info — keyed by HGNC symbol at the case
 *  level so the report can render gene-function prose without bloating
 *  each variant row. */
export interface GeneInfoRow {
  symbol: string;
  name?: string;
  summary?: string;
  type_of_gene?: string;
  omim_id?: string;
}

/** Patient clinical context — plumbed to the report's first page. */
export interface ClinicalHistory {
  text?: string;
  onset_age?: string;
  consanguinity_note?: string;
  prior_testing?: string;
  family_history?: string;
}

interface EnginePhenotypeScore {
  percent: number;
  matched_terms: { hpo_id: string; label?: string | null; contribution: number }[];
}

interface EngineVariant {
  id: string;
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  gene?: string | null;
  transcript?: string | null;
  hgvs_c?: string | null;
  hgvs_p?: string | null;
  consequence?: string | null;
  exon?: string | null;
  genomic_hgvs?: string | null;
  omim_id?: string | null;
  hpo_matches?: string[] | null;
  phenotype_relevance?: {
    coverage: EnginePhenotypeScore;
    resnik: EnginePhenotypeScore;
    phrank: EnginePhenotypeScore;
  } | null;
  gene_phenotypes?: { hpo_id: string; label?: string | null; matches_case?: boolean }[] | null;
  gene_phenotype_total?: number | null;
  calls?: {
    member_id: string;
    role: string;
    zygosity: "hom_ref" | "het" | "hom_alt" | "missing";
    depth?: number | null;
    allele_balance?: number | null;
    gq?: number | null;
  }[] | null;
  inheritance_models: string[];
  inheritance_confidence: string;
  populations: { source: string; ac?: number; an?: number; af?: number | null; n_hom?: number; n_het?: number }[];
  predictors: {
    alphamissense?: number | null;
    revel?: number | null;
    cadd?: number | null;
    spliceai?: number | null;
  };
  clinvar?: {
    rcv_count?: number | null;
    clinical_significance?: string | null;
    review_status?: string | null;
    review_stars?: number | null;
    last_evaluated?: string | null;
    conditions?: string[] | null;
    variation_id?: string | null;
  } | null;
  evidence: { criterion: string; fired: boolean; strength?: string | null; points: number; source: string; detail: string }[];
  baseline_tier?: Tier | null;
  baseline_points: number;
  reclass_tier?: Tier | null;
  reclass_points?: number | null;
  reclass_delta?: number | null;
  priority_score: number;
}

interface EngineProposal {
  variant_id: string;
  from_tier: Tier;
  to_tier: Tier;
  changed_criteria: { criterion: string; fired: boolean; strength?: string | null; points: number; source: string; detail: string }[];
  af_evidence: { source: string; af?: number | null }[];
  snapshot_versions: Record<string, string>;
  status: string;
}

/** Polarity lookup — drives the ledger's Pathogenic / Benign grouping. */
const POLARITY: Record<string, "P" | "B"> = {
  PVS1: "P", PS1: "P", PS2: "P", PS3: "P", PS4: "P",
  PM1: "P", PM2: "P", PM3: "P", PM4: "P", PM5: "P", PM6: "P",
  PP1: "P", PP2: "P", PP3: "P", PP4: "P",
  BA1: "B", BS1: "B", BS2: "B", BS3: "B", BS4: "B",
  BP2: "B", BP4: "B", BP7: "B",
};

/** Engine strength tokens → UI tokens. */
const STRENGTH: Record<string, CriterionStrength> = {
  VS: "VeryStrong", S: "Strong", M: "Moderate", P: "Supporting",
  BS: "Strong", BP: "Supporting", BA: "StandAlone",
};

const POP_MAP: Record<string, PopulationSource | null> = {
  gnomad_v4_global: "gnomad_global",
  gnomad_v4_sas: "gnomad_sas",
  indigenomes: "indigenomes",
  genomeasia: "genomeasia",
  genomeindia: "genomeindia",
};

function adaptVariant(ev: EngineVariant, proposal?: EngineProposal): VariantRow {
  const af = (src: string) => ev.populations.find((p) => p.source === src)?.af ?? null;

  return {
    id: ev.id,
    chrom: ev.chrom,
    pos: ev.pos,
    ref: ev.ref,
    alt: ev.alt,
    gene: ev.gene ?? undefined,
    hgvs_c: ev.hgvs_c ?? undefined,
    hgvs_p: ev.hgvs_p ?? undefined,
    transcript: ev.transcript ?? undefined,
    consequence: ev.consequence ?? undefined,
    exon: ev.exon ?? undefined,
    genomic_hgvs: ev.genomic_hgvs ?? undefined,
    omim_id: ev.omim_id ?? undefined,
    hpo_matches: ev.hpo_matches ?? undefined,
    phenotype_relevance: ev.phenotype_relevance
      ? {
          coverage: adaptPhenoScore(ev.phenotype_relevance.coverage),
          resnik: adaptPhenoScore(ev.phenotype_relevance.resnik),
          phrank: adaptPhenoScore(ev.phenotype_relevance.phrank),
        }
      : null,
    gene_phenotypes: (ev.gene_phenotypes ?? []).map((p) => ({
      hpo_id: p.hpo_id,
      label: p.label ?? undefined,
      matches_case: p.matches_case ?? false,
    })),
    gene_phenotype_total: ev.gene_phenotype_total ?? 0,
    inheritance_models: ev.inheritance_models as InheritanceModel[],
    inheritance_confidence: (ev.inheritance_confidence as "high" | "medium" | "low" | undefined) ?? undefined,
    calls: ev.calls ? ev.calls.map((c) => ({
      member_id: c.member_id,
      role: c.role,
      zygosity: c.zygosity,
      depth: c.depth ?? null,
      allele_balance: c.allele_balance ?? null,
      gq: c.gq ?? null,
    })) : undefined,
    af_global: af("gnomad_v4_global"),
    af_sas: af("gnomad_v4_sas"),
    af_indi: af("indigenomes"),
    baseline_tier: ev.baseline_tier ?? "VUS",
    reclass: proposal
      ? {
          from: proposal.from_tier,
          to: proposal.to_tier,
          delta: (ev.reclass_delta ?? 0),
          criteria: proposal.changed_criteria.map((c) => criterionLabel(c)),
        }
      : null,
    priority_score: ev.priority_score,
    evidence: ev.evidence.map((e): EvidenceRow => ({
      criterion: e.criterion as Criterion,
      polarity: POLARITY[e.criterion] ?? "P",
      fired: e.fired,
      strength: e.strength ? STRENGTH[e.strength] : undefined,
      summary: e.detail || (e.fired ? "Fired" : "Not fired"),
      trigger: e.detail || undefined,
      source: e.source || undefined,
    })),
    populations: ev.populations
      .map((p): PopulationAF | null => {
        const src = POP_MAP[p.source];
        if (!src) return null;
        return {
          source: src,
          af: p.af ?? null,
          ac: p.ac,
          an: p.an,
          n_hom: p.n_hom,
          n_het: p.n_het,
        };
      })
      .filter((x): x is PopulationAF => x !== null),
    predictors: {
      alphamissense: ev.predictors.alphamissense ?? undefined,
      revel: ev.predictors.revel ?? undefined,
      cadd: ev.predictors.cadd ?? undefined,
      spliceai: ev.predictors.spliceai ?? undefined,
    } as Predictors,
    clinvar: ev.clinvar ? {
      rcv_count: ev.clinvar.rcv_count ?? undefined,
      clinical_significance: ev.clinvar.clinical_significance ?? undefined,
      review_status: ev.clinvar.review_status ?? undefined,
      review_stars: ev.clinvar.review_stars ?? undefined,
      last_evaluated: ev.clinvar.last_evaluated ?? undefined,
      conditions: ev.clinvar.conditions ?? undefined,
      variation_id: ev.clinvar.variation_id ?? undefined,
    } : null,
  };
}

function adaptPhenoScore(s: EnginePhenotypeScore): PhenotypeScore {
  return {
    percent: s.percent,
    matched_terms: (s.matched_terms ?? []).map((t) => ({
      hpo_id: t.hpo_id,
      label: t.label ?? undefined,
      contribution: t.contribution,
    })),
  };
}

function criterionLabel(c: EngineProposal["changed_criteria"][number]): string {
  if (!c.fired && c.criterion === "PM2") return "PM2 retracted";
  if (c.fired) return `${c.criterion}${c.strength ? ` (${c.strength})` : ""}`;
  return c.criterion;
}

export function adaptCase(engine: EngineCase): {
  caseRow: CaseRow;
  variants: VariantRow[];
  proposals: ReclassProposal[];
  hpo: HPOTermRow[];
  clinical_history: ClinicalHistory | null;
  proband_member: { id: string; sex: string; affected: string; sample_name?: string } | null;
  /** Pipeline shape inferred from the case.json pedigree. Drives the
   *  singleton/duo/trio capability banner on the workbench. */
  pipeline_mode: "singleton" | "duo" | "trio" | "extended";
  member_roles: string[];
  /** Per-gene mygene.info metadata, keyed by HGNC symbol. */
  gene_info: Record<string, GeneInfoRow>;
} {
  const propByVar = new Map(engine.proposals.map((p) => [p.variant_id, p]));
  const variants = engine.variants.map((v) => adaptVariant(v, propByVar.get(v.id)));
  const proband = engine.pedigree.members.find((m) => m.role === "proband");
  return {
    caseRow: {
      id: engine.case_id,
      name: `Demo trio · ${engine.case_id}`,
      proband: proband?.sample_name ?? proband?.id,
      findings_count: variants.length,
      vus_count: variants.filter((v) => v.baseline_tier === "VUS").length,
      reclass_count: engine.proposals.length,
      status: "ready",
      updated_at: new Date().toISOString().slice(0, 10),
    },
    variants,
    proposals: variants
      .filter((v) => v.reclass)
      .map((v) => v.reclass as ReclassProposal),
    hpo: (engine.hpo ?? []).map((h) => ({ hpo_id: h.hpo_id, label: h.label, definition: h.definition })),
    clinical_history: engine.clinical_history ?? null,
    proband_member: proband
      ? { id: proband.id, sex: proband.sex, affected: proband.affected, sample_name: proband.sample_name }
      : null,
    pipeline_mode: inferPipelineMode(engine),
    member_roles: (engine.pedigree?.members ?? []).map((m) => m.role),
    gene_info: engine.gene_info ?? {},
  };
}

/** Infer pipeline mode from the case.json pedigree. We compare the SET of
 *  member roles present (NOT counts — a "sibling" alone is still effectively
 *  a singleton from an inheritance-reasoning standpoint).
 *  - singleton: proband only (or proband + non-parent members)
 *  - duo:       proband + exactly one parent (father OR mother)
 *  - trio:      proband + both parents
 *  - extended:  trio + siblings / other relatives
 */
function inferPipelineMode(engine: EngineCase): "singleton" | "duo" | "trio" | "extended" {
  const roles = new Set((engine.pedigree?.members ?? []).map((m) => m.role));
  const hasFather = roles.has("father");
  const hasMother = roles.has("mother");
  const parents = (hasFather ? 1 : 0) + (hasMother ? 1 : 0);
  if (parents === 2 && roles.size > 3) return "extended";
  if (parents === 2) return "trio";
  if (parents === 1) return "duo";
  return "singleton";
}

const cache = new Map<string, ReturnType<typeof adaptCase>>();
const inflight = new Map<string, Promise<ReturnType<typeof adaptCase>>>();

const DEMO_URL = "/demo/case.json";

export async function loadCase(caseId?: string) {
  const url = caseId && caseId !== "demo-trio-001" ? api(`/cases/${caseId}`) : DEMO_URL;
  if (cache.has(url)) return cache.get(url)!;
  if (inflight.has(url)) return inflight.get(url)!;
  // Demo URL hits a static asset on Pages (no auth); uploaded cases hit
  // the Worker and need the Clerk JWT.
  const fetcher = url === DEMO_URL ? fetch : apiFetch;
  const p = fetcher(url)
    .then((r) => {
      if (!r.ok) throw new Error(`case fetch ${r.status} for ${url}`);
      return r.json();
    })
    .then((j: EngineCase) => {
      const adapted = adaptCase(j);
      cache.set(url, adapted);
      return adapted;
    })
    .finally(() => {
      // Always clear the inflight slot so a rejected fetch doesn't permanently
      // poison this caseId — a retry must be allowed to start a fresh request.
      inflight.delete(url);
    });
  inflight.set(url, p);
  return p;
}

/** Back-compat: the demo dashboard always loads the seeded demo. */
export const loadDemoCase = () => loadCase();

/** React hook: fetch + adapt a case.json (demo by default, or a specific
 * uploaded case if `caseId` is provided). */
export function useDemoCase(caseId?: string) {
  const url = caseId && caseId !== "demo-trio-001" ? api(`/cases/${caseId}`) : DEMO_URL;
  const [data, setData] = useState<ReturnType<typeof adaptCase> | null>(cache.get(url) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(cache.get(url) ?? null);
    setError(null);
    if (cache.has(url)) return;
    loadCase(caseId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [url, caseId]);

  return { data, error, loading: !data && !error };
}
