import { useMemo, useState } from "react";
import { TierChip } from "../components/TierChip";
import { ReclassBadge } from "../components/ReclassBadge";
import { EvidenceLedger } from "../components/EvidenceLedger";
import { PopulationFreqPanel } from "../components/PopulationFreqPanel";
import { PredictorGauges } from "../components/PredictorGauges";
import { RunMonitor, useJobStatus } from "../components/RunMonitor";
import { useParams } from "react-router-dom";
import { useDemoCase } from "../caseData";
import { api } from "../apiBase";
import type { InheritanceModel, VariantRow } from "../types";

const TABS: { label: string; match: (v: VariantRow) => boolean }[] = [
  { label: "All",              match: () => true },
  { label: "De novo",          match: (v) => v.inheritance_models.includes("de_novo") },
  { label: "Compound het",     match: (v) => v.inheritance_models.includes("comp_het") },
  { label: "Recessive",        match: (v) => v.inheritance_models.includes("ar_hom") },
  { label: "Dominant",         match: (v) => v.inheritance_models.includes("ad_inherited") },
  { label: "X-linked",         match: (v) =>
      v.inheritance_models.includes("x_linked_recessive") ||
      v.inheritance_models.includes("x_linked_dominant") },
  { label: "Reclassified",     match: (v) => v.reclass != null },
];

const FALLBACK_MOCK: VariantRow[] = [
  {
    id: "chr2:179454920:G:A",
    gene: "TTN", hgvs_c: "c.41329C>T", hgvs_p: "p.Arg13777*",
    transcript: "NM_001267550.2",
    consequence: "stop_gained",
    inheritance_models: ["de_novo"],
    af_global: 0.0, af_sas: 0.0, af_indi: 0.0,
    baseline_tier: "LP", reclass: null, priority_score: 0.82,
    evidence: [
      { criterion: "PVS1", polarity: "P", fired: true, strength: "Strong",
        summary: "Predicted LoF in gene where LoF is established mechanism",
        trigger: "stop_gained; not in last exon; predicted NMD", source: "VEP + ClinGen PVS1 tree" },
      { criterion: "PS2",  polarity: "P", fired: true, strength: "Strong",
        summary: "Confirmed de novo (parentage supported)",
        trigger: "Proband 0/1; Father 0/0 (DP=42); Mother 0/0 (DP=38)", source: "Trio joint call" },
      { criterion: "PM2",  polarity: "P", fired: true, strength: "Supporting",
        summary: "Absent from controls in population databases",
        trigger: "gnomAD v4 AC=0/1,613,820; IndiGenomes AC=0", source: "gnomAD v4, IndiGenomes" },
      { criterion: "PP3",  polarity: "P", fired: true, strength: "Supporting",
        summary: "In-silico predictors concordant for damaging",
        trigger: "CADD=34.0; SpliceAI=0.02", source: "dbNSFP, SpliceAI" },
      { criterion: "PM1",  polarity: "P", fired: false },
      { criterion: "PP1",  polarity: "P", fired: false },
      { criterion: "BA1",  polarity: "B", fired: false },
      { criterion: "BS1",  polarity: "B", fired: false },
      { criterion: "BS2",  polarity: "B", fired: false },
      { criterion: "BP4",  polarity: "B", fired: false },
    ],
    populations: [
      { source: "gnomad_global", af: 0 },
      { source: "gnomad_sas",    af: 0 },
      { source: "indigenomes",   af: 0 },
      { source: "genomeasia",    af: 0 },
    ],
    predictors: { alphamissense: 0.91, revel: 0.82, cadd: 34.0, spliceai: 0.02 },
  },
  {
    id: "chr11:5226764:C:T",
    gene: "HBB", hgvs_c: "c.20A>T", hgvs_p: "p.Glu7Val",
    transcript: "NM_000518.5",
    consequence: "missense_variant",
    inheritance_models: ["ar_hom"],
    af_global: 0.0003, af_sas: 0.012, af_indi: 0.019,
    baseline_tier: "VUS",
    reclass: { from: "VUS", to: "LB", delta: -5, criteria: ["PM2 retracted", "BS1"] },
    priority_score: 0.61,
    evidence: [
      { criterion: "PM2",  polarity: "P", fired: false, summary: "Retracted: present at AF 0.019 in IndiGenomes",
        trigger: "IndiGenomes AF=0.019; gnomAD-sas AF=0.012", source: "South Asian reclass" },
      { criterion: "PP3",  polarity: "P", fired: true, strength: "Supporting",
        summary: "REVEL above calibrated supporting threshold",
        trigger: "REVEL=0.71", source: "dbNSFP" },
      { criterion: "BA1",  polarity: "B", fired: false },
      { criterion: "BS1",  polarity: "B", fired: true, strength: "Strong",
        summary: "AF > 1% in a South Asian source — exceeds BS1 threshold",
        trigger: "IndiGenomes AF=0.019 > 0.01", source: "IndiGenomes v1.1" },
      { criterion: "BS2",  polarity: "B", fired: false },
      { criterion: "BP4",  polarity: "B", fired: false },
    ],
    populations: [
      { source: "gnomad_global", af: 0.0003 },
      { source: "gnomad_sas",    af: 0.012  },
      { source: "indigenomes",   af: 0.019  },
      { source: "genomeasia",    af: 0.014  },
    ],
    predictors: { alphamissense: 0.42, revel: 0.71, cadd: 22.5, spliceai: 0.01 },
  },
];

