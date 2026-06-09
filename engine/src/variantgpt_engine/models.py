"""Pydantic models for the engine's data flow.

These mirror the D1 schema in PRD §6.5 and the case.json the engine emits for
the Worker to consume. Keep field names stable — the Worker contract depends
on them.
"""
from __future__ import annotations

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


class Sex(str, Enum):
    male = "male"
    female = "female"
    unknown = "unknown"


class Affected(str, Enum):
    affected = "affected"
    unaffected = "unaffected"
    unknown = "unknown"


class Role(str, Enum):
    proband = "proband"
    father = "father"
    mother = "mother"
    sibling = "sibling"
    relative = "relative"


class Build(str, Enum):
    grch37 = "GRCh37"
    grch38 = "GRCh38"


class Member(BaseModel):
    id: str
    role: Role
    sex: Sex
    affected: Affected
    sample_name: Optional[str] = None
    vcf_path: Optional[str] = None  # local path (engine) or R2 key (Worker view)


class Pedigree(BaseModel):
    members: list[Member]
    consanguinity: bool = False
    relations: list[tuple[str, str, Literal["parent", "sib"]]] = Field(default_factory=list)


class ClinicalHistory(BaseModel):
    text: str
    onset_age: Optional[str] = None
    consanguinity_note: Optional[str] = None
    prior_testing: Optional[str] = None
    family_history: Optional[str] = None


class HPOTerm(BaseModel):
    hpo_id: str  # e.g. "HP:0001250"
    label: Optional[str] = None
    definition: Optional[str] = None  # plain-English description from HPO OBO
    source: Literal["manual", "llm_confirmed"] = "manual"


class GeneInfo(BaseModel):
    """Gene-level descriptive metadata for the report. Fetched from
    mygene.info per case at annotation time, keyed by HGNC symbol on the
    CaseEmission so we don't bloat each variant with redundant gene prose."""
    symbol: str
    name: Optional[str] = None              # "trio Rho guanine nucleotide exchange factor"
    summary: Optional[str] = None           # NCBI Entrez summary — a paragraph of gene function
    type_of_gene: Optional[str] = None      # "protein-coding", "ncRNA", etc.
    omim_id: Optional[str] = None           # *number, same value as Variant.omim_id


InheritanceModel = Literal[
    "de_novo",
    "ar_hom",
    "comp_het",
    "ad_inherited",
    "het_inherited",     # proband heterozygous; transmitted from an unaffected
                         # parent (AR carrier / low-penetrance AD / awaiting a
                         # second hit for comp_het). Most inherited rare hets
                         # land here.
    "x_linked_recessive",
    "x_linked_dominant",
    "y_linked",
    "mitochondrial",
    "unresolved",
]


class PopulationAF(BaseModel):
    source: str  # "gnomad_v4_global", "gnomad_v4_sas", "indigenomes", "genomeasia", "genomeindia"
    ac: Optional[int] = None
    an: Optional[int] = None
    af: Optional[float] = None
    n_hom: Optional[int] = None
    n_het: Optional[int] = None


class PredictorScores(BaseModel):
    """In-silico predictors. All scores are optional — populated from
    dbNSFP via myvariant.info when available. Score conventions:
      - alphamissense:   [0..1] high = damaging   (ClinGen calibrated PP3 at 0.564, BP4 at 0.116)
      - revel:           [0..1] high = damaging   (ClinGen PP3 at 0.644, BP4 at 0.290)
      - cadd:            PHRED-scaled; >20 = top 1% deleterious
      - spliceai:        [0..1] max delta score; >0.5 = high-confidence splice impact
      - phylop:          rankscore (vertebrate); high = conserved
      - gerp:            rejected substitutions; high = conserved
      - sift_score:      [0..1] LOW = damaging (SIFT convention; <0.05 = deleterious)
      - polyphen2_hvar:  [0..1] high = damaging  (>0.957 probably damaging, 0.453-0.957 possibly damaging)
      - polyphen2_hdiv:  [0..1] high = damaging  (training set: disease vs neutral)
      - mutation_taster: [0..1] high = damaging
      - lrt:             [0..1] high = damaging
      - fathmm:          score < -1.5 = damaging (FATHMM convention)
      - provean:         score < -2.5 = damaging (PROVEAN convention)
      - metasvm:         ensemble; score > 0 = damaging
      - metalr:          ensemble [0..1] high = damaging
      - vest4:           [0..1] high = damaging
    Direction (low vs high = damaging) is preserved as-is from dbNSFP so
    the frontend can render each one with its native convention.
    """
    alphamissense: Optional[float] = None
    revel: Optional[float] = None
    cadd: Optional[float] = None
    spliceai: Optional[float] = None
    phylop: Optional[float] = None
    gerp: Optional[float] = None
    sift_score: Optional[float] = None
    polyphen2_hvar: Optional[float] = None
    polyphen2_hdiv: Optional[float] = None
    mutation_taster: Optional[float] = None
    lrt: Optional[float] = None
    fathmm: Optional[float] = None
    provean: Optional[float] = None
    metasvm: Optional[float] = None
    metalr: Optional[float] = None
    vest4: Optional[float] = None


