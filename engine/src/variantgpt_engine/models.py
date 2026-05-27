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
    source: Literal["manual", "llm_confirmed"] = "manual"


InheritanceModel = Literal[
    "de_novo",
    "ar_hom",
    "comp_het",
    "ad_inherited",
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
    alphamissense: Optional[float] = None
    revel: Optional[float] = None
    cadd: Optional[float] = None
    spliceai: Optional[float] = None
    phylop: Optional[float] = None
    gerp: Optional[float] = None


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
    inheritance_models: list[InheritanceModel] = Field(default_factory=list)
    inheritance_confidence: Literal["high", "medium", "low"] = "medium"
    calls: list[MemberCall] = Field(default_factory=list)
    populations: list[PopulationAF] = Field(default_factory=list)
    predictors: PredictorScores = Field(default_factory=PredictorScores)
    clinvar: Optional[ClinVarRecord] = None
    evidence: list[EvidenceItem] = Field(default_factory=list)
    baseline_tier: Optional[Tier] = None
    baseline_points: int = 0
    reclass_tier: Optional[Tier] = None
    reclass_points: Optional[int] = None
    reclass_delta: Optional[int] = None
    priority_score: float = 0.0


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
    variants: list[Variant] = Field(default_factory=list)
    proposals: list[ReclassProposal] = Field(default_factory=list)
    lift_failed: list[dict] = Field(default_factory=list)  # variants that failed liftover
    versions: dict[str, str] = Field(default_factory=dict)  # track + tool versions
