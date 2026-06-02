"""ClinVar amino-acid index — parse / build / lookup + PS1/PM5 evaluators.

All pure-logic (no network): the index is built from synthetic _RawRecords so
the residue lookups and the ACMG evaluators are exercised deterministically.
"""
from __future__ import annotations

from variantgpt_engine.acmg.context import (
    augment_context_evidence, evaluate_pm5, evaluate_ps1,
)
from variantgpt_engine.annotation_sources.clinvar_aa import (
    AAChange, _RawRecord, build_index, classification_is_plp,
    parse_protein_change,
)
from variantgpt_engine.models import (
    Affected, Member, Pedigree, Role, Sex, Variant,
)


# ───────────────────────── parse_protein_change ─────────────────────────

def test_parse_three_letter():
    c = parse_protein_change("p.His831Tyr")
    assert c == AAChange(ref="H", pos=831, alt="Y")


def test_parse_parenthesised():
    assert parse_protein_change("p.(Arg175His)") == AAChange(ref="R", pos=175, alt="H")


def test_parse_one_letter():
    assert parse_protein_change("p.R175H") == AAChange(ref="R", pos=175, alt="H")


def test_parse_bare_without_prefix():
    assert parse_protein_change("Gly12Asp") == AAChange(ref="G", pos=12, alt="D")


def test_parse_rejects_nonsense():
    assert parse_protein_change("p.Arg97Ter") is None
    assert parse_protein_change("p.R97*") is None


def test_parse_rejects_synonymous_frameshift_indel():
    assert parse_protein_change("p.(=)") is None
    assert parse_protein_change("p.Arg97fs") is None
    assert parse_protein_change("p.Lys100del") is None
    assert parse_protein_change("p.Ala5_Gly6insLeu") is None


def test_parse_rejects_garbage():
    assert parse_protein_change(None) is None
    assert parse_protein_change("") is None
    assert parse_protein_change("c.123A>T") is None


# ───────────────────────── classification gate ─────────────────────────

def test_classification_gate():
    assert classification_is_plp("Pathogenic")
    assert classification_is_plp("Likely pathogenic")
    assert not classification_is_plp("Benign")
    assert not classification_is_plp("Likely benign")
    assert not classification_is_plp("Conflicting interpretations of pathogenicity")
    assert not classification_is_plp("Uncertain significance")
    assert not classification_is_plp(None)


# ───────────────────────── build_index ─────────────────────────

def _rec(gene, aaref, aapos, aaalt, sig="Pathogenic",
         review="criteria provided, single submitter", source_id="id1"):
    return _RawRecord(
        gene=gene, aaref=aaref, aaalt=aaalt, aapos=aapos,
        significance=sig, review_status=review, source_id=source_id,
    )


def test_build_index_filters_benign_and_low_star():
    recs = [
        _rec("TP53", "Arg", 175, "His"),                                   # kept
        _rec("TP53", "Arg", 248, "Gln", sig="Benign"),                     # dropped (benign)
        _rec("TP53", "Arg", 273, "His", review="no assertion criteria provided"),  # dropped (0★)
    ]
    idx = build_index(recs)
    assert len(idx) == 1
    assert idx.gene_count == 1


def test_build_index_drops_stop_gain_alt():
    idx = build_index([_rec("TP53", "Arg", 175, "Ter")])
    assert len(idx) == 0


def test_index_same_change_and_other_change():
    idx = build_index([
        _rec("TP53", "Arg", 175, "His", source_id="A"),
        _rec("TP53", "Arg", 175, "Cys", source_id="B"),
    ])
    # PS1: query R175H matches established R175H (different source).
    same = idx.same_change("TP53", AAChange("R", 175, "H"))
    assert same is not None and same.change.alt == "H"
    # PM5: query R175P → different change at residue 175 is established.
    other = idx.other_change_at_residue("TP53", AAChange("R", 175, "P"))
    assert other is not None


def test_index_same_change_excludes_self():
    idx = build_index([_rec("TP53", "Arg", 175, "His", source_id="self")])
    assert idx.same_change("TP53", AAChange("R", 175, "H"), exclude_id="self") is None
    assert idx.same_change("TP53", AAChange("R", 175, "H"), exclude_id="other") is not None


def test_index_case_insensitive_gene():
    idx = build_index([_rec("tp53", "Arg", 175, "His")])
    assert idx.same_change("TP53", AAChange("R", 175, "H")) is not None


# ───────────────────────── PS1 / PM5 evaluators ─────────────────────────

def _missense(gene="TP53", hgvs_p="p.Arg175His", pos=7577, ref="G", alt="A"):
    return Variant(
        id=f"{gene}-{pos}", chrom="17", pos=pos, ref=ref, alt=alt, gene=gene,
        consequence="missense_variant", hgvs_p=hgvs_p,
    )


def test_ps1_fires_on_same_change_different_nt():
    idx = build_index([_rec("TP53", "Arg", 175, "His", source_id="other-nt")])
    item = evaluate_ps1(_missense(), idx)
    assert item.fired and item.strength == "S" and item.points == 4


def test_ps1_not_fired_without_anchor():
    idx = build_index([_rec("TP53", "Arg", 175, "Cys", source_id="x")])
    assert not evaluate_ps1(_missense(), idx).fired


def test_ps1_not_fired_on_non_missense():
    idx = build_index([_rec("TP53", "Arg", 175, "His")])
    v = _missense()
    v.consequence = "synonymous_variant"
    assert not evaluate_ps1(v, idx).fired


def test_pm5_fires_on_different_change_at_residue():
    idx = build_index([_rec("TP53", "Arg", 175, "Cys", source_id="x")])
    # query is R175H, established is R175C → PM5
    item = evaluate_pm5(_missense(hgvs_p="p.Arg175His"), idx)
    assert item.fired and item.strength == "M" and item.points == 2


def test_pm5_stands_down_when_ps1_applies():
    # Both same (R175H) and different (R175C) are established; PS1 wins, PM5 off.
    idx = build_index([
        _rec("TP53", "Arg", 175, "His", source_id="a"),
        _rec("TP53", "Arg", 175, "Cys", source_id="b"),
    ])
    assert evaluate_ps1(_missense(), idx).fired
    assert not evaluate_pm5(_missense(), idx).fired


# ───────────────────────── driver integration ─────────────────────────

def _trio() -> Pedigree:
    return Pedigree(
        members=[
            Member(id="p", role=Role.proband, sex=Sex.male, affected=Affected.affected),
            Member(id="f", role=Role.father, sex=Sex.male, affected=Affected.unaffected),
            Member(id="m", role=Role.mother, sex=Sex.female, affected=Affected.unaffected),
        ],
        relations=[("f", "p", "parent"), ("m", "p", "parent")],
    )


def test_augment_wires_ps1_and_retallies():
    idx = build_index([_rec("TP53", "Arg", 175, "His", source_id="other-nt")])
    v = _missense()
    fired = augment_context_evidence([v], _trio(), aa_index=idx)
    assert fired["PS1"] == 1
    ps1 = next(e for e in v.evidence if e.criterion == "PS1")
    assert ps1.fired
    assert v.baseline_points >= 4  # PS1 Strong folded into the re-tally


def test_augment_without_index_leaves_ps1_pm5_unfired():
    v = _missense()
    fired = augment_context_evidence([v], _trio(), aa_index=None)
    assert fired["PS1"] == 0 and fired["PM5"] == 0
