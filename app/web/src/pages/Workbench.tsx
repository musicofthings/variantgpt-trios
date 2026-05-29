import { useEffect, useMemo, useState } from "react";
import { TierChip } from "../components/TierChip";
import { ReclassBadge } from "../components/ReclassBadge";
import { EvidenceLedger } from "../components/EvidenceLedger";
import { PopulationFreqPanel } from "../components/PopulationFreqPanel";
import { PredictorGauges } from "../components/PredictorGauges";
import { RunMonitor, useJobStatus } from "../components/RunMonitor";
import { ClinvarAudit } from "../components/ClinvarAudit";
import { useNavigate, useParams } from "react-router-dom";
import { useDemoCase } from "../caseData";
import { api, apiFetch } from "../apiBase";
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
  { label: "Het inherited",    match: (v) => v.inheritance_models.includes("het_inherited") },
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
  // Phenotype focus — when on, hide variants whose gene has no HPO overlap
  // with the case's HPO terms. The pipeline populates v.hpo_matches per
  // variant in container_server.py via hpo_genes.match_gene().
  const [hpoOnly, setHpoOnly] = useState(false);

  const { caseId } = useParams<{ caseId: string }>();
  const { data, loading, error } = useDemoCase(caseId);
  const isUploadedCase = !!caseId && caseId !== "demo-trio-001" && caseId !== "demo";
  // Always poll job-status for uploaded cases. If a re-run is in flight even
  // though we have stale case.json, we want to surface a live progress banner
  // and auto-reload when status flips back to ready.
  const job = useJobStatus(isUploadedCase ? caseId : undefined);
  const showMonitor = isUploadedCase && !data && (job?.status !== "ready" || error);
  const variants: VariantRow[] = data?.variants ?? (error && !isUploadedCase ? FALLBACK_MOCK : []);
  const caseName = data?.caseRow.name ?? (isUploadedCase ? `Case ${caseId}` : "Demo trio (loading…)");

  // Banner is dismissible per-case. Once the user clicks ✕ on the banner
  // for a given case+startedAt, we stop showing it. Returns automatically
  // if a new run starts (different startedAt).
  const dismissKey = caseId ? `vgpt:banner-dismissed:${caseId}` : "";
  const [bannerDismissedAt, setBannerDismissedAt] = useState<number | null>(() => {
    if (!dismissKey) return null;
    const v = localStorage.getItem(dismissKey);
    return v ? Number(v) : null;
  });

  // Track most recent terminal state for this case (used to color the banner
  // appropriately when we land mid-run vs after-the-fact). Always show
  // banner if there's a job with log content, regardless of when we joined.
  const justFinished: "ready" | "error" | null =
    job?.status === "ready" ? "ready"
    : job?.status === "error" ? "error"
    : null;

  // Dismiss state — banner stays hidden until next run starts.
  const isDismissed = bannerDismissedAt !== null
    && job?.startedAt != null
    && bannerDismissedAt >= job.startedAt;

  function dismissBanner() {
    if (!dismissKey || !job?.startedAt) return;
    localStorage.setItem(dismissKey, String(job.startedAt));
    setBannerDismissedAt(job.startedAt);
  }

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

  // Count variants with at least one HPO match — drives the "Phenotype match
  // only" chip's count and disabled state.
  const hpoMatchCount = useMemo(
    () => variants.filter((v) => (v.hpo_matches?.length ?? 0) > 0).length,
    [variants],
  );

  const filtered = useMemo(
    () => variants.filter((v) => {
      if (!tabSpec.match(v)) return false;
      if (tierFilter.size > 0 && !tierFilter.has(v.baseline_tier)) return false;
      if (geneFilter && !(v.gene ?? "").toLowerCase().includes(geneFilter.toLowerCase())) return false;
      if ((v.af_global ?? 0) > afMax && (v.af_sas ?? 0) > afMax) return false;
      if (hpoOnly && (v.hpo_matches?.length ?? 0) === 0) return false;
      return true;
    }),
    [tabSpec, tierFilter, geneFilter, afMax, hpoOnly, variants],
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
        {caseId ? (
          <button
            onClick={() => navigate(`/cases/${caseId}/diff`)}
            title="Compare this case against an external platform's analysis (Franklin / Genoox CSV)"
          >
            Compare with Franklin
          </button>
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

      {/* ClinVar audit — concordance check against ClinVar's ≥2★
          classifications. Hides itself when no audit-eligible variants
          exist. First-line validation tool: tells the curator
          immediately whether our tier calls line up with the
          high-confidence ClinVar consensus, and groups discordances by
          likely cause so divergences from Franklin / other platforms
          have an objective reference. */}
      <ClinvarAudit
        variants={variants}
        onSelectVariant={(id) => setSelectedId(id)}
      />

      {/* Pipeline-capability banner — explicit for singleton/duo modes so
          curators see why some criteria are weaker than they'd be in a
          full trio. Trio (default) shows no banner; extended pedigrees
          surface a neutral "additional members" note. */}
      {data?.pipeline_mode && data.pipeline_mode !== "trio" ? (
        <PipelineModeBanner mode={data.pipeline_mode} roles={data.member_roles} />
      ) : null}

      {/* Run banner — visible for any job state (running / queued / ready /
          error) as long as we have job data AND the user hasn't dismissed
          this run's banner. Lets the user inspect the engine log even when
          they arrive after the run completed. */}
      {job && (job.log?.length ?? 0) > 0 && !isDismissed ? (
        <LiveRerunBanner
          status={job}
          caseId={caseId!}
          finished={justFinished}
          onDismiss={dismissBanner}
        />
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

          {/* Phenotype focus — filter to variants whose gene has at least one
              HPO term in common with the case's HPO list. Disabled if no
              variants in the case have HPO matches (e.g. case had no HPO
              terms, or HPO catalog failed to download on the engine). */}
          <div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 6 }}>
              Phenotype
            </div>
            <button
              onClick={() => setHpoOnly((x) => !x)}
              disabled={hpoMatchCount === 0}
              title={hpoMatchCount === 0
                ? "No variants in this case have HPO gene matches. Add HPO terms in Intake and re-run, or ensure the engine could reach the HPO catalog."
                : "Show only variants whose gene is associated with at least one case HPO term"}
              style={{
                padding: "4px 12px",
                borderRadius: 999,
                border: "1px solid var(--rule)",
                background: hpoOnly ? "var(--primary-soft)" : "var(--paper)",
                opacity: hpoMatchCount === 0 ? 0.4 : 1,
                cursor: hpoMatchCount === 0 ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>Phenotype match only</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                {hpoMatchCount}
              </span>
            </button>
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

      <div className={`workbench-grid ${selected ? "drawer-open" : "no-drawer"}`}>
        <div className="card workbench-table" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table variant-table">
            <thead>
              <tr>
                {/* Select-all checkbox for this tab's currently-visible rows. */}
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all visible variants"
                    title="Select / deselect all visible rows for the report"
                    checked={allVisibleSelected}
                    onChange={(e) => selectAllVisible(e.target.checked)}
                  />
                </th>
                <th className="num col-num">#</th>
                <SortHeader label="Gene" sortKey="gene" active={sortKey} dir={sortDir} onSort={toggleSort} className="col-gene" />
                <th className="col-hgvs" title="HGVS notation — coding (c.) and protein (p.) consequence">HGVS</th>
                <SortHeader label="Consequence" sortKey="consequence" active={sortKey} dir={sortDir} onSort={toggleSort} className="col-cons" />
                <th className="col-inh" title="Trio inheritance model assigned by the engine (de novo, AR hom, comp het, …)">Inheritance</th>
                <SortHeader label={<abbr title="Allele frequency in gnomAD v4 global (exome + genome)">AF global</abbr>}
                  sortKey="af_global" active={sortKey} dir={sortDir} onSort={toggleSort} numeric className="col-af" />
                <SortHeader label={<abbr title="Allele frequency in gnomAD South Asian — informational only; reclassification uses IndiGen instead">AF SAS</abbr>}
                  sortKey="af_sas" active={sortKey} dir={sortDir} onSort={toggleSort} numeric className="col-af col-af-sas" />
                <SortHeader label={<abbr title="Allele frequency in IndiGenomes (IGIB, 1,029 Indian whole genomes) — primary signal for South Asian reclassification">AF Indi</abbr>}
                  sortKey="af_indi" active={sortKey} dir={sortDir} onSort={toggleSort} numeric className="col-af col-af-indi" />
                <SortHeader label="Tier" sortKey="tier" active={sortKey} dir={sortDir} onSort={toggleSort} className="col-tier" />
                <SortHeader label={<abbr title="Δ — points change after South Asian reclassification (negative = more benign)">Δ</abbr>}
                  sortKey="reclass" active={sortKey} dir={sortDir} onSort={toggleSort} className="col-delta" />
              </tr>
            </thead>
            <tbody>
              {visible.map((v, i) => {
                const checked = selectedForReport.has(v.id);
                const hgvsText = `${v.hgvs_c ?? ""}${v.hgvs_p ? ` (${v.hgvs_p})` : ""}`;
                const inheritText = v.inheritance_models.map(humanizeModel).join(", ");
                return (
                  <tr
                    key={v.id}
                    className={v.reclass ? "reclass" : undefined}
                    style={{ cursor: "pointer", background: selectedId === v.id ? "var(--primary-soft)" : undefined }}
                  >
                    <td className="col-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${v.gene ?? v.id} for report`}
                        checked={checked}
                        onChange={() => toggleSelect(v.id)}
                      />
                    </td>
                    <td className="num col-num" onClick={() => setSelectedId(v.id)}>{i + 1}</td>
                    <td className="mono col-gene" onClick={() => setSelectedId(v.id)} title={v.gene}>{v.gene}</td>
                    <td className="mono col-hgvs" onClick={() => setSelectedId(v.id)} title={hgvsText}>
                      {v.hgvs_c}
                      {v.hgvs_p ? <span style={{ color: "var(--ink-soft)" }}> {v.hgvs_p}</span> : null}
                    </td>
                    <td className="col-cons" onClick={() => setSelectedId(v.id)} title={v.consequence ?? undefined}>
                      {abbrevConsequence(v.consequence)}
                    </td>
                    <td className="col-inh" onClick={() => setSelectedId(v.id)} title={inheritText}>{inheritText}</td>
                    <td className="num col-af" onClick={() => setSelectedId(v.id)} title={`gnomAD global: ${v.af_global ?? "—"}`}>{fmt(v.af_global)}</td>
                    <td className="num col-af col-af-sas" onClick={() => setSelectedId(v.id)} title={`gnomAD SAS: ${v.af_sas ?? "—"}`}>{fmt(v.af_sas)}</td>
                    <td className="num col-af col-af-indi" onClick={() => setSelectedId(v.id)} title={`IndiGenomes: ${v.af_indi ?? "—"}`}>{fmt(v.af_indi)}</td>
                    <td className="col-tier" onClick={() => setSelectedId(v.id)}><TierChip tier={v.baseline_tier} /></td>
                    <td className="col-delta" onClick={() => setSelectedId(v.id)}>{v.reclass ? <ReclassBadge {...v.reclass} /> : null}</td>
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

        {/* Drawer — sticky on desktop with own internal scroll; full-screen
            overlay on screens narrower than 900px (handled by the
            .variant-drawer media query in global.css). */}
        {selected ? (
          <Drawer
            variant={selected}
            caseId={caseId}
            hpoTerms={data?.hpo ?? []}
            clinicalHistory={data?.clinical_history ?? null}
            geneInfo={data?.gene_info ?? {}}
            probandMember={data?.proband_member ?? null}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </>
  );
}

function Drawer({
  variant, caseId, hpoTerms, clinicalHistory, geneInfo, probandMember, onClose,
}: {
  variant: VariantRow;
  caseId?: string;
  hpoTerms: import("../caseData").HPOTermRow[];
  clinicalHistory: import("../caseData").ClinicalHistory | null;
  geneInfo: Record<string, import("../caseData").GeneInfoRow>;
  probandMember: { id: string; sex: string; affected: string; sample_name?: string } | null;
  onClose: () => void;
}) {
  return (
    <aside className="card variant-drawer">
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
            {variant.exon ? <> · exon {variant.exon}</> : null}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close drawer">Close</button>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
        <TierChip tier={variant.baseline_tier} />
        {variant.reclass ? <ReclassBadge {...variant.reclass} /> : null}
      </div>

      {/* Clinical variant card — lab-report style fielded summary. Matches the
          Apollo Diagnostics layout (Gene, Variant, Zygosity, Depth, Disease
          (OMIM), Classification with ACMG strength). */}
      <ClinicalCard v={variant} />

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
        <AiSynopsis
          variant={variant}
          caseId={caseId}
          hpoTerms={hpoTerms}
          clinicalHistory={clinicalHistory}
          geneInfo={geneInfo[variant.gene ?? ""] ?? null}
          probandMember={probandMember}
        />
      </Section>
    </aside>
  );
}

/** AI-drafted variant synopsis with a manual generate button.
 *
 *  We deliberately do NOT auto-generate on drawer open — every click costs
 *  an Anthropic API call, and the curator should be the one choosing when
 *  to spend it. Results are cached in localStorage per (caseId, variantId)
 *  so re-opening the drawer recalls the cached text instead of re-prompting.
 */
function AiSynopsis({
  variant, caseId, hpoTerms, clinicalHistory, geneInfo, probandMember,
}: {
  variant: VariantRow;
  caseId?: string;
  hpoTerms: import("../caseData").HPOTermRow[];
  clinicalHistory: import("../caseData").ClinicalHistory | null;
  geneInfo: import("../caseData").GeneInfoRow | null;
  probandMember: { id: string; sex: string; affected: string; sample_name?: string } | null;
}) {
  const cacheKey = caseId ? `vgpt:ai-synopsis:${caseId}:${variant.id}` : "";
  const [synopsis, setSynopsis] = useState<string | null>(() => {
    if (!cacheKey) return null;
    try { return localStorage.getItem(cacheKey); } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true); setErr(null);
    try {
      const resp = await apiFetch(api("/ai/synopsis"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variant: {
            id: variant.id,
            gene: variant.gene,
            hgvs_c: variant.hgvs_c,
            hgvs_p: variant.hgvs_p,
            transcript: variant.transcript,
            consequence: variant.consequence,
            exon: variant.exon,
            inheritance_models: variant.inheritance_models,
            inheritance_confidence: variant.inheritance_confidence,
            baseline_tier: variant.baseline_tier,
            reclass: variant.reclass,
            af_global: variant.af_global,
            af_sas: variant.af_sas,
            af_indi: variant.af_indi,
            hpo_matches: variant.hpo_matches,
            clinvar: variant.clinvar,
            evidence: variant.evidence,
            predictors: variant.predictors,
          },
          case_context: {
            proband: probandMember,
            hpo: hpoTerms,
            clinical_history: clinicalHistory,
            gene_info: geneInfo,
          },
        }),
      });
      const j = await resp.json() as { synopsis?: string; error?: string; model?: string };
      if (!resp.ok || !j.synopsis) {
        throw new Error(j.error ?? `synopsis failed (${resp.status})`);
      }
      setSynopsis(j.synopsis);
      if (cacheKey) {
        try { localStorage.setItem(cacheKey, j.synopsis); } catch { /* quota / private mode */ }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function clearCache() {
    setSynopsis(null); setErr(null);
    if (cacheKey) {
      try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
    }
  }

  return (
    <>
      <div
        style={{
          fontSize: 11, color: "var(--accent)", letterSpacing: "0.06em",
          textTransform: "uppercase", marginBottom: 6,
        }}
      >
        AI-drafted · review before signing
      </div>

      {synopsis ? (
        <>
          <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{synopsis}</p>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button onClick={generate} disabled={busy} title="Regenerate from latest evidence — overwrites the cached draft">
              {busy ? "Regenerating…" : "Regenerate"}
            </button>
            <button onClick={clearCache} disabled={busy} title="Clear the cached draft for this variant">
              Clear
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            Generates a 2–3 paragraph clinical synopsis from this variant's evidence and the
            case's phenotype context. AI-drafted; the curator must review before any signed
            report.
          </p>
          <button
            className="primary"
            onClick={generate}
            disabled={busy}
            style={{ marginTop: 6 }}
          >
            {busy ? "Drafting…" : "Generate synopsis"}
          </button>
        </>
      )}

      {err ? (
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--rust, #b04a2a)" }}>
          {err}
        </p>
      ) : null}
    </>
  );
}

/** Lab-report-style fielded summary at the top of the variant drawer.
 *  Renders the same shape a clinical lab would: gene + transcript on one
 *  side, genomic notation + HGVS on the other, zygosity / depth / AB
 *  per family member in a small table, OMIM gene link, ACMG fired
 *  criteria with strength tokens (PVS1, PM2_M, PP3_Sup, BS1_S, etc.). */
function ClinicalCard({ v }: { v: VariantRow }) {
  // Lab-report style: criterion + underscore + strength abbrev.
  // VS=Very Strong, S=Strong, M=Moderate, P/Sup=Supporting, BA=StandAlone.
  const STRENGTH_TOKEN: Record<string, string> = {
    VeryStrong: "_VS",
    Strong: "_S",
    Moderate: "_M",
    Supporting: "_Sup",
    StandAlone: "_BA",
  };
  const fired = (v.evidence ?? []).filter((e) => e.fired);
  const firedTokens = fired
    .map((e) => `${e.criterion}${e.strength ? STRENGTH_TOKEN[e.strength] ?? "" : ""}`)
    .join(", ");

  // OMIM external link.
  const omimUrl = v.omim_id ? `https://www.omim.org/entry/${v.omim_id}` : null;
  // Gene-level external links.
  const geneUrl = v.gene ? `https://www.genecards.org/cgi-bin/carddisp.pl?gene=${encodeURIComponent(v.gene)}` : null;
  // ClinVar variant link if we have an accession.
  const clinvarUrl = v.clinvar?.variation_id
    ? `https://www.ncbi.nlm.nih.gov/clinvar/variation/${encodeURIComponent(v.clinvar.variation_id.replace(/^VCV0*/, ""))}/`
    : null;

  return (
    <section
      className="card"
      style={{
        marginTop: 16,
        padding: 14,
        background: "var(--paper-soft, #f6f1e6)",
        borderColor: "var(--rule)",
      }}
    >
      <div style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--ink-soft)", textTransform: "uppercase", marginBottom: 10 }}>
        Clinical variant summary
      </div>
      <table style={{ width: "100%", fontSize: 13, lineHeight: 1.5, borderCollapse: "collapse" }}>
        <tbody>
          <DRow label="Gene" value={
            geneUrl ? <a href={geneUrl} target="_blank" rel="noreferrer">{v.gene}</a> : v.gene
          } tipForLabel="Gene symbol assigned by VEP for the canonical (MANE Select) transcript at this position." />
          <DRow label="Transcript" value={v.transcript} mono
            tipForLabel="The MANE Select transcript (RefSeq NM_ accession) — the clinical-standard reference transcript for this gene." />
          <DRow label="Location" value={v.exon ? `Exon ${v.exon}` : null}
            tipForLabel="Exon rank within the transcript, e.g. '14/57' means exon 14 of 57. Empty for intronic / UTR variants." />
          <DRow label="Variant (HGVS)" value={
            <>
              <span className="mono">{v.hgvs_c}</span>
              {v.hgvs_p ? <span className="mono" style={{ color: "var(--ink-soft)" }}> ({v.hgvs_p})</span> : null}
            </>
          } tipForLabel="HGVS nomenclature. c. = coding sequence (mRNA-level), p. = protein consequence (one-letter or three-letter amino acid)." />
          <DRow label="Genomic" value={v.genomic_hgvs} mono
            tipForLabel="HGVS genomic notation (g.) — chromosomal coordinate of the variant. Useful for cross-referencing browsers like UCSC and gnomAD." />
          <DRow label="Consequence" value={v.consequence}
            tipForLabel="Sequence Ontology (SO) consequence term from VEP, e.g. missense_variant, stop_gained, splice_donor_variant." />
          <DRow label="Inheritance" value={
            v.inheritance_models.length
              ? <>
                  {v.inheritance_models.map(humanizeModel).join(", ")}
                  {v.inheritance_confidence ? (
                    <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                      {" "}· {v.inheritance_confidence} confidence
                    </span>
                  ) : null}
                </>
              : null
          } tipForLabel="Inheritance model assigned in this trio: de_novo / ar_hom / comp_het / ad_inherited / x_linked_recessive / x_linked_dominant / mitochondrial. Confidence is set by per-call QC (GQ, DP, allele balance)." />
          <DRow label="OMIM gene" value={
            omimUrl ? <a href={omimUrl} target="_blank" rel="noreferrer">{v.omim_id}</a> : null
          } tipForLabel="OMIM gene * number from mygene.info. Click to open omim.org for the gene-phenotype description." />
          <DRow label="HPO matches" value={
            v.hpo_matches && v.hpo_matches.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {v.hpo_matches.map((hp) => (
                  <a
                    key={hp}
                    href={`https://hpo.jax.org/browse/term/${hp}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                    style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 999,
                      border: "1px solid var(--rule)",
                      background: "var(--primary-soft)",
                      textDecoration: "none",
                    }}
                    title="Open this HPO term on hpo.jax.org"
                  >
                    {hp}
                  </a>
                ))}
              </div>
            ) : null
          } tipForLabel="Case HPO terms whose gene-association catalog (HPO consortium genes_to_phenotype) includes this variant's gene. A match means the patient's phenotype is consistent with known disease associations for this gene." />

          {v.clinvar ? (
            <DRow label="ClinVar" value={
              <>
                {clinvarUrl ? (
                  <a href={clinvarUrl} target="_blank" rel="noreferrer" className="mono">
                    {v.clinvar.variation_id}
                  </a>
                ) : <span className="mono">{v.clinvar.variation_id}</span>}
                {v.clinvar.clinical_significance ? (
                  <> · <strong>{v.clinvar.clinical_significance}</strong></>
                ) : null}
                {v.clinvar.review_stars != null ? (
                  <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                    {" "}({v.clinvar.review_stars}★ {v.clinvar.review_status})
                  </span>
                ) : null}
                {v.clinvar.conditions && v.clinvar.conditions.length > 0 ? (
                  <div style={{ marginTop: 2, fontSize: 12, color: "var(--ink-soft)" }}>
                    {v.clinvar.conditions.slice(0, 3).join(" · ")}
                  </div>
                ) : null}
              </>
            } />
          ) : null}
          <DRow label="ACMG criteria fired" value={
            firedTokens ? <span className="mono" style={{ fontSize: 12 }}>{firedTokens}</span> : <Muted>none</Muted>
          } tipForLabel="ACMG/AMP criteria that fired for this variant, with strength tokens: _VS (Very Strong, +8), _S (Strong, +4), _M (Moderate, +2), _Sup (Supporting, +1), _BA (Stand-alone benign)." />
          <DRow label="Classification" value={
            <>
              <TierChip tier={v.baseline_tier} />
              {v.reclass ? (
                <span style={{ marginLeft: 8 }}><ReclassBadge {...v.reclass} /></span>
              ) : null}
            </>
          } tipForLabel="ACMG tier: P (Pathogenic), LP (Likely Pathogenic), VUS (Uncertain), LB (Likely Benign), B (Benign). The reclass badge shows any change driven by Indian-cohort allele frequency." />
        </tbody>
      </table>

      {/* Per-member call table — zygosity / depth / AB / GQ for the trio. */}
      {v.calls && v.calls.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.06em", color: "var(--ink-soft)", textTransform: "uppercase", marginBottom: 6 }}>
            Family calls
          </div>
          <table style={{ width: "100%", fontSize: 12, lineHeight: 1.4 }} className="table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Role</th>
                <th>Zygosity</th>
                <th className="num">
                  <abbr title="Read depth at the variant position (FORMAT/DP). Higher is more reliable; clinical threshold ≥10x for de novo calls.">Depth</abbr>
                </th>
                <th className="num">
                  <abbr title="Allele balance — alt allele fraction = AD[alt] / (AD[ref] + AD[alt]). For a true heterozygous call expect ~50%; outside 0.20–0.80 suggests artifact.">AB</abbr>
                </th>
                <th className="num">
                  <abbr title="Genotype quality (FORMAT/GQ). Phred-scaled confidence in the called genotype; clinical threshold ≥20 for de novo calls.">GQ</abbr>
                </th>
              </tr>
            </thead>
            <tbody>
              {v.calls.map((c) => (
                <tr key={c.member_id}>
                  <td>{c.role}</td>
                  <td>
                    <ZygosityChip zyg={c.zygosity} />
                  </td>
                  <td className="num">{c.depth ?? "—"}{c.depth ? "x" : ""}</td>
                  <td className="num">
                    {c.allele_balance != null
                      ? `${(c.allele_balance * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                  <td className="num">{c.gq ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function ZygosityChip({ zyg }: { zyg: string }) {
  const labels: Record<string, string> = {
    hom_ref: "Hom Ref",
    het: "Heterozygous",
    hom_alt: "Hom Alt",
    missing: "—",
  };
  const colors: Record<string, string> = {
    hom_ref: "var(--ink-soft)",
    het: "var(--primary)",
    hom_alt: "var(--accent, #b04a2a)",
    missing: "var(--ink-soft)",
  };
  return (
    <span style={{
      fontSize: 11, padding: "2px 7px",
      borderRadius: 999, border: "1px solid var(--rule)",
      background: "var(--paper)",
      color: colors[zyg] ?? "var(--ink)",
    }}>
      {labels[zyg] ?? zyg}
    </span>
  );
}

function DRow({ label, value, mono, tipForLabel }: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tipForLabel?: string;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <tr>
      <td style={{ color: "var(--ink-soft)", fontSize: 12, padding: "3px 12px 3px 0", verticalAlign: "top", whiteSpace: "nowrap" }}>
        {tipForLabel ? <abbr title={tipForLabel}>{label}</abbr> : label}
      </td>
      <td className={mono ? "mono" : ""} style={{ padding: "3px 0", verticalAlign: "top", wordBreak: "break-word" }}>
        {value}
      </td>
    </tr>
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
    case "het_inherited": return "het inh.";
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

/** Re-run banner. Three states:
 *   - running/queued: live progress, last log line ticking, animated dot
 *   - just finished (ready): green dot, "Load new results" button reloads
 *     the page so the new case.json is fetched; the full log stays
 *     inspectable until the user clicks "Dismiss"
 *   - just finished (error): rust-colored, log expanded by default,
 *     no auto-reload (table still shows the previous successful run)
 *
 * The log is now ALWAYS expandable — no more "disappears on completion"
 * gap.
 */
function LiveRerunBanner({
  status, caseId, finished, onDismiss,
}: {
  status: import("../components/RunMonitor").JobStatus | null;
  caseId: string;
  finished: "ready" | "error" | null;
  onDismiss: () => void;
}) {
  // Default to expanded on error so the user sees what failed.
  const [expanded, setExpanded] = useState<boolean>(finished === "error");
  const isRunning = !finished && (status?.status === "running" || status?.status === "queued");
  const lastLine = status?.log?.[status.log.length - 1] ?? "starting…";
  const elapsedSec = Math.floor((status?.elapsedMs ?? 0) / 1000);
  const elapsedTxt =
    elapsedSec < 60 ? `${elapsedSec}s`
    : elapsedSec < 3600 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
    : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;

  const accent =
    finished === "error" ? "var(--rust, #b04a2a)"
    : finished === "ready" ? "var(--success, #2c8462)"
    : "var(--accent, #b04a2a)";
  const bg =
    finished === "error" ? "rgba(180,84,30,0.06)"
    : finished === "ready" ? "rgba(44,132,98,0.06)"
    : "rgba(180,84,30,0.04)";
  const headline =
    finished === "error" ? "Run failed"
    : finished === "ready" ? "Run completed"
    : "Re-run in progress";

  return (
    <div
      style={{
        marginBottom: 12,
        border: `1px solid ${accent}`,
        borderRadius: 6,
        background: bg,
        padding: "10px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-block", width: 10, height: 10, borderRadius: "50%",
          background: accent,
          animation: isRunning ? "pulse 1.5s infinite" : "none",
        }} />
        <strong>{headline}</strong>
        <span className="pill mono">{status?.status ?? "queued"}</span>
        <span className="mono" style={{ color: "var(--ink-soft)", fontSize: 12 }}>
          {elapsedTxt} {finished ? "total" : "elapsed"}
        </span>
        <span style={{ flex: 1, color: "var(--ink-soft)", fontSize: 13, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {lastLine}
        </span>
        <button onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Hide log ▾" : "Show log ▸"}
        </button>
        {finished === "ready" ? (
          <button className="primary" onClick={() => window.location.reload()}>
            Load new results
          </button>
        ) : null}
        {finished ? (
          <button onClick={onDismiss} aria-label="Dismiss banner">×</button>
        ) : null}
      </div>
      {expanded ? (
        <pre
          className="mono"
          style={{
            marginTop: 10, marginBottom: 0, padding: 10,
            background: "var(--paper-soft, #f6f1e6)",
            borderRadius: 4, fontSize: 12, lineHeight: 1.5,
            maxHeight: 400, overflowY: "auto",
          }}
        >
          {status?.log?.length ? status.log.join("\n") : "Waiting for engine output…"}
        </pre>
      ) : null}
      {!finished ? (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-soft)" }}>
          Viewing the previous run's results below. Click <strong>Load new results</strong>
          {" "}when the run completes — or{" "}
          <a href={`/cases/${caseId}`} onClick={(e) => { e.preventDefault(); window.location.reload(); }}>
            refresh manually
          </a>.
        </div>
      ) : finished === "ready" ? (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-soft)" }}>
          New case.json is in R2. Click <strong>Load new results</strong> to view it,
          or keep inspecting the previous run.
        </div>
      ) : (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--rust, #b04a2a)" }}>
          The new run failed. The variant table below still shows the previous
          successful run. Use <strong>Re-run analysis</strong> after fixing whatever
          went wrong.
        </div>
      )}
    </div>
  );
}

/** Pipeline-mode capability banner. Tells the curator which ACMG criteria
 *  and inheritance models silently degrade because not all family members
 *  are present. Renders only for singleton / duo / extended; trio is the
 *  default and shows no banner. */
function PipelineModeBanner({ mode, roles }: {
  mode: "singleton" | "duo" | "trio" | "extended";
  roles: string[];
}) {
  const hasFather = roles.includes("father");
  const hasMother = roles.includes("mother");
  const presentParent = hasFather ? "father" : hasMother ? "mother" : null;

  const label =
    mode === "singleton" ? "Singleton mode"
    : mode === "duo" ? `Duo mode · proband + ${presentParent}`
    : "Extended pedigree";

  const limits: { title: string; detail: string }[] = [];
  if (mode === "singleton") {
    limits.push({
      title: "PS2 (de novo Strong) unavailable",
      detail: "Both parents required to confirm de novo. PM6 (Moderate) is also unavailable without at least one parental 0/0 call.",
    });
    limits.push({
      title: "Compound het is genotype-only",
      detail: "Two hets in the same gene are flagged but cannot be trans-phased without parental segregation; some calls may be cis (single-allele) artifacts.",
    });
    limits.push({
      title: "Het inherited cannot be sourced",
      detail: "Without parents we cannot distinguish inherited hets from de novo singletons; all hets are reported as candidates.",
    });
  } else if (mode === "duo") {
    limits.push({
      title: "PS2 limited to PM6 (Moderate)",
      detail: `De novo can only be claimed at sites the ${presentParent} is confidently 0/0; the missing parent's genotype is assumed reference. PRD §7 caps duo de novo at PM6.`,
    });
    limits.push({
      title: "Trans-phasing is partial",
      detail: `Compound het pairs where one variant is inherited from the missing parent cannot be confirmed; we surface them as candidate comp-het but the trans claim is provisional.`,
    });
  } else if (mode === "extended") {
    limits.push({
      title: "Additional family members detected",
      detail: `Pedigree includes ${roles.filter((r) => !["proband", "father", "mother"].includes(r)).join(", ")}. Inheritance reasoning uses the trio core (proband + parents); additional members contribute to segregation evidence (PP1) when affected status is known.`,
    });
  }

  // Color: rust accent for singleton (most degraded), warm sand for duo,
  // neutral for extended.
  const accent =
    mode === "singleton" ? "var(--rust, #b04a2a)"
    : mode === "duo" ? "var(--accent, #b04a2a)"
    : "var(--ink-soft)";
  const bg =
    mode === "singleton" ? "rgba(180,84,30,0.06)"
    : mode === "duo" ? "rgba(180,84,30,0.04)"
    : "var(--surface-sunken)";

  return (
    <div
      className="card"
      style={{
        marginBottom: 12,
        padding: "10px 14px",
        border: `1px solid ${accent}`,
        background: bg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <strong style={{ color: accent }}>{label}</strong>
        <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
          · the limitations below apply to classification of variants in this case
        </span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
        {limits.map((l) => (
          <li key={l.title} style={{ marginBottom: 3 }}>
            <strong>{l.title}.</strong>{" "}
            <span style={{ color: "var(--ink-soft)" }}>{l.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sortable column header. Click toggles direction; clicking a different
 * column makes that one active (default direction depends on the field). */
function SortHeader({
  label, sortKey, active, dir, onSort, numeric, className,
}: {
  label: React.ReactNode;
  sortKey: NonNullable<SortKey>;
  active: SortKey;
  dir: SortDir;
  onSort: (k: NonNullable<SortKey>) => void;
  numeric?: boolean;
  className?: string;
}) {
  const isActive = active === sortKey;
  const arrow = isActive ? (dir === "asc" ? " ▲" : " ▼") : "";
  const classes = [numeric ? "num" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <th
      className={classes}
      onClick={() => onSort(sortKey)}
      style={{ cursor: "pointer", userSelect: "none" }}
    >
      <span>{label}</span>
      <span className="mono" style={{ color: "var(--ink-soft)", fontSize: 10 }}>{arrow}</span>
    </th>
  );
}

/** Compact consequence label. VEP terms are verbose; map to short forms for
 * the table cell. Full term is preserved as the title attribute for tooltip. */
function abbrevConsequence(cons?: string): string {
  if (!cons) return "—";
  const map: Record<string, string> = {
    missense_variant: "missense",
    synonymous_variant: "synonymous",
    stop_gained: "stop gained",
    stop_lost: "stop lost",
    start_lost: "start lost",
    frameshift_variant: "frameshift",
    inframe_insertion: "in-frame ins",
    inframe_deletion: "in-frame del",
    splice_donor_variant: "splice donor",
    splice_acceptor_variant: "splice acceptor",
    splice_region_variant: "splice region",
    splice_donor_5th_base_variant: "splice donor 5'",
    splice_polypyrimidine_tract_variant: "splice ppt",
    intron_variant: "intronic",
    "5_prime_UTR_variant": "5' UTR",
    "3_prime_UTR_variant": "3' UTR",
    non_coding_transcript_exon_variant: "non-coding exon",
    intergenic_variant: "intergenic",
    upstream_gene_variant: "upstream",
    downstream_gene_variant: "downstream",
    protein_altering_variant: "protein altering",
    coding_sequence_variant: "coding",
    mature_miRNA_variant: "miRNA",
    NMD_transcript_variant: "NMD",
  };
  // Take first/most-severe term if multi-valued, then abbreviate.
  const first = cons.split(/[,&]/)[0].trim();
  return map[first] ?? first.replace(/_variant$/, "").replace(/_/g, " ");
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
      const r = await apiFetch(api(`/cases/${caseId}/rerun`), { method: "POST" });
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