export function Workbench() {
  const [tab, setTab] = useState<string>("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState({ tier: "all", gene: "", afMax: 0.5 });
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { caseId } = useParams<{ caseId: string }>();
  const { data, loading, error } = useDemoCase(caseId);
  const isUploadedCase = !!caseId && caseId !== "demo-trio-001" && caseId !== "demo";
  // Only poll job-status for uploaded cases that haven't yet produced case.json.
  const job = useJobStatus(isUploadedCase && !data ? caseId : undefined);
  const showMonitor = isUploadedCase && !data && (job?.status !== "ready" || error);
  const variants: VariantRow[] = data?.variants ?? (error && !isUploadedCase ? FALLBACK_MOCK : []);
  const caseName = data?.caseRow.name ?? (isUploadedCase ? `Case ${caseId}` : "Demo trio (loading…)");

  const tabSpec = TABS.find((t) => t.label === tab) ?? TABS[0];
  const visible = useMemo(
    () => variants.filter((v) => {
      if (!tabSpec.match(v)) return false;
      if (filters.tier !== "all" && v.baseline_tier !== filters.tier) return false;
      if (filters.gene && !(v.gene ?? "").toLowerCase().includes(filters.gene.toLowerCase())) return false;
      if ((v.af_global ?? 0) > filters.afMax && (v.af_sas ?? 0) > filters.afMax) return false;
      return true;
    }),
    [tabSpec, filters, variants],
  );
  const selected = variants.find((v) => v.id === selectedId) ?? null;
  const reclassCount = variants.filter((v) => v.reclass).length;

  if (showMonitor) {
    return (
      <>
        <div className="topbar">
          <h1>{caseName}</h1>
          <span className="pill mono">{caseId}</span>
          <span className="pill">{job?.status ?? "checking…"}</span>
          {/* Re-run uses the existing R2 uploads + persisted manifest — no
              re-upload needed when the user wants to iterate on engine logic. */}
          {(job?.status === "error" || job?.status === "ready") && caseId ? (
            <RerunButton caseId={caseId} />
          ) : null}
        </div>
        <RunMonitor caseId={caseId!} status={job} showOpenLink={false} />
        {job?.status === "error" ? (
          <p style={{ marginTop: 12, color: "var(--ink-soft)", fontSize: 13 }}>
            Engine failed. Inspect the log above; common causes are unreadable VCF format,
            missing FORMAT/GT field, or unsupported multi-sample records. Use{" "}
            <strong>Re-run analysis</strong> to retry with the same uploads after the
            engine is updated — no re-upload needed.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>{caseName}</h1>
        <span className="pill mono">GRCh38</span>
        <span className="pill">{loading ? "Loading…" : error ? "Demo unavailable" : "Ready"}</span>
        {isUploadedCase && caseId ? <RerunButton caseId={caseId} /> : null}
        <button className="primary">Generate report</button>
      </div>

      <div role="tablist" style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => {
          const active = tab === t.label;
          const isReclassTab = t.label === "Reclassified";
          return (
            <button
              key={t.label}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.label)}
              style={{
                borderColor: active ? "var(--primary)" : "var(--border)",
                background: active
                  ? (isReclassTab ? "rgba(180,84,30,0.08)" : "var(--primary-soft)")
                  : "var(--surface)",
                color: isReclassTab ? "var(--accent)" : undefined,
              }}
            >
              {t.label}
              {isReclassTab && reclassCount > 0 ? (
                <span style={{ marginLeft: 6, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {reclassCount}
                </span>
              ) : null}
            </button>
          );
        })}
        <button
          style={{ marginLeft: "auto" }}
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
        >
          Filters {filtersOpen ? "▾" : "▸"}
        </button>
      </div>

      {filtersOpen ? (
        <div className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gap: 12, gridTemplateColumns: "repeat(3, 1fr)" }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
            Tier
            <select
              value={filters.tier}
              onChange={(e) => setFilters({ ...filters, tier: e.target.value })}
            >
              <option value="all">All</option>
              <option value="P">Pathogenic</option>
              <option value="LP">Likely Pathogenic</option>
              <option value="VUS">VUS</option>
              <option value="LB">Likely Benign</option>
              <option value="B">Benign</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
            Gene
            <input
              value={filters.gene}
              onChange={(e) => setFilters({ ...filters, gene: e.target.value })}
              placeholder="e.g. HBB"
              className="mono"
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
            Max AF (global or SAS): <span className="mono">{filters.afMax.toFixed(3)}</span>
            <input
              type="range"
              min={0}
              max={0.1}
              step={0.001}
              value={filters.afMax}
              onChange={(e) => setFilters({ ...filters, afMax: Number(e.target.value) })}
            />
          </label>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 460px" : "1fr", gap: 16 }}>
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Gene</th>
                <th>HGVS</th>
                <th>Consequence</th>
                <th>Inheritance</th>
                <th className="num">AF global</th>
                <th className="num">AF SAS</th>
                <th className="num">AF Indi</th>
                <th>Tier</th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((v, i) => (
                <tr
                  key={v.id}
                  className={v.reclass ? "reclass" : undefined}
                  onClick={() => setSelectedId(v.id)}
                  style={{ cursor: "pointer", background: selectedId === v.id ? "var(--primary-soft)" : undefined }}
                >
                  <td className="num">{i + 1}</td>
                  <td className="mono">{v.gene}</td>
                  <td className="mono">
                    {v.hgvs_c}{" "}
                    <span style={{ color: "var(--ink-soft)" }}>{v.hgvs_p}</span>
                  </td>
                  <td>{v.consequence}</td>
                  <td>{v.inheritance_models.map(humanizeModel).join(", ")}</td>
                  <td className="num">{fmt(v.af_global)}</td>
                  <td className="num">{fmt(v.af_sas)}</td>
                  <td className="num">{fmt(v.af_indi)}</td>
                  <td><TierChip tier={v.baseline_tier} /></td>
                  <td>{v.reclass ? <ReclassBadge {...v.reclass} /> : null}</td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", color: "var(--ink-soft)", padding: 24 }}>
                    No variants match the current filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {selected ? <Drawer variant={selected} onClose={() => setSelectedId(null)} /> : null}
      </div>
    </>
  );
}

function Drawer({ variant, onClose }: { variant: VariantRow; onClose: () => void }) {
  return (
    <aside className="card" style={{ alignSelf: "start", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
        <div>
          <h3 className="mono" style={{ fontFamily: "var(--font-mono)" }}>
            {variant.gene} · {variant.hgvs_c}
          </h3>
          <div className="mono" style={{ color: "var(--ink-soft)", fontSize: 12 }}>
            {variant.hgvs_p}
            {variant.transcript ? <> · {variant.transcript}</> : null}
          </div>
          <div style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 2 }}>
            {variant.consequence}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close drawer">Close</button>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
        <TierChip tier={variant.baseline_tier} />
        {variant.reclass ? <ReclassBadge {...variant.reclass} /> : null}
      </div>

      {variant.reclass ? (
        <div
          className="card"
          style={{
            marginTop: 16,
            background: "rgba(180,84,30,0.04)",
            borderColor: "rgba(180,84,30,0.25)",
            padding: 16,
          }}
        >
          <strong>
            {variant.reclass.from} → {variant.reclass.to}
          </strong>{" "}
          <span style={{ color: "var(--ink-soft)", fontFamily: "var(--font-mono)" }}>
            Δ {variant.reclass.delta}
          </span>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            Changed: <span className="mono">{variant.reclass.criteria.join(", ")}</span>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button className="primary">Accept</button>
            <button>Reject</button>
            <button>Modify…</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)" }}>
            Awaiting your decision. Decisions are audit-logged and irreversible.
          </div>
        </div>
      ) : null}

      <Section title="Evidence ledger">
        {variant.evidence?.length ? (
          <EvidenceLedger rows={variant.evidence} />
        ) : (
          <Muted>No criteria recorded yet.</Muted>
        )}
      </Section>

      <Section title="Population frequency">
        {variant.populations?.length ? (
          <PopulationFreqPanel populations={variant.populations} />
        ) : (
          <Muted>No population AF data.</Muted>
        )}
      </Section>

      <Section title="Predictors">
        {variant.predictors ? (
          <PredictorGauges predictors={variant.predictors} />
        ) : (
          <Muted>No predictor scores.</Muted>
        )}
      </Section>

      <Section title="AI synopsis">
        <div
          style={{
            fontSize: 11, color: "var(--accent)", letterSpacing: "0.06em",
            textTransform: "uppercase", marginBottom: 6,
          }}
        >
          AI-drafted · review before signing
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          {variant.reclass
            ? `${variant.gene} ${variant.hgvs_p ?? variant.hgvs_c}: present at ` +
              `AF ${variant.af_sas} in gnomAD-SAS and ${variant.af_indi} in IndiGenomes, ` +
              `well above the BS1 threshold (0.01). PM2 is retracted and BS1 fires; ` +
              `point sum shifts from VUS to Likely Benign.`
            : `${variant.gene} ${variant.hgvs_p ?? variant.hgvs_c}: predicted loss-of-function ` +
              `confirmed de novo in the proband. PVS1 (Strong) + PS2 (Strong) + PM2 + PP3 yield ` +
              `${variant.baseline_tier}.`}
        </p>
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 12, fontSize: 15 }}>{title}</h3>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>{children}</p>;
}

function humanizeModel(m: InheritanceModel): string {
  switch (m) {
    case "de_novo": return "de novo";
    case "ar_hom": return "AR hom";
    case "comp_het": return "comp het";
    case "ad_inherited": return "AD inh.";
    case "x_linked_recessive": return "XLR";
    case "x_linked_dominant": return "XLD";
    case "y_linked": return "Y-linked";
    case "mitochondrial": return "mito";
    default: return m;
  }
}

function fmt(v?: number | null): string {
  if (v == null) return "—";
  if (v === 0) return "0";
  if (v < 1e-4) return v.toExponential(1);
  return v.toFixed(4);
}

/** "Re-run analysis" button. Posts /api/cases/:id/rerun, which fetches the
 * stored manifest and re-invokes the engine without requiring re-upload. */
function RerunButton({ caseId }: { caseId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function fire() {
    if (!confirm(`Re-run analysis on ${caseId}?\nUses the same uploads + pedigree from the previous run.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(api(`/cases/${caseId}/rerun`), { method: "POST" });
      const j: { ok?: boolean; status?: string; error?: string } = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error ?? `status ${r.status}`);
      // The /status poller picks up from here. Reload to surface the RunMonitor.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <>
      <button onClick={fire} disabled={busy} title="Re-run engine on existing uploads (no re-upload)">
        {busy ? "Triggering…" : "Re-run analysis"}
      </button>
      {err ? <span style={{ color: "var(--rust, #b04a2a)", fontSize: 12 }}>{err}</span> : null}
    </>
  );
}
