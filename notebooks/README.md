# notebooks/

Colab notebooks (PRD §6.4) for running the engine end-to-end on a case.

- `run_case.ipynb` — install bcftools/CrossMap/VEP-cache, pip-install
  `variantgpt-engine`, mount/upload VCFs, run the CLI, inspect `case.json`,
  push back to R2.

GPU is not required; the CPU/high-RAM runtime is sufficient. `--spliceai-live`
is the only optional GPU path (novel indels absent from precomputed tables).
