import { useEffect, useMemo, useRef, useState } from "react";
import { TierChip } from "../components/TierChip";
import { ReclassBadge } from "../components/ReclassBadge";
import { EvidenceLedger } from "../components/EvidenceLedger";
import { PopulationFreqPanel } from "../components/PopulationFreqPanel";
import { PredictorGauges } from "../components/PredictorGauges";
import { RunMonitor, useJobStatus } from "../components/RunMonitor";
import { useNavigate, useParams } from "react-router-dom";
import { useDemoCase } from "../caseData";
import { api } from "../apiBase";
import type { InheritanceModel, Tier, VariantRow } from "../types";

type SortKey = "gene" | "tier" | "consequence" | "af_global" | "af_sas" | "af_indi" | "priority" | "reclass" | null;
type SortDir = "asc" | "desc";

const TIER_RANK: Record<Tier, number> = { P: 0, LP: 1, VUS: 2, LB: 3, B: 4 };

/** Storage key for variant selection per case — survives reloads. */
const SELECTION_KEY = (caseId: string) => `vgpt:selection:${caseId}`;

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
  const navigate = useNavigate();
  const [tab, setTab] = useState<string>("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Tier as a SET so users can multi-select (P + LP simultaneously, etc.).
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set());
  const [geneFilter, setGeneFilter] = useState("");
  const [afMax, setAfMax] = useState(0.5);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { caseId } = useParams<{ caseId: string }>();
  const { data, loading, error } = useDemoCase(caseId);
  const isUploadedCase = !!caseId && caseId !== "demo-trio-001" && caseId !== "demo";
  // Always poll job-status for uploaded cases. If a re-run is in flight even
  // though we have stale case.json, we want to surface a live progress banner
  // and auto-reload when status flips back to ready.
  const job = useJobStatus(isUploadedCase ? caseId : undefined);
  const showMonitor = isUploadedCase && !data && (job?.status !== "ready" || error);
  // Live re-run is in progress when a job exists, isn't terminal, AND we DO
  // have prior case data (otherwise the showMonitor branch covers it).
  const liveRerun = !!data && job?.status === "running";
  const liveQueued = !!data && job?.status === "queued";
  const variants: VariantRow[] = data?.variants ?? (error && !isUploadedCase ? FALLBACK_MOCK : []);
  const caseName = data?.caseRow.name ?? (isUploadedCase ? `Case ${caseId}` : "Demo trio (loading…)");

  // When the live re-run flips from running → ready, fetch the fresh case.json.
  // We can't easily invalidate the useDemoCase cache so we just force a reload.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (job?.status === "running" || job?.status === "queued") {
      wasRunning.current = true;
    } else if (wasRunning.current && job?.status === "ready") {
      wasRunning.current = false;
      // Hard refresh so the stale case.json + cached useDemoCase get re-pulled.
      window.location.reload();
    }
  }, [job?.status]);

  // Selection state — persisted per case so navigating away and back keeps picks.
  const [selectedForReport, setSelectedForReport] = useState<Set<string>>(() => {
    if (!caseId) return new Set();
    try {
      const raw = localStorage.getItem(SELECTION_KEY(caseId));
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    if (!caseId) return;
    try {
      localStorage.setItem(SELECTION_KEY(caseId), JSON.stringify([...selectedForReport]));
    } catch { /* quota or private mode — non-fatal */ }
  }, [selectedForReport, caseId]);

  function toggleSelect(id: string) {
    setSelectedForReport((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllVisible(checked: boolean) {
    setSelectedForReport((prev) => {
      const next = new Set(prev);
      for (const v of visible) { if (checked) next.add(v.id); else next.delete(v.id); }
      return next;
    });
  }
  function clearSelection() { setSelectedForReport(new Set()); }

  // Tier counts for the facet chips (computed from current-tab variants only —
  // tells you "how many P/LP/VUS/etc. exist within the active inheritance tab").
  const tabSpec = TABS.find((t) => t.label === tab) ?? TABS[0];
  const tierCounts = useMemo(() => {
    const counts: Record<Tier, number> = { P: 0, LP: 0, VUS: 0, LB: 0, B: 0 };
    for (const v of variants) {
      if (!tabSpec.match(v)) continue;
      counts[v.baseline_tier] = (counts[v.baseline_tier] ?? 0) + 1;
    }
    return counts;
  }, [variants, tabSpec]);

  const filtered = useMemo(
    () => variants.filter((v) => {
      if (!tabSpec.match(v)) return false;
      if (tierFilter.size > 0 && !tierFilter.has(v.baseline_tier)) return false;
      if (geneFilter && !(v.gene ?? "").toLowerCase().includes(geneFilter.toLowerCase())) return false;
      if ((v.af_global ?? 0) > afMax && (v.af_sas ?? 0) > afMax) return false;
      return true;
    }),
    [tabSpec, tierFilter, geneFilter, afMax, variants],
  );

  // Sort the filtered set. Returns a new array; doesn't mutate `filtered`.
  const visible = useMemo(() => {
    if (!sortKey) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    const get = (v: VariantRow) => {
      switch (sortKey) {
        case "gene": return v.gene ?? "";
        case "tier": return TIER_RANK[v.baseline_tier] ?? 99;
        case "consequence": return v.consequence ?? "";
        case "af_global": return v.af_global ?? -1;
        case "af_sas": return v.af_sas ?? -1;
        case "af_indi": return v.af_indi ?? -1;
        case "priority": return v.priority_score ?? 0;
        case "reclass": return v.reclass ? (v.reclass.delta ?? 0) : 0;
        default: return 0;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = get(a); const vb = get(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: NonNullable<SortKey>) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "gene" || key === "consequence" ? "asc" : "desc");
    }
  }

  const selected = variants.find((v) => v.id === selectedId) ?? null;
  const reclassCount = variants.filter((v) => v.reclass).length;
  const allVisibleSelected = visible.length > 0 && visible.every((v) => selectedForReport.has(v.id));

  if (showMonitor) {
    return (
      <>
        <div className="topbar">
          <h1>{caseName}</h1>
          <span className="pill mono">{caseId}</span>
          <span className="pill">{job?.status ?? "checking…"}</span>
          {/* Re-run uses the existing R2 uploads + persisted manifest — no
              re-upload needed. Always available so the user can recover
              from a hung "running" status (e.g. engine died, callback
              never arrived) without first having to wait for an error. */}
          {caseId ? <RerunButton caseId={caseId} /> : null}
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
        {selectedForReport.size > 0 ? (
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            <strong style={{ color: "var(--ink)" }}>{selectedForReport.size}</strong> selected
            <button onClick={clearSelection} style={{ marginLeft: 6, fontSize: 12 }}>clear</button>
          </span>
        ) : null}
        <button
          className="primary"
          disabled={selectedForReport.size === 0}
          title={selectedForReport.size === 0 ? "Select variants (checkboxes) to include in the report" : ""}
          onClick={() => {
            if (!caseId) return;
            const ids = [...selectedForReport].join(",");
            navigate(`/cases/${caseId}/report?variants=${encodeURIComponent(ids)}`);
          }}
        >
          Generate report{selectedForReport.size > 0 ? ` (${selectedForReport.size})` : ""}
        </button>
      </div>

      {/* Live re-run banner — visible whenever a job is queued/running and
          we already have a prior case.json on screen. Auto-reloads when
          the run completes. */}
      {(liveRerun || liveQueued) ? (
        <LiveRerunBanner status={job} caseId={caseId!} />
      ) : null}

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
        <div className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gap: 14 }}>
          {/* Tier facet: chip-style multi-select with live counts. Click P + LP
              to focus on actionable findings only. */}
          <div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 6 }}>
              Tier (click to include/exclude)
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(["P", "LP", "VUS", "LB", "B"] as Tier[]).map((tier) => {
                const active = tierFilter.has(tier);
                const count = tierCounts[tier];
                return (
                  <button
                    key={tier}
                    onClick={() => {
                      setTierFilter((prev) => {
                        const next = new Set(prev);
                        if (next.has(tier)) next.delete(tier); else next.add(tier);
                        return next;
                      });
                    }}
                    disabled={count === 0}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: "1px solid var(--rule)",
                      background: active ? "var(--primary-soft)" : "var(--paper)",
                      opacity: count === 0 ? 0.4 : 1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: count === 0 ? "default" : "pointer",
                    }}
                  >
                    <TierChip tier={tier} />
                    <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                      {count}
                    </span>
                  </button>
                );
              })}
              {tierFilter.size > 0 ? (
                <button onClick={() => setTierFilter(new Set())} style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                  reset
                </button>
              ) : null}
            </div>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
              Gene
              <input
                value={geneFilter}
                onChange={(e) => setGeneFilter(e.target.value)}
                placeholder="e.g. HBB"
                className="mono"
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
              Max AF (global or SAS): <span className="mono">{afMax.toFixed(3)}</span>
              <input
                type="range"
                min={0}
                max={0.1}
                step={0.001}
                value={afMax}
                onChange={(e) => setAfMax(Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 460px" : "1fr", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                {/* Select-all checkbox for this tab's currently-visible rows. */}
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all visible variants"
                    checked={allVisibleSelected}
                    onChange={(e) => selectAllVisible(e.target.checked)}
                  />
                </th>
                <th className="num">#</th>
                <SortHeader label="Gene" sortKey="gene" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <th>HGVS</th>
                <SortHeader label="Consequence" sortKey="consequence" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <th>Inheritance</th>
                <SortHeader label="AF global" sortKey="af_global" active={sortKey} dir={sortDir} onSort={toggleSort} numeric />
                <SortHeader label="AF SAS" sortKey="af_sas" active={sortKey} dir={sortDir} onSort={toggleSort} numeric />
                <SortHeader label="AF Indi" sortKey="af_indi" active={sortKey} dir={sortDir} onSort={toggleSort} numeric />
                <SortHeader label="Tier" sortKey="tier" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHeader label="Δ" sortKey="reclass" active={sortKey} dir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {visible.map((v, i) => {
                const checked = selectedForReport.has(v.id);
                return (
                  <tr
                    key={v.id}
                    className={v.reclass ? "reclass" : undefined}
                    style={{ cursor: "pointer", background: selectedId === v.id ? "var(--primary-soft)" : undefined }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${v.gene ?? v.id} for report`}
                        checked={checked}
                        onChange={() => toggleSelect(v.id)}
                      />
                    </td>
                    <td className="num" onClick={() => setSelectedId(v.id)}>{i + 1}</td>
                    <td className="mono" onClick={() => setSelectedId(v.id)}>{v.gene}</td>
                    <td className="mono" onClick={() => setSelectedId(v.id)}>
                      {v.hgvs_c}{" "}
                      <span style={{ color: "var(--ink-soft)" }}>{v.hgvs_p}</span>
                    </td>
                    <td onClick={() => setSelectedId(v.id)}>{v.consequence}</td>
                    <td onClick={() => setSelectedId(v.id)}>{v.inheritance_models.map(humanizeModel).join(", ")}</td>
                    <td className="num" onClick={() => setSelectedId(v.id)}>{fmt(v.af_global)}</td>
                    <td className="num" onClick={() => setSelectedId(v.id)}>{fmt(v.af_sas)}</td>
                    <td className="num" onClick={() => setSelectedId(v.id)}>{fmt(v.af_indi)}</td>
                    <td onClick={() => setSelectedId(v.id)}><TierChip tier={v.baseline_tier} /></td>
                    <td onClick={() => setSelectedId(v.id)}>{v.reclass ? <ReclassBadge {...v.reclass} /> : null}</td>
                  </tr>
                );
              })}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ textAlign: "center", color: "var(--ink-soft)", padding: 24 }}>
                    No variants match the current filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Sticky drawer — stays on screen while the user scrolls the long
            variant table. position:sticky with top offset keeps it pinned
            under the topbar. */}
        {selected ? (
          <div style={{ position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
            <Drawer variant={selected} onClose={() => setSelectedId(null)} />
          </div>
        ) : null}
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

/** Live re-run progress banner. Shown above the variant table while a
 *  fresh engine job is in flight on a case that already had results.
 *  The table below stays interactive (you're viewing the previous run);
 *  when the new run finishes, the page auto-refreshes. */
function LiveRerunBanner({
  status, caseId,
}: { status: import("../components/RunMonitor").JobStatus | null; caseId: string }) {
  const [expanded, setExpanded] = useState(false);
  const lastLine = status?.log?.[status.log.length - 1] ?? "starting…";
  const elapsedSec = Math.floor((status?.elapsedMs ?? 0) / 1000);
  const elapsedTxt =
    elapsedSec < 60 ? `${elapsedSec}s`
    : elapsedSec < 3600 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
    : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;

  return (
    <div
      style={{
        marginBottom: 12,
        border: "1px solid var(--accent, #b04a2a)",
        borderRadius: 6,
        background: "rgba(180,84,30,0.04)",
        padding: "10px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-block", width: 10, height: 10, borderRadius: "50%",
          background: "var(--accent, #b04a2a)",
          animation: "pulse 1.5s infinite",
        }} />
        <strong>Re-run in progress</strong>
        <span className="pill mono">{status?.status ?? "queued"}</span>
        <span className="mono" style={{ color: "var(--ink-soft)", fontSize: 12 }}>
          {elapsedTxt} elapsed
        </span>
        <span style={{ flex: 1, color: "var(--ink-soft)", fontSize: 13, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {lastLine}
        </span>
        <button onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Hide log ▾" : "Show log ▸"}
        </button>
      </div>
      {expanded ? (
        <pre
          className="mono"
          style={{
            marginTop: 10, marginBottom: 0, padding: 10,
            background: "var(--paper-soft, #f6f1e6)",
            borderRadius: 4, fontSize: 12, lineHeight: 1.5,
            maxHeight: 280, overflowY: "auto",
          }}
        >
          {status?.log?.length ? status.log.join("\n") : "Waiting for engine output…"}
        </pre>
      ) : null}
      <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-soft)" }}>
        Viewing the previous run's results below. The table will refresh
        automatically when the new run completes — or you can{" "}
        <a href={`/cases/${caseId}`} onClick={(e) => { e.preventDefault(); window.location.reload(); }}>
          refresh manually
        </a>.
      </div>
    </div>
  );
}

/** Sortable column header. Click toggles direction; clicking a different
 * column makes that one active (default direction depends on the field). */
function SortHeader({
  label, sortKey, active, dir, onSort, numeric,
}: {
  label: string;
  sortKey: NonNullable<SortKey>;
  active: SortKey;
  dir: SortDir;
  onSort: (k: NonNullable<SortKey>) => void;
  numeric?: boolean;
}) {
  const isActive = active === sortKey;
  const arrow = isActive ? (dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th
      className={numeric ? "num" : ""}
      onClick={() => onSort(sortKey)}
      style={{ cursor: "pointer", userSelect: "none" }}
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      <span className="mono" style={{ color: "var(--ink-soft)", fontSize: 10 }}>{arrow}</span>
    </th>
  );
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
