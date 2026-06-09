"""Typer CLI for the engine — `variantgpt-engine`."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import typer
from rich import print as rprint

from . import __version__
from .pipeline import run_case
from .pedigree import load_ped

app = typer.Typer(add_completion=False, no_args_is_help=True, help="VariantGPT engine.")


@app.command()
def version() -> None:
    """Print engine version."""
    rprint(f"variantgpt-engine [bold]{__version__}[/bold]")


def _parse_role_map(specs: list[str], flag: str) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for spec in specs:
        if "=" not in spec:
            raise typer.BadParameter(f"{flag} must be role=path; got {spec!r}")
        role, path = spec.split("=", 1)
        out[role.strip()] = Path(path)
    return out


@app.command()
def run(
    ped: Path = typer.Option(..., exists=True, help="PED file describing the family."),
    vcf: list[str] = typer.Option(
        [],
        help="Per-member VCF as role=path, e.g. --vcf proband=p.vcf.gz --vcf father=f.vcf.gz",
    ),
    bam: list[str] = typer.Option(
        [],
        help="Per-member aligned BAM/CRAM as role=path. Called with GATK best practices "
             "(needs --reference). Mutually usable with --vcf; BAMs take precedence.",
    ),
    hpo: str = typer.Option("", help="Comma-separated HPO IDs."),
    build: str = typer.Option("auto", help="GRCh37 | GRCh38 | auto."),
    out: Path = typer.Option(Path("case.json"), help="Output case.json path."),
    case_id: Optional[str] = typer.Option(None, help="Case id; defaults to PED basename."),
    reference: Optional[Path] = typer.Option(
        None, help="Reference FASTA — required for BAM calling; also used for bcftools norm."
    ),
    chain: Optional[Path] = typer.Option(None, help="Chain file for GRCh37→GRCh38 liftover."),
    known_sites: list[Path] = typer.Option([], help="Known-sites VCF(s) for BQSR (dbSNP/Mills/1000G)."),
    intervals: Optional[Path] = typer.Option(None, help="Calling intervals (e.g. exome BED)."),
    sv_annotsv: Optional[Path] = typer.Option(None, help="AnnotSV TSV for SV/CNV classification."),
    work_dir: Optional[Path] = typer.Option(None, help="Scratch dir for BAM calling intermediates."),
) -> None:
    """Run the full case pipeline end-to-end (intake → ACMG → reclassification)."""
    if not vcf and not bam:
        raise typer.BadParameter("provide at least one --vcf or --bam")

    vcf_map = _parse_role_map(vcf, "--vcf")
    bam_map = _parse_role_map(bam, "--bam")

    pedigree = load_ped(ped)
    hpo_ids = [h.strip() for h in hpo.split(",") if h.strip()]

    emission = run_case(
        case_id=case_id or ped.stem,
        pedigree=pedigree,
        vcf_paths=vcf_map or None,
        bam_paths=bam_map or None,
        hpo_ids=hpo_ids,
        build=build,
        reference=reference,
        chain=chain,
        known_sites=list(known_sites) or None,
        intervals=intervals,
        sv_annotsv_tsv=sv_annotsv,
        work_dir=work_dir,
    )
    out.write_text(emission.model_dump_json(indent=2))
    rprint(
        f"[green]wrote[/green] {out}  "
        f"variants={len(emission.variants)}  "
        f"svs={len(emission.structural_variants)}  "
        f"proposals={len(emission.proposals)}  "
        f"lift_failed={len(emission.lift_failed)}"
    )


@app.command("build-pon")
def build_pon(
    reference: Path = typer.Option(..., exists=True, help="Reference FASTA (with .fai + .dict)."),
    normal_bam: list[Path] = typer.Option(..., help="Normal-sample BAM(s); repeat the flag per sample."),
    contig_ploidy_priors: Path = typer.Option(..., exists=True, help="GATK contig-ploidy priors TSV."),
    out_dir: Path = typer.Option(Path("gcnv_pon"), help="Output directory for the build."),
    bin_length: int = typer.Option(1000, help="WGS bin length; use 0 for exome/panel."),
    padding: int = typer.Option(0, help="Interval padding; ~250 for exome/panel."),
    targets: Optional[Path] = typer.Option(None, help="Exome/panel target BED/interval_list (omit for WGS)."),
) -> None:
    """Build a gCNV panel-of-normals bundle (run once over normal BAMs).

    Emits gcnv_pon.tgz (ploidy-model + cnv-model) and filtered.interval_list;
    upload both to R2 and set GCNV_MODEL_TGZ_KEY / GCNV_INTERVALS_KEY on the Worker.
    """
    from .sv_calling import build_gcnv_pon

    bundle, filtered = build_gcnv_pon(
        reference, list(normal_bam), contig_ploidy_priors, out_dir,
        bin_length=bin_length, padding=padding, targets=targets,
    )
    rprint(f"[green]PON built[/green]  bundle={bundle}  intervals={filtered}")


if __name__ == "__main__":
    app()
