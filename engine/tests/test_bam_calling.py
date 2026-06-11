"""BAM-ingestion smoke test (GATK best-practices calling).

GATK is not installed in CI, so we stub the binary: `shutil.which` is forced to
report it present and `subprocess.run` is replaced with a recorder that creates
the `-O` output file each GATK step declares. This exercises the real
orchestration in bam_calling (command sequence, BQSR gating, the
BAM→GVCF→VCF chain, and call_all's role→VCF contract) plus run_case's BAM
routing guards — everything except the external binary itself, which only runs
on the deployed engine image.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from variantgpt_engine import bam_calling, sv_calling
from variantgpt_engine.models import Member, Pedigree, Role, Sex, Affected


def _install_fake_gatk(monkeypatch) -> list[list[str]]:
    """Make GATK 'present' and turn subprocess.run into a recorder that touches
    whatever path follows each '-O' flag. Returns the list of recorded argv."""
    calls: list[list[str]] = []

    def fake_run(cmd, check=False, **kw):  # noqa: ARG001
        calls.append(list(cmd))
        if "-O" in cmd:
            out = Path(cmd[cmd.index("-O") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"")  # placeholder artifact; content not parsed here
        class _R:  # minimal CompletedProcess stand-in
            returncode = 0
        return _R()

    monkeypatch.setattr(bam_calling.shutil, "which", lambda _t: "/usr/bin/gatk")
    monkeypatch.setattr(bam_calling.subprocess, "run", fake_run)
    return calls


def _gatk_tools(calls: list[list[str]]) -> list[str]:
    """The GATK subcommand from each recorded argv (cmd[1] after 'gatk')."""
    return [c[1] for c in calls if len(c) > 1 and c[0] == "gatk"]


def test_call_sample_vcf_runs_full_sequence_without_bqsr(tmp_path, monkeypatch):
    calls = _install_fake_gatk(monkeypatch)
    bam = tmp_path / "proband.bam"; bam.write_bytes(b"")
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")

    vcf = bam_calling.call_sample_vcf(bam, ref, tmp_path / "work", sample_id="proband")

    tools = _gatk_tools(calls)
    # No known-sites → BQSR is skipped, but the rest of the chain runs in order.
    assert tools == ["MarkDuplicates", "HaplotypeCaller", "GenotypeGVCFs"]
    assert "BaseRecalibrator" not in tools
    # HaplotypeCaller must emit a GVCF (-ERC GVCF).
    hc = next(c for c in calls if c[1] == "HaplotypeCaller")
    assert "-ERC" in hc and hc[hc.index("-ERC") + 1] == "GVCF"
    assert vcf.exists() and vcf.name == "proband.vcf.gz"


def test_call_sample_vcf_runs_bqsr_when_known_sites_supplied(tmp_path, monkeypatch):
    calls = _install_fake_gatk(monkeypatch)
    bam = tmp_path / "p.bam"; bam.write_bytes(b"")
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")
    ks = tmp_path / "dbsnp.vcf.gz"; ks.write_bytes(b"")

    bam_calling.call_sample_vcf(bam, ref, tmp_path / "work", sample_id="p", known_sites=[ks])

    tools = _gatk_tools(calls)
    assert tools == ["MarkDuplicates", "BaseRecalibrator", "ApplyBQSR", "HaplotypeCaller", "GenotypeGVCFs"]
    br = next(c for c in calls if c[1] == "BaseRecalibrator")
    assert "--known-sites" in br and str(ks) in br


def test_call_all_returns_one_vcf_per_role(tmp_path, monkeypatch):
    _install_fake_gatk(monkeypatch)
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")
    bams = {}
    for role in ("proband", "father", "mother"):
        b = tmp_path / f"{role}.bam"; b.write_bytes(b""); bams[role] = b

    out = bam_calling.call_all(bams, ref, tmp_path / "work")

    assert set(out) == {"proband", "father", "mother"}
    assert all(p.exists() and p.suffix == ".gz" for p in out.values())


def test_require_raises_when_gatk_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(bam_calling.shutil, "which", lambda _t: None)
    with pytest.raises(RuntimeError, match="gatk not on PATH"):
        bam_calling.call_sample_vcf(tmp_path / "x.bam", tmp_path / "r.fasta", tmp_path / "w", sample_id="x")


# ───────────────────────── run_case BAM routing guards ─────────────────────────

def _ped() -> Pedigree:
    return Pedigree(members=[Member(id="p", role=Role.proband, sex=Sex.male, affected=Affected.affected)])


def test_run_case_bam_without_reference_errors():
    from variantgpt_engine.pipeline import run_case
    with pytest.raises(ValueError, match="reference"):
        run_case("c1", _ped(), bam_paths={"p": Path("p.bam")}, hpo_ids=[])


def test_run_case_requires_some_input():
    from variantgpt_engine.pipeline import run_case
    with pytest.raises(ValueError, match="vcf_paths, bam_paths, or fastq_paths"):
        run_case("c1", _ped(), hpo_ids=[])


# ───────────────────────── FASTQ → BAM alignment ─────────────────────────

def _install_fake_reads(monkeypatch):
    """Stub bwa + samtools + gatk: record argv, create `-O`/sort `-o` outputs.
    Also stubs subprocess.Popen for the bwa-mem | samtools-sort pipe."""
    import io
    calls: list[list[str]] = []

    class FakePopen:
        def __init__(self, cmd, stdout=None, **kw):
            calls.append(list(cmd))
            self.stdout = io.BytesIO(b"")

        def wait(self):
            return 0

    def fake_run(cmd, check=False, stdin=None, **kw):  # noqa: ARG001
        calls.append(list(cmd))
        if cmd[0] == "samtools" and len(cmd) > 1 and cmd[1] == "sort" and "-o" in cmd:
            out = Path(cmd[cmd.index("-o") + 1]); out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(b"")
        if "-O" in cmd:
            out = Path(cmd[cmd.index("-O") + 1])
            if out.suffix:
                out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(b"")
            else:
                out.mkdir(parents=True, exist_ok=True)
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(bam_calling.shutil, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(bam_calling.subprocess, "run", fake_run)
    monkeypatch.setattr(bam_calling.subprocess, "Popen", FakePopen)
    return calls


def test_align_fastq_paired_end(tmp_path, monkeypatch):
    calls = _install_fake_reads(monkeypatch)
    r1 = tmp_path / "p_R1.fastq.gz"; r1.write_bytes(b"")
    r2 = tmp_path / "p_R2.fastq.gz"; r2.write_bytes(b"")
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")

    bam = bam_calling.align_fastq(r1, ref, tmp_path / "p.sorted.bam", sample_id="p", fastq_r2=r2)

    bwa = next(c for c in calls if c[0] == "bwa" and c[1] == "mem")
    assert "-R" in bwa and "@RG" in bwa[bwa.index("-R") + 1] and "SM:p" in bwa[bwa.index("-R") + 1]
    assert str(r1) in bwa and str(r2) in bwa  # paired-end: both FASTQs
    assert any(c[0] == "samtools" and c[1] == "sort" for c in calls)
    assert any(c[0] == "samtools" and c[1] == "index" for c in calls)
    assert bam.exists()


def test_align_fastq_single_end_omits_r2(tmp_path, monkeypatch):
    calls = _install_fake_reads(monkeypatch)
    r1 = tmp_path / "p.fastq.gz"; r1.write_bytes(b"")
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")
    bam_calling.align_fastq(r1, ref, tmp_path / "p.sorted.bam", sample_id="p")
    bwa = next(c for c in calls if c[0] == "bwa")
    # exactly one FASTQ positional (single-end)
    assert sum(1 for tok in bwa if tok.endswith(".fastq.gz")) == 1


def test_call_sample_vcf_from_fastq_chains_align_then_gatk(tmp_path, monkeypatch):
    calls = _install_fake_reads(monkeypatch)
    r1 = tmp_path / "p_R1.fastq.gz"; r1.write_bytes(b"")
    r2 = tmp_path / "p_R2.fastq.gz"; r2.write_bytes(b"")
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")

    vcf = bam_calling.call_sample_vcf_from_fastq(
        r1, ref, tmp_path / "work", sample_id="p", fastq_r2=r2,
    )
    tools = [c[1] if c[0] == "gatk" else c[0] for c in calls]
    # alignment first, then the germline calling chain.
    assert tools[0] == "bwa"
    assert "MarkDuplicates" in tools and "HaplotypeCaller" in tools and "GenotypeGVCFs" in tools
    assert vcf.exists() and vcf.name == "p.vcf.gz"


def test_call_all_from_fastq_one_vcf_per_role(tmp_path, monkeypatch):
    _install_fake_reads(monkeypatch)
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")
    fq = {}
    for role in ("proband", "mother"):
        r1 = tmp_path / f"{role}_R1.fq.gz"; r1.write_bytes(b"")
        r2 = tmp_path / f"{role}_R2.fq.gz"; r2.write_bytes(b"")
        fq[role] = (r1, r2)
    out = bam_calling.call_all_from_fastq(fq, ref, tmp_path / "work")
    assert set(out) == {"proband", "mother"} and all(p.exists() for p in out.values())


def test_run_case_fastq_without_reference_errors():
    from variantgpt_engine.pipeline import run_case
    with pytest.raises(ValueError, match="reference"):
        run_case("c1", _ped(), fastq_paths={"p": (Path("p_R1.fq.gz"), Path("p_R2.fq.gz"))}, hpo_ids=[])


# ───────────────────────── gCNV → AnnotSV orchestration ─────────────────────────

def _install_fake_sv_tools(monkeypatch, tmp_path) -> list[list[str]]:
    """Stub gatk + AnnotSV for the SV path. gatk steps create their `-O` output;
    AnnotSV creates its `-outputFile`."""
    calls: list[list[str]] = []

    def fake_run(cmd, check=False, **kw):  # noqa: ARG001
        calls.append(list(cmd))
        if "-O" in cmd:
            # gCNV uses -O for an output *directory*; other steps for a file.
            out = Path(cmd[cmd.index("-O") + 1])
            if out.suffix:
                out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(b"")
            else:
                out.mkdir(parents=True, exist_ok=True)
        for flag in ("--output-genotyped-segments", "--output-genotyped-intervals"):
            if flag in cmd:
                out = Path(cmd[cmd.index(flag) + 1]); out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(b"")
        if cmd and cmd[0] == "AnnotSV" and "-outputFile" in cmd:
            out = Path(cmd[cmd.index("-outputFile") + 1]); out.parent.mkdir(parents=True, exist_ok=True); out.write_text("AnnotSV_ID\n")
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(sv_calling.shutil, "which", lambda _t: f"/usr/bin/{_t}")
    monkeypatch.setattr(sv_calling.subprocess, "run", fake_run)
    return calls


def test_call_svs_from_bam_runs_gcnv_then_annotsv(tmp_path, monkeypatch):
    calls = _install_fake_sv_tools(monkeypatch, tmp_path)
    bam = tmp_path / "proband.bam"; bam.write_bytes(b"")
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")
    intervals = tmp_path / "intervals.interval_list"; intervals.write_bytes(b"")
    ploidy = tmp_path / "ploidy-model"; ploidy.mkdir()
    cnv = tmp_path / "cnv-model"; cnv.mkdir()

    tsv = sv_calling.call_svs_from_bam(
        bam, ref, intervals, ploidy, cnv, tmp_path / "sv", sample_id="proband",
    )

    tools = [c[1] if c[0] == "gatk" else c[0] for c in calls]
    # gCNV CASE chain, then AnnotSV.
    assert tools == [
        "CollectReadCounts", "DetermineGermlineContigPloidy",
        "GermlineCNVCaller", "PostprocessGermlineCNVCalls", "AnnotSV",
    ]
    gcnv = next(c for c in calls if c[1] == "GermlineCNVCaller")
    assert "--run-mode" in gcnv and gcnv[gcnv.index("--run-mode") + 1] == "CASE"
    assert tsv.exists() and tsv.name == "proband.annotsv.tsv"


def test_build_gcnv_pon_runs_cohort_sequence_and_makes_bundle(tmp_path, monkeypatch):
    calls = _install_fake_sv_tools(monkeypatch, tmp_path)
    ref = tmp_path / "ref.fasta"; ref.write_bytes(b"")
    priors = tmp_path / "priors.tsv"; priors.write_bytes(b"")
    normals = []
    for i in range(3):
        b = tmp_path / f"normal_{i}.bam"; b.write_bytes(b""); normals.append(b)

    # The cohort model dirs are created by the stub's -O dir branch, but the
    # *-model subdirs need to exist for make_bundle's tar.add — create them.
    real_run = sv_calling.subprocess.run

    def run_and_make_model(cmd, check=False, **kw):
        r = real_run(cmd, check=check, **kw)
        if cmd[1] == "DetermineGermlineContigPloidy":
            (Path(cmd[cmd.index("-O") + 1]) / "ploidy-model").mkdir(parents=True, exist_ok=True)
            (Path(cmd[cmd.index("-O") + 1]) / "ploidy-calls").mkdir(parents=True, exist_ok=True)
        if cmd[1] == "GermlineCNVCaller":
            (Path(cmd[cmd.index("-O") + 1]) / "cohort-model").mkdir(parents=True, exist_ok=True)
        return r

    monkeypatch.setattr(sv_calling.subprocess, "run", run_and_make_model)

    bundle, filtered = sv_calling.build_gcnv_pon(
        ref, normals, priors, tmp_path / "pon", bin_length=1000, padding=0,
    )

    tools = [c[1] for c in calls if c and c[0] == "gatk"]
    # Preprocess → Annotate → 3× CollectReadCounts → Filter → Ploidy(COHORT) → CNVCaller(COHORT)
    assert tools[:2] == ["PreprocessIntervals", "AnnotateIntervals"]
    assert tools.count("CollectReadCounts") == 3
    assert "FilterIntervals" in tools
    assert tools[-2:] == ["DetermineGermlineContigPloidy", "GermlineCNVCaller"]
    cnv_call = next(c for c in calls if c[1] == "GermlineCNVCaller")
    assert cnv_call[cnv_call.index("--run-mode") + 1] == "COHORT"
    # Bundle is a real tar with the CASE-mode layout.
    import tarfile
    assert bundle.exists() and filtered.name == "filtered.interval_list"
    with tarfile.open(bundle) as tar:
        names = tar.getnames()
    assert "ploidy-model" in names and "cnv-model" in names


def test_build_pon_bundle_round_trips_through_extract(tmp_path, monkeypatch):
    """A bundle made by make_bundle extracts to the dirs CASE mode expects."""
    ploidy = tmp_path / "ploidy-model"; ploidy.mkdir(); (ploidy / "x").write_text("p")
    cnv = tmp_path / "cohort-model"; cnv.mkdir(); (cnv / "y").write_text("c")
    bundle = sv_calling.make_bundle(ploidy, cnv, tmp_path / "b.tgz")
    out = sv_calling.extract_model_bundle(bundle, tmp_path / "ex")
    assert (out / "ploidy-model").is_dir() and (out / "cnv-model").is_dir()


def test_extract_model_bundle_rejects_path_traversal(tmp_path):
    import tarfile, io
    tgz = tmp_path / "evil.tgz"
    with tarfile.open(tgz, "w:gz") as tar:
        data = b"x"
        info = tarfile.TarInfo(name="../escape.txt")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    with pytest.raises(RuntimeError, match="unsafe path"):
        sv_calling.extract_model_bundle(tgz, tmp_path / "out")
