"""AnnotSV parsing + SV inheritance + end-to-end CNV classification tests."""
from __future__ import annotations

from textwrap import dedent

from variantgpt_engine.annotation_sources import annotsv
from variantgpt_engine.models import (
    Affected, MemberCall, Member, Pedigree, Role, Sex,
)
from variantgpt_engine.sv_pipeline import assign_sv_inheritance, classify_svs


# A minimal AnnotSV TSV: one DEL with a full line + two split (gene) lines.
_TSV = dedent("""\
AnnotSV_ID\tSV_chrom\tSV_start\tSV_end\tSV_length\tSV_type\tAnnotation_mode\tGene_name\tHI\tTS\tGnomAD_pLI\tOverlapped_CDS_percent\tB_loss_AFmax
sv_1\t17\t31000000\t31300000\t300000\tDEL\tfull\t\t\t\t\t\t0.0001
sv_1\t17\t31000000\t31300000\t300000\tDEL\tsplit\tNF1\t3\t\t0.99\t100
sv_1\t17\t31000000\t31300000\t300000\tDEL\tsplit\tOMG\t0\t\t0.10\t40
""")


def _trio() -> Pedigree:
    return Pedigree(
        members=[
            Member(id="p", role=Role.proband, sex=Sex.male, affected=Affected.affected),
            Member(id="f", role=Role.father, sex=Sex.male, affected=Affected.unaffected),
            Member(id="m", role=Role.mother, sex=Sex.female, affected=Affected.unaffected),
        ],
        relations=[("f", "p", "parent"), ("m", "p", "parent")],
    )


def test_annotsv_parse_groups_full_and_split(tmp_path):
    p = tmp_path / "annotsv.tsv"
    p.write_text(_TSV, encoding="utf-8")
    svs = annotsv.parse_tsv(p)
    assert len(svs) == 1
    sv = svs[0]
    assert sv.chrom == "17" and sv.start == 31000000 and sv.end == 31300000
    assert sv.sv_type == "DEL" and sv.length == 300000
    assert sv.genes == ["NF1", "OMG"]
    nf1 = next(d for d in sv.dosage_overlaps if d.name == "NF1")
    assert nf1.hi_score == 3 and nf1.pli == 0.99 and nf1.overlap == "full"
    assert sv.populations and sv.populations[0].source == "gnomad_sv"


def test_de_novo_inheritance_from_calls():
    sv = annotsv.parse_rows([
        {"AnnotSV_ID": "sv_1", "SV_chrom": "17", "SV_start": "100", "SV_end": "200",
         "SV_type": "DEL", "Annotation_mode": "full"},
        {"AnnotSV_ID": "sv_1", "SV_chrom": "17", "SV_start": "100", "SV_end": "200",
         "SV_type": "DEL", "Annotation_mode": "split", "Gene_name": "NF1", "HI": "3"},
    ])[0]
    sv.calls = [
        MemberCall(member_id="p", role="proband", zygosity="het"),
        MemberCall(member_id="f", role="father", zygosity="hom_ref"),
        MemberCall(member_id="m", role="mother", zygosity="hom_ref"),
    ]
    assign_sv_inheritance(sv, _trio())
    assert "de_novo" in sv.inheritance_models and sv.inheritance_confidence == "high"


def test_singleton_sv_is_unresolved():
    sv = annotsv.parse_rows([
        {"AnnotSV_ID": "sv_1", "SV_chrom": "17", "SV_start": "100", "SV_end": "200",
         "SV_type": "DEL", "Annotation_mode": "full"},
    ])[0]
    assign_sv_inheritance(sv, _trio())
    assert sv.inheritance_models == ["unresolved"]


def test_end_to_end_classify_de_novo_nf1_deletion(tmp_path):
    p = tmp_path / "annotsv.tsv"
    p.write_text(_TSV, encoding="utf-8")
    svs = annotsv.parse_tsv(p)
    svs[0].calls = [
        MemberCall(member_id="p", role="proband", zygosity="het"),
        MemberCall(member_id="f", role="father", zygosity="hom_ref"),
        MemberCall(member_id="m", role="mother", zygosity="hom_ref"),
    ]
    out = classify_svs(svs, _trio())
    sv = out[0]
    # Established HI gene full overlap (+1.00) + de novo (+0.45) → Pathogenic.
    assert sv.tier == "P" and sv.score >= 0.99
    assert "de_novo" in sv.inheritance_models
