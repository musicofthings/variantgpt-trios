import { describe, expect, it } from "vitest";
import { buildReportHtml, esc, type ReportEmission } from "./report";

function emission(): ReportEmission {
  return {
    case_id: "case-xyz",
    build: "GRCh38",
    pedigree: {
      members: [
        { id: "p", role: "proband", sex: "male", affected: "affected", sample_name: "S1" },
        { id: "f", role: "father", sex: "male", affected: "unaffected" },
      ],
      consanguinity: false,
    },
    hpo: [{ hpo_id: "HP:0001250", label: "Seizure", definition: "A sudden..." }],
    gene_info: { TP53: { symbol: "TP53", name: "tumor protein p53", summary: "Acts as a tumor suppressor." } },
    clinical_history: { text: "Seizures from 6 months.", onset_age: "6 months" },
    variants: [
      {
        id: "v1",
        chrom: "17",
        pos: 7577,
        ref: "G",
        alt: "A",
        gene: "TP53",
        transcript: "NM_000546.6",
        hgvs_c: "c.524G>A",
        hgvs_p: "p.Arg175His",
        consequence: "missense_variant",
        exon: "5/11",
        inheritance_models: ["de_novo"],
        inheritance_confidence: "high",
        baseline_tier: "VUS",
        reclass_tier: "Likely pathogenic",
        reclass_delta: 3,
        priority_score: 9.1,
        populations: [{ source: "gnomad_v4_global", af: 0.0000123, ac: 2, an: 150000 }],
        predictors: { alphamissense: 0.98, revel: 0.9, spliceai: null },
        clinvar: { clinical_significance: "Pathogenic", review_stars: 2, conditions: ["Li-Fraumeni"] },
        evidence: [
          { criterion: "PS1", fired: true, strength: "S", source: "clinvar_aa_index", detail: "same aa change" },
          { criterion: "BP4", fired: false, strength: "BP", source: "predictors", detail: "" },
        ],
        calls: [{ member_id: "p", role: "proband", zygosity: "het", depth: 45, allele_balance: 0.49, gq: 99 }],
      },
    ],
    versions: { engine: "0.1.0" },
  };
}

describe("esc", () => {
  it("escapes html metacharacters", () => {
    expect(esc('<b>"x" & y>')).toBe("&lt;b&gt;&quot;x&quot; &amp; y&gt;");
  });
  it("renders nullish as empty string", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

describe("buildReportHtml", () => {
  it("produces a complete HTML document", () => {
    const html = buildReportHtml(emission());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("VariantGPT Clinical Report");
    expect(html).toContain("case-xyz");
  });

  it("renders patient details and HPO terms", () => {
    const html = buildReportHtml(emission());
    expect(html).toContain("Seizure");
    expect(html).toContain("HP:0001250");
    expect(html).toContain("Seizures from 6 months.");
  });

  it("renders only fired ACMG evidence", () => {
    const html = buildReportHtml(emission());
    expect(html).toContain("PS1");
    expect(html).toContain("Strong"); // PS1 strength label
    expect(html).not.toContain("BP4"); // not fired → dropped
  });

  it("shows the reclassification block and gene prose", () => {
    const html = buildReportHtml(emission());
    expect(html).toContain("Likely pathogenic");
    expect(html).toContain("Acts as a tumor suppressor.");
  });

  it("honors an explicit variant selection (empty → no detail pages)", () => {
    const html = buildReportHtml(emission(), ["does-not-exist"]);
    expect(html).toContain("No variants selected.");
    expect(html).not.toContain("c.524G>A");
  });

  it("includes the selected variant when its id is given", () => {
    const html = buildReportHtml(emission(), ["v1"]);
    expect(html).toContain("c.524G&gt;A");
    expect(html).toContain("Li-Fraumeni");
  });
});
