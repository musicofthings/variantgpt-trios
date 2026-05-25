export type Tier = "P" | "LP" | "VUS" | "LB" | "B";

export type InheritanceModel =
  | "de_novo" | "ar_hom" | "comp_het" | "ad_inherited"
  | "x_linked_recessive" | "x_linked_dominant" | "y_linked" | "mitochondrial" | "unresolved";

export type CriterionStrength =
  | "Supporting" | "Moderate" | "Strong" | "VeryStrong" | "StandAlone";

/** ACMG criterion tokens (PRD §7). */
export type Criterion =
  | "PVS1" | "PS1" | "PS2" | "PS3" | "PS4"
  | "PM1" | "PM2" | "PM3" | "PM4" | "PM5" | "PM6"
  | "PP1" | "PP2" | "PP3" | "PP4"
  | "BA1" | "BS1" | "BS2" | "BS3" | "BS4"
  | "BP2" | "BP4" | "BP7";

export interface EvidenceRow {
  criterion: Criterion;
  /** Pathogenic | Benign — drives ledger grouping & color group. */
  polarity: "P" | "B";
  fired: boolean;
  strength?: CriterionStrength;
  /** One-line trigger summary, plain English. */
  summary?: string;
  /** Data point that triggered it (e.g., AF, predictor score, transcript context). */
  trigger?: string;
  /** Source tag: gnomAD-sas, IndiGenomes, ClinVar 2-star, AlphaMissense, etc. */
  source?: string;
}

export type PopulationSource =
  | "gnomad_global" | "gnomad_sas" | "indigenomes" | "genomeasia" | "genomeindia";

export interface PopulationAF {
  source: PopulationSource;
  af: number | null;
  ac?: number;
  an?: number;
  n_hom?: number;
  n_het?: number;
}

export interface Predictors {
  alphamissense?: number;
  revel?: number;
  cadd?: number;
  spliceai?: number;
}

export interface CaseRow {
  id: string;
  name: string;
  proband?: string;
  findings_count?: number;
  vus_count?: number;
  reclass_count?: number;
  status: string;
  updated_at?: string;
}

export interface ReclassProposal {
  from: Tier;
  to: Tier;
  delta: number;
  criteria: string[];
}

export interface ClinVarRecord {
  rcv_count?: number;
  clinical_significance?: string;
  review_status?: string;
  review_stars?: number;       // 0-4 stars
  last_evaluated?: string;
  conditions?: string[];
  variation_id?: string;
}

export interface VariantRow {
  id: string;
  gene?: string;
  hgvs_c?: string;
  hgvs_p?: string;
  transcript?: string;
  consequence?: string;
  inheritance_models: InheritanceModel[];
  af_global?: number | null;
  af_sas?: number | null;
  af_indi?: number | null;
  baseline_tier: Tier;
  reclass?: ReclassProposal | null;
  priority_score: number;
  evidence?: EvidenceRow[];
  populations?: PopulationAF[];
  predictors?: Predictors;
  clinvar?: ClinVarRecord | null;
}
