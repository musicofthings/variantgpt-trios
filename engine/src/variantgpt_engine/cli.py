"""Typer CLI for the engine — `variantgpt-engine`."""
from __future__ import annotations

import json
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


@app.command()
def run(
    ped: Path = typer.Option(..., exists=True, help="PED file describing the family."),
    vcf: list[str] = typer.Option(
        ...,
        help="Per-member VCF as role=path, e.g. --vcf proband=p.vcf.gz --vcf father=f.vcf.gz",
    ),
    hpo: str = typer.Option("", help="Comma-separated HPO IDs."),
    build: str = typer.Option("auto", help="GRCh37 | GRCh38 | auto."),
    out: Path = typer.Option(Path("case.json"), help="Output case.json path."),
    case_id: Optional[str] = typer.Option(None, help="Case id; defaults to PED basename."),
    reference: Optional[Path] = typer.Option(
        None, help="Reference FASTA used for bcftools norm (matches the resolved build)."
    ),
    chain: Optional[Path] = typer.Option(None, help="Chain file for GRCh37→GRCh38 liftover."),
) -> None:
    """Run the full case pipeline end-to-end (intake → ACMG → reclassification)."""
    vcf_map: dict[str, Path] = {}
    for spec in vcf:
        if "=" not in spec:
            raise typer.BadParameter(f"--vcf must be role=path; got {spec!r}")
        role, path = spec.split("=", 1)
        vcf_map[role.strip()] = Path(path)

    pedigree = load_ped(ped)
    hpo_ids = [h.strip() for h in hpo.split(",") if h.strip()]

    emission = run_case(
        case_id=case_id or ped.stem,
        pedigree=pedigree,
        vcf_paths=vcf_map,
        hpo_ids=hpo_ids,
        build=build,
        reference=reference,
        chain=chain,
    )
    out.write_text(emission.model_dump_json(indent=2))
    rprint(
        f"[green]wrote[/green] {out}  "
        f"variants={len(emission.variants)}  "
        f"proposals={len(emission.proposals)}  "
        f"lift_failed={len(emission.lift_failed)}"
    )


if __name__ == "__main__":
    app()