class PhenotypeTermContribution(BaseModel):
    """One case HPO term's contribution to a variant's phenotype-relevance
    score under a given algorithm. `contribution` is that term's share of the
    achieved fraction (0..1); contributions across terms sum to percent/100."""
    hpo_id: str
    label: Optional[str] = None
    contribution: float = 0.0  # 0..1


class PhenotypeScore(BaseModel):
    """A single algorithm's phenotype-relevance verdict for a variant."""
    percent: float = 0.0  # 0..100 — closeness to the case's full phenotype
    matched_terms: list[PhenotypeTermContribution] = Field(default_factory=list)


class GenePhenotype(BaseModel):
    """One HPO term the variant's gene is associated with in the HPO
    consortium genes_to_phenotype catalog — independent of the case's own
    phenotype terms.

    Surfaced so a curator can judge a variant's clinical utility even when
    none of the case's recorded HPO terms overlap the gene (i.e. when
    `phenotype_relevance` is empty). `matches_case` flags terms that also
    appear in the case phenotype, so the UI can highlight the overlap."""
    hpo_id: str
    label: Optional[str] = None
    matches_case: bool = False


class PhenotypeRelevance(BaseModel):
    """Per-variant phenotype relevance under all three ranking algorithms.
    Precomputed in the engine against the case's HPO terms so the Analysis
    Workbench can switch algorithms instantly (display toggle, no recompute).

      - coverage: fraction of case HPO terms the gene is directly associated
                  with (exact genes_to_phenotype match). No ontology needed.
      - resnik:   Resnik best-match-average over the HPO is_a DAG — a gene
                  linked to a parent/child of a case term earns partial credit.
      - phrank:   sum of information content over shared ancestor closure.
    """
    coverage: PhenotypeScore = Field(default_factory=PhenotypeScore)
    resnik: PhenotypeScore = Field(default_factory=PhenotypeScore)
    phrank: PhenotypeScore = Field(default_factory=PhenotypeScore)


CriterionStrength = Literal["VS", "S", "M", "P", "BS", "BP", "BA"]


class EvidenceItem(BaseModel):
    """One ACMG criterion considered for a variant (PRD §4.5)."""
    criterion: str  # "PVS1" | "PS1" | ... | "BP7"
    fired: bool
    strength: Optional[CriterionStrength] = None  # only when fired
    points: int = 0  # signed; +8/+4/+2/+1/-1/-4 etc per Tavtigian transform
    source: str = ""  # e.g. "gnomad_v4_sas", "clinvar", "alphamissense"
    detail: str = ""  # one-line trigger summary for the ledger row


Tier = Literal["P", "LP", "VUS", "LB", "B"]


class ClinVarRecord(BaseModel):
    """ClinVar classification overlay for a single variant.

    `model_config = {"coerce_numbers_to_str": True}` is a defensive measure —
    myvariant.info occasionally returns numeric values where strings are
    expected (e.g. variant_id as int), and we'd rather coerce than crash
    the entire batch. The projection code already does explicit coercion,
    but this is belt-and-suspenders for future drift.
    """
    model_config = {"coerce_numbers_to_str": True}

    rcv_count: Optional[int] = None                    # number of submitter records
    clinical_significance: Optional[str] = None        # "Pathogenic", "Benign", "Conflicting interpretations of pathogenicity", ...
    review_status: Optional[str] = None                # "criteria provided, single submitter" | "...multiple submitters, no conflicts" | "reviewed by expert panel" | "practice guideline"
    review_stars: Optional[int] = None                 # derived 0-4 stars from review_status (4=practice guideline, 3=expert panel, 2=multi no conflict, 1=single, 0=other)
    last_evaluated: Optional[str] = None               # ISO date if any
    conditions: list[str] = Field(default_factory=list)
    variation_id: Optional[str] = None                 # ClinVar Variation accession (e.g. "VCV000017604")


