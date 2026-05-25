# Synthetic trio fixture

Hand-crafted minimal VCFs covering the inheritance models the engine must
identify (PRD §4.3). Used by `tests/test_pipeline_e2e.py`.

| Variant         | Proband | Father | Mother | Expected model     |
|-----------------|---------|--------|--------|--------------------|
| chr1:100 A>T    | 0/1     | 0/0    | 0/0    | de_novo            |
| chr2:200 G>C    | 0/1     | 0/1    | 0/0    | comp_het partner 1 |
| chr2:300 C>A    | 0/1     | 0/0    | 0/1    | comp_het partner 2 |
| chr1:500 T>G    | 0/0     | 0/0    | 0/0    | absent (filter out)|

Pedigree: affected proband ▪, unaffected father, unaffected mother.
The comp-het pair is on the same fake gene (assigned in the test).
