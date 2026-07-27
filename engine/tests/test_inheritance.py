"""Direct unit tests for `assign_models` (PRD §4.3) — previously only
exercised indirectly inside test_pipeline_e2e.py with a full-trio pedigree.
Covers the new sibling-duo path (proband + one sibling, no parent sequenced)
and the absent-parent duo de novo path, neither of which had direct coverage."""
from __future__ import annotations

from variantgpt_engine.inheritance import assign_models
from variantgpt_engine.joint import JointVariant
from variantgpt_engine.models import Affected, Member, Pedigree, Role, Sex


def _variant(genotypes: dict[str, int], **quality: dict[str, dict]) -> JointVariant:
    depths = quality.get("depths", {})
    gq = quality.get("gq", {})
    ab = quality.get("ab", {})
    return JointVariant(
        chrom="1", pos=12345, ref="A", alt="G",
        genotypes=genotypes, depths=depths, gq=gq, allele_balance=ab,
    )


def _member(mid: str, role: Role, affected: Affected, sex: Sex = Sex.unknown) -> Member:
    return Member(id=mid, role=role, sex=sex, affected=affected, sample_name=mid)


# ───────────────────────── sibling-duo: affected sibling supports ─────────────────────────

def test_sibling_duo_affected_sibling_sharing_het_tags_het_inherited() -> None:
    """Proband + one affected sibling, no parent sequenced. Neither parent-keyed
    branch can explain a shared het candidate; without sibling-awareness this
    falls through to 'unresolved' even though the affected sibling sharing the
    genotype is real evidence."""
    pedigree = Pedigree(
        members=[
            _member("proband", Role.proband, Affected.affected),
            _member("sib-1", Role.sibling, Affected.affected),
        ],
        relations=[("sib-1", "proband", "sib")],
    )
    variant = _variant({"proband": 1, "sib-1": 1})
    models, confidence = assign_models(variant, pedigree)
    assert "het_inherited" in models
    assert "unresolved" not in models
    assert confidence == "medium"


def test_sibling_duo_unaffected_sibling_not_carrying_variant_is_not_supportive() -> None:
    """An unaffected sibling who is hom-ref at the site contributes nothing —
    confirm the sibling branch doesn't spuriously fire off an unaffected sib."""
    pedigree = Pedigree(
        members=[
            _member("proband", Role.proband, Affected.affected),
            _member("sib-1", Role.sibling, Affected.unaffected),
        ],
        relations=[("sib-1", "proband", "sib")],
    )
    variant = _variant({"proband": 1, "sib-1": 0})
    models, _confidence = assign_models(variant, pedigree)
    assert models == ["unresolved"]


# ───────────────────────── sibling-duo: unaffected sibling rules out ─────────────────────────

def test_sibling_duo_unaffected_sibling_shares_ar_hom_downgrades_confidence() -> None:
    """A healthy full sib carrying the same homozygous genotype as the
    affected proband argues against full penetrance — ar_hom is still
    reported (it's a real Mendelian pattern) but confidence drops to 'low'
    so a curator reviews it, rather than defaulting to 'high'."""
    pedigree = Pedigree(
        members=[
            _member("proband", Role.proband, Affected.affected),
            _member("sib-1", Role.sibling, Affected.unaffected),
        ],
        relations=[("sib-1", "proband", "sib")],
    )
    variant = _variant({"proband": 2, "sib-1": 2})
    models, confidence = assign_models(variant, pedigree)
    assert "ar_hom" in models
    assert confidence == "low"


def test_sibling_duo_unaffected_sibling_not_hom_alt_keeps_ar_hom_confidence_high() -> None:
    """Control for the case above: an unaffected sib who is NOT hom-alt at the
    site (e.g. a carrier or non-carrier) doesn't contradict penetrance, so
    ar_hom's confidence stays at the default."""
    pedigree = Pedigree(
        members=[
            _member("proband", Role.proband, Affected.affected),
            _member("sib-1", Role.sibling, Affected.unaffected),
        ],
        relations=[("sib-1", "proband", "sib")],
    )
    variant = _variant({"proband": 2, "sib-1": 0})
    models, confidence = assign_models(variant, pedigree)
    assert "ar_hom" in models
    assert confidence == "high"


# ───────────────────────── absent-parent duo de novo (also previously untested) ─────────────────────────

def test_duo_absent_father_de_novo_via_present_mother() -> None:
    """Parent-based duo: mother present and confidently 0/0, father not
    sequenced at all (absent from the pedigree, not just missing genotype).
    De novo should still fire, capped at 'medium' confidence (PM6, not PS2 —
    CLAUDE.md's pedigree-modes note: 'duo only calls de novo where the
    present parent is 0/0')."""
    pedigree = Pedigree(
        members=[
            _member("proband", Role.proband, Affected.affected),
            _member("mother", Role.mother, Affected.unaffected, Sex.female),
        ],
        relations=[("mother", "proband", "parent")],
    )
    variant = _variant(
        {"proband": 1, "mother": 0},
        depths={"proband": 40, "mother": 40},
        gq={"proband": 40, "mother": 40},
        ab={"proband": 0.5, "mother": 0.0},
    )
    models, confidence = assign_models(variant, pedigree)
    assert "de_novo" in models
    assert confidence == "medium"


def test_duo_mother_carries_variant_blocks_de_novo() -> None:
    """Control: if the present parent also carries the variant, de novo must
    not fire (Mendelian-consistent inheritance instead)."""
    pedigree = Pedigree(
        members=[
            _member("proband", Role.proband, Affected.affected),
            _member("mother", Role.mother, Affected.unaffected, Sex.female),
        ],
        relations=[("mother", "proband", "parent")],
    )
    variant = _variant(
        {"proband": 1, "mother": 1},
        depths={"proband": 40, "mother": 40},
        gq={"proband": 40, "mother": 40},
        ab={"proband": 0.5, "mother": 0.5},
    )
    models, _confidence = assign_models(variant, pedigree)
    assert "de_novo" not in models


# ───────────────────────── trio regression: sibling data doesn't leak into parent-keyed logic ─────────────────────────

def test_trio_with_extra_sibling_still_resolves_parent_keyed_ar_hom() -> None:
    """A full trio plus an extra sibling member must still resolve ar_hom from
    the parents as before — sibling-awareness is additive, not a replacement
    for the parent-keyed branches."""
    pedigree = Pedigree(
        members=[
            _member("proband", Role.proband, Affected.affected),
            _member("father", Role.father, Affected.unaffected, Sex.male),
            _member("mother", Role.mother, Affected.unaffected, Sex.female),
            _member("sib-1", Role.sibling, Affected.unaffected),
        ],
        relations=[
            ("father", "proband", "parent"),
            ("mother", "proband", "parent"),
            ("sib-1", "proband", "sib"),
        ],
    )
    variant = _variant({"proband": 2, "father": 1, "mother": 1, "sib-1": 0})
    models, confidence = assign_models(variant, pedigree)
    assert "ar_hom" in models
    assert confidence == "high"
