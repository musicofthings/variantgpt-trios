/** Structural / copy-number variants panel for the workbench.
 *
 *  Lists every SV/CNV the engine called + classified under the ClinGen 2019
 *  rubric. Each row expands to its CNV evidence ledger and (when present) the
 *  ClinVar-SV concordance flag. Separate from the SNV table because CNVs use a
 *  different classifier and a different evidence model. */
import { useState } from "react";
import type { StructuralVariantRow } from "../types";
import { TierChip } from "./TierChip";
import { CnvLedger } from "./CnvLedger";
import { ClinVarFlag } from "./ClinVarFlag";

function bp(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mb`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kb`;
  return `${n} bp`;
}

function directionLabel(sv: StructuralVariantRow): string {
  const d = sv.dosage_direction ?? (sv.sv_type === "DEL" ? "loss" : sv.sv_type === "DUP" ? "gain" : null);
  return d === "loss" ? "loss" : d === "gain" ? "gain" : "—";
}

export function StructuralVariantsPanel({ svs }: { svs: StructuralVariantRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!svs || svs.length === 0) return null;

  const plp = svs.filter((s) => s.tier === "P" || s.tier === "LP").length;
  const discordant = svs.filter((s) => s.clinvar_concordance?.status === "discordant").length;

  return (
    <section className="card" style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--rule, #e5e7eb)", flexWrap: "wrap" }}>
        <strong>Structural / copy-number variants</strong>
        <span className="pill" style={{ fontSize: 11 }}>{svs.length} called</span>
        {plp > 0 ? <span className="pill" style={{ fontSize: 11, color: "var(--rust, #b04a2a)" }}>{plp} P/LP</span> : null}
        {discordant > 0 ? <span className="pill" style={{ fontSize: 11, color: "var(--rust, #b04a2a)" }}>{discordant} ClinVar discordant</span> : null}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-soft)" }}>ClinGen/ACMG 2019 (Riggs 2020)</span>
      </header>
      <table className="table" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ width: 24 }} />
            <th style={{ textAlign: "left" }}>Locus</th>
            <th style={{ width: 60 }}>Type</th>
            <th style={{ width: 90 }}>Size</th>
            <th style={{ width: 60 }}>Dosage</th>
            <th style={{ textAlign: "left" }}>Genes</th>
            <th style={{ width: 64 }}>Score</th>
            <th style={{ width: 56 }}>Tier</th>
            <th style={{ textAlign: "left" }}>ClinVar</th>
          </tr>
        </thead>
        <tbody>
          {svs.map((sv) => {
            const isOpen = open === sv.id;
            const genesLabel = sv.genes.length <= 3 ? sv.genes.join(", ") : `${sv.genes.slice(0, 3).join(", ")} +${sv.genes.length - 3}`;
            return (
              <>
                <tr key={sv.id} style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : sv.id)}>
                  <td className="num">{isOpen ? "▾" : "▸"}</td>
                  <td className="mono">{sv.chrom}:{sv.start.toLocaleString()}–{sv.end.toLocaleString()}</td>
                  <td className="mono">{sv.sv_type}</td>
                  <td className="mono">{bp(sv.length ?? sv.end - sv.start)}</td>
                  <td>{directionLabel(sv)}</td>
                  <td className="mono" title={sv.genes.join(", ")} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {genesLabel || "—"}
                  </td>
                  <td className="mono num">{(sv.score > 0 ? "+" : "") + sv.score.toFixed(2)}</td>
                  <td style={{ textAlign: "center" }}>{sv.tier ? <TierChip tier={sv.tier} /> : "—"}</td>
                  <td>
                    <ClinVarFlag concordance={sv.clinvar_concordance} compact />
                    {!sv.clinvar_concordance ? <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>—</span> : null}
                  </td>
                </tr>
                {isOpen ? (
                  <tr>
                    <td colSpan={9} style={{ background: "var(--paper-2, #fafafa)", padding: "12px 16px 16px" }}>
                      <div style={{ display: "grid", gap: 12 }}>
                        <CnvLedger evidence={sv.evidence} score={sv.score} tier={sv.tier} />
                        {sv.clinvar_concordance ? <ClinVarFlag concordance={sv.clinvar_concordance} /> : null}
                        {sv.inheritance_models?.length ? (
                          <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                            Inheritance: {sv.inheritance_models.join(", ")}
                            {sv.inheritance_confidence ? ` (${sv.inheritance_confidence} confidence)` : ""}
                          </div>
                        ) : null}
                        {sv.caller ? <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Caller: {sv.caller}</div> : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