class ClinVarConcordance(BaseModel):
    """Reconciliation between the engine's computed tier and ClinVar's own
    assertion (PRD §4.5). ClinGen SVI retired blanket trust in ClinVar (the old
    PP5/BP6), so this is a *surfacing/curation gate*, not a points injection:
    a high-confidence ClinVar classification that contradicts the engine is
    flagged for the curator, never silently overrides the auto-tier."""
    status: Literal[
        "concordant",      # engine tier agrees with ClinVar direction
        "discordant",      # engine pathogenic vs ClinVar benign (or vice versa), ClinVar high-confidence
        "uninformative",   # ClinVar present but VUS / conflicting / low review stars
    ]
    engine_tier: Optional["Tier"] = None
    clinvar_tier: Optional["Tier"] = None             # ClinVar significance mapped onto our tier scale
    clinvar_significance: Optional[str] = None         # raw ClinVar string
    review_stars: Optional[int] = None
    note: str = ""


class MemberCall(BaseModel):
    """Per-member genotype call summary projected onto the Variant model
    so the clinical drawer can show zygosity / depth / allele balance per
    family member without re-parsing the joint matrix."""
    member_id: str
    role: str                                          # "proband" | "father" | "mother" | ...
    zygosity: Literal["hom_ref", "het", "hom_alt", "missing"] = "missing"
    depth: Optional[int] = None
    allele_balance: Optional[float] = None             # alt / (ref+alt) from FORMAT/AD
    gq: Optional[int] = None


class Variant(BaseModel):
    id: str
    chrom: str
    pos: int
    ref: str
    alt: str
    gene: Optional[str] = None
    transcript: Optional[str] = None  # MANE Select preferred
    hgvs_c: Optional[str] = None
    hgvs_p: Optional[str] = None
    consequence: Optional[str] = None
    exon: Optional[str] = None                         # e.g. "14/45" — VEP CSQ EXON field
    genomic_hgvs: Optional[str] = None                 # e.g. "chr5:g.14363831C>T"
    omim_id: Optional[str] = None                      # OMIM gene id (the * number)
    hpo_matches: list[str] = Field(default_factory=list)  # case HPO ids whose gene-association includes this variant's gene
    phenotype_relevance: Optional[PhenotypeRelevance] = None  # graded proximity under coverage/resnik/phrank
    gene_phenotypes: list[GenePhenotype] = Field(default_factory=list)  # gene's HPO catalog associations (clinical-utility context, may be truncated)
    gene_phenotype_total: int = 0  # total HPO associations for the gene (gene_phenotypes is the top slice)
    inheritance_models: list[InheritanceModel] = Field(default_factory=list)
    inheritance_confidence: Literal["high", "medium", "low"] = "medium"
    calls: list[MemberCall] = Field(default_factory=list)
    populations: list[PopulationAF] = Field(default_factory=list)
    predictors: PredictorScores = Field(default_factory=PredictorScores)
    clinvar: Optional[ClinVarRecord] = None
    clinvar_concordance: Optional[ClinVarConcordance] = None  # engine-vs-ClinVar reconciliation (PRD §4.5)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    baseline_tier: Optional[Tier] = None
    baseline_points: int = 0
    reclass_tier: Optional[Tier] = None
    reclass_points: Optional[int] = None
    reclass_delta: Optional[int] = None
    priority_score: float = 0.0


SVType = Literal["DEL", "DUP", "INV", "INS", "BND", "CNV"]


