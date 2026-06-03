export type Tier = "P" | "LP" | "VUS" | "LB" | "B";

export type InheritanceModel =
  | "de_novo" | "ar_hom" | "comp_het" | "ad_inherited" | "het_inherited"
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
  phylop?: number;
  gerp?: number;
  sift_score?: number;        // LOW = damaging (<0.05 = deleterious)
  polyphen2_hvar?: number;    // HIGH = damaging (>0.957 probably damaging)
  polyphen2_hdiv?: number;    // HIGH = damaging
  mutation_taster?: number;   // HIGH = damaging
  lrt?: number;               // HIGH = damaging
  fathmm?: number;            // LOW = damaging (<-1.5)
  provean?: number;           // LOW = damaging (<-2.5)
  metasvm?: number;           // ensemble; HIGH = damaging
  metalr?: number;            // ensemble; HIGH = damaging
  vest4?: number;             // HIGH = damaging
}

/** Gene-level descriptive metadata, keyed by symbol at the case level. */
export interface GeneInfo {
  symbol: string;
  name?: string;
  summary?: string;
  type_of_gene?: string;
  omim_id?: string;
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

export type Zygosity = "hom_ref" | "het" | "hom_alt" | "missing";

/** The three interchangeable phenotype-ranking algorithms. */
export type PhenotypeAlgorithm = "coverage" | "resnik" | "phrank";

export interface PhenotypeTermContribution {
  hpo_id: string;
  label?: string;
  contribution: number;           // 0..1; contributions sum to percent/100
}

export interface PhenotypeScore {
  percent: number;                // 0..100 — closeness to the case's full phenotype
  matched_terms: PhenotypeTermContribution[];
}

/** Per-variant phenotype relevance under all three ranking algorithms,
 *  precomputed in the engine against the case's HPO terms. */
export interface PhenotypeRelevance {
  coverage: PhenotypeScore;
  resnik: PhenotypeScore;
  phrank: PhenotypeScore;
}

/** One HPO term the variant's gene is associated with in the HPO catalog,
 *  independent of the case phenotype. Surfaced for clinical-utility context
 *  even when phenotype_relevance is empty. */
export interface GenePhenotype {
  hpo_id: string;
  label?: string;
  matches_case: boolean;          // also one of the case's recorded HPO terms
}

export interface MemberCall {
  member_id: string;
  role: string;
  zygosity: Zygosity;
  depth?: number | null;
  allele_balance?: number | null;
  gq?: number | null;
}

export interface VariantRow {
  id: string;
  chrom?: string;
  pos?: number;
  ref?: string;
  alt?: string;
  gene?: string;
  hgvs_c?: string;
  hgvs_p?: string;
  transcript?: string;
  consequence?: string;
  exon?: string;                  // "14/45" — VEP CSQ EXON field
  genomic_hgvs?: string;          // "chr5:g.14363831C>T"
  omim_id?: string;               // OMIM gene * number
  hpo_matches?: string[];         // case HPO ids whose gene-association includes this variant's gene
  phenotype_relevance?: PhenotypeRelevance | null;  // graded HPO proximity under 3 algorithms
  gene_phenotypes?: GenePhenotype[];  // gene's HPO catalog associations (clinical-utility context)
  gene_phenotype_total?: number;      // total HPO associations for the gene (gene_phenotypes is the top slice)
  inheritance_models: InheritanceModel[];
  inheritance_confidence?: "high" | "medium" | "low";
  calls?: MemberCall[];
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
