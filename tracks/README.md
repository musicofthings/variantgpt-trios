# tracks/

Ingestion scripts for the population-frequency tracks that drive the South
Asian reclassification engine (PRD §4.6, §6.8).

Each script: download → normalize chr naming + coords to GRCh38 → bgzip →
tabix → upload to R2 under `tracks/{source}-{version}/`. The Worker reads
them via HTTP range requests (tabix-over-HTTP) at runtime.

| Source       | License        | Status            |
|--------------|----------------|-------------------|
| IndiGenomes  | Academic-use   | connector planned |
| GenomeAsia   | Academic-use   | connector planned |
| GenomeIndia  | IBDC/FeED gated| connector built, data pending |
| gnomAD v4    | Permissive     | live GraphQL + optional local |