class DosageRegion(BaseModel):
    """A gene or ClinGen region overlapped by a structural variant, with its
    ClinGen dosage-sensitivity scores. HI/TS scores follow ClinGen's scale:
        3  = sufficient evidence (established)
        2  = emerging evidence
        1  = little evidence
        0  = no evidence
        30 = gene associated with autosomal recessive phenotype
        40 = dosage sensitivity unlikely
    """
    name: str
    kind: Literal["gene", "region"] = "gene"
    hi_score: Optional[int] = None
    ts_score: Optional[int] = None
    pli: Optional[float] = None                                  # gnomAD pLI (predicted HI)
    overlap: Literal["full", "partial"] = "full"                 # SV vs the gene/region span


class CNVEvidenceItem(BaseModel):
    """One ClinGen/ACMG 2019 (Riggs et al. 2020) CNV scoring line. Unlike the
    SNV EvidenceItem (integer Tavtigian points), CNV evidence carries a signed
    fractional score that is summed to the final classification."""
    section: str                                                 # e.g. "1A", "2A", "3B", "5A"
    score: float                                                 # signed contribution
    applied: bool = True
    source: str = ""
    detail: str = ""


class StructuralVariant(BaseModel):
    """A large structural / copy-number variant (PRD §4.x — SV/CNV pipeline).

    Classified by the ClinGen CNV rubric (acmg/cnv.py), NOT the SNV Tavtigian
    engine. Calling follows GATK gCNV best practices; annotation follows
    AnnotSV (gene overlap + ClinGen dosage + gnomAD-SV frequency)."""
    id: str
    chrom: str
    start: int
    end: int
    sv_type: SVType
    length: Optional[int] = None
    copy_number: Optional[int] = None                            # observed CN where called (e.g. 0,1,3)
    dosage_direction: Optional[Literal["loss", "gain"]] = None   # derived from sv_type / copy_number
    genes: list[str] = Field(default_factory=list)               # protein-coding genes wholly/partially involved
    dosage_overlaps: list[DosageRegion] = Field(default_factory=list)
    populations: list[PopulationAF] = Field(default_factory=list)  # gnomAD-SV / DGV
    inheritance_models: list[InheritanceModel] = Field(default_factory=list)
    inheritance_confidence: Literal["high", "medium", "low"] = "medium"
    calls: list[MemberCall] = Field(default_factory=list)
    evidence: list[CNVEvidenceItem] = Field(default_factory=list)
    score: float = 0.0
    tier: Optional["Tier"] = None
    caller: Optional[str] = None                                 # "gatk_gcnv" | "manta" | ...
    clinvar: Optional["ClinVarRecord"] = None                    # ClinVar SV/CNV overlay
    clinvar_concordance: Optional["ClinVarConcordance"] = None   # engine-vs-ClinVar reconciliation


class ReclassProposal(BaseModel):
    variant_id: str
    from_tier: Tier
    to_tier: Tier
    changed_criteria: list[EvidenceItem]
    af_evidence: list[PopulationAF]
    snapshot_versions: dict[str, str]
    status: Literal["pending", "accepted", "rejected", "modified"] = "pending"


class QCMetrics(BaseModel):
    per_sample_call_rate: dict[str, float] = Field(default_factory=dict)
    mean_depth: dict[str, float] = Field(default_factory=dict)
    titv: dict[str, float] = Field(default_factory=dict)
    mendelian_error_rate: Optional[float] = None
    sex_check: dict[str, Sex] = Field(default_factory=dict)
    kinship: dict[tuple[str, str], float] = Field(default_factory=dict)
    contamination_flag: dict[str, bool] = Field(default_factory=dict)


class CaseEmission(BaseModel):
    """The case.json contract between engine and edge."""
    case_id: str
    build: Build
    pedigree: Pedigree
    hpo: list[HPOTerm]
    clinical_history: Optional[ClinicalHistory] = None
    qc: QCMetrics = Field(default_factory=QCMetrics)
    # Per-gene descriptive metadata, keyed by HGNC symbol. Populated once
    # per case (not per variant) so the report can render a "what does this
    # gene do" paragraph without duplicating prose across thousands of rows.
    gene_info: dict[str, GeneInfo] = Field(default_factory=dict)
    variants: list[Variant] = Field(default_factory=list)
    structural_variants: list[StructuralVariant] = Field(default_factory=list)
    proposals: list[ReclassProposal] = Field(default_factory=list)
    lift_failed: list[dict] = Field(default_factory=list)  # variants that failed liftover
    versions: dict[str, str] = Field(default_factory=dict)  # track + tool versions
