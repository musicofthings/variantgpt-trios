/** /cases/:caseId/analysis — phenotype-driven curation, the intermediate
 *  screen between the Workbench triage and the final clinical report.
 *
 *  Carries the variants shortlisted in the Workbench (checkboxes →
 *  SELECTION_KEY) and lets the analyst:
 *    - rank them by phenotype relevance under a selectable algorithm
 *      (coverage / Resnik / Phrank — all precomputed by the engine),
 *    - inspect *why* each variant is relevant (per-HPO-term contribution),
 *    - confirm the final set, then generate the report.
 *
 *  The % relevance blends across ALL of the case's HPO terms, so it is most
 *  informative when more than one term is recorded.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useDemoCase } from "../caseData";
import { TierChip } from "../components/TierChip";
import type { PhenotypeAlgorithm, Tier, VariantRow } from "../types";
import {
  DEFAULT_PHENO_ALGO, PHENO_ALGORITHMS, PhenotypeBar, phenoPercent, phenoScore,
} from "../phenotype";
import {
  FINAL_KEY, PHENO_ALGO_KEY, SELECTION_KEY, readIdSet, readPhenoAlgo, writeIdSet,
} from "../selection";

export function AnalysisWorkbench() {
  const { caseId } = useParams<{ caseId: string }>();
  const { data, loading, error } = useDemoCase(caseId);
  const navigate = useNavigate();

  const [algo, setAlgo] = useState<PhenotypeAlgorithm>(
    () => (caseId ? readPhenoAlgo(caseId, DEFAULT_PHENO_ALGO) : DEFAULT_PHENO_ALGO),
  );
  const [final, setFinal] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  // Stackable filters on the curated list. Empty tier set = all tiers;
  // minRel = 0 means no phenotype-relevance floor. Both apply together (AND).
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set());
  const [minRel, setMinRel] = useState<number>(0);

  // The shortlist carried over from the Workbench.
  const shortlist = useMemo(() => (caseId ? readIdSet(SELECTION_KEY(caseId)) : new Set<string>()), [caseId]);

  // Shortlisted variants that actually exist in the loaded case, sorted by
  // the active algorithm's relevance (descending; unscored sink to bottom).
  const rows = useMemo(() => {
    if (!data) return [] as VariantRow[];
    const list = data.variants.filter((v) => shortlist.has(v.id));
    return [...list].sort((a, b) => phenoPercent(b, algo) - phenoPercent(a, algo));
  }, [data, shortlist, algo]);

  // Per-tier counts over the shortlist, for the filter chips.
  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { P: 0, LP: 0, VUS: 0, LB: 0, B: 0 };
    for (const v of rows) c[v.baseline_tier] = (c[v.baseline_tier] ?? 0) + 1;
    return c;
  }, [rows]);

  // The rows actually shown = shortlist passed through both filters. Filtering
  // is display-only; it never deselects a variant already ticked for the report.
  const visibleRows = useMemo(
    () => rows.filter((v) => {
      if (tierFilter.size > 0 && !tierFilter.has(v.baseline_tier)) return false;
      // Compare against the rounded percent the cell displays, so a row shown
      // as "70%" isn't dropped by a "≥70%" filter due to sub-integer rounding.
      if (minRel > 0 && Math.round(phenoPercent(v, algo)) < minRel) return false;
      return true;
    }),
    [rows, tierFilter, minRel, algo],
  );

  function toggleTier(t: Tier) {
    setTierFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }
  function clearFilters() {
    setTierFilter(new Set());
    setMinRel(0);
  }
  const filtersActive = tierFilter.size > 0 || minRel > 0;

  // Seed the final set from the shortlist once the case has loaded (or from a
  // previously-saved final selection if the analyst has been here before).
  useEffect(() => {
    if (!caseId || !data || seeded) return;
    const saved = readIdSet(FINAL_KEY(caseId));
    const valid = new Set([...saved].filter((id) => shortlist.has(id)));
    setFinal(valid.size > 0 ? valid : new Set(shortlist));
    setSeeded(true);
  }, [caseId, data, shortlist, seeded]);

  useEffect(() => {
    if (caseId && seeded) writeIdSet(FINAL_KEY(caseId), final);
  }, [caseId, final, seeded]);

  function chooseAlgo(a: PhenotypeAlgorithm) {
    setAlgo(a);
    if (caseId) { try { localStorage.setItem(PHENO_ALGO_KEY(caseId), a); } catch { /* ignore */ } }
  }
  function toggleFinal(id: string) {
    setFinal((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  // Wipe the report selection so the curator can start a fresh pick. The
  // persisted FINAL_KEY follows via the write effect on `final`.
  function clearList() {
    setFinal(new Set());
  }
  // Add every currently-visible (filtered) row to the report selection — pairs
  // with the filters so a curator can, e.g., filter to "P/LP + ≥70%" and grab
  // the whole set in one click after clearing.
  function selectShown() {
    setFinal((prev) => {
      const next = new Set(prev);
      for (const v of visibleRows) next.add(v.id);
      return next;
    });
  }

  if (loading) return <div className="card">Loading case…</div>;
  if (error || !data) {
    return (
      <div className="card">
        <p>Could not load case: {error}</p>
        <Link to={`/cases/${caseId}`}>← Back to workbench</Link>
      </div>
    );
  }

  const hpoTerms = data.hpo ?? [];
  const algoMeta = PHENO_ALGORITHMS.find((a) => a.id === algo)!;

  return (
    <>
      <div className="topbar">
        <h1>Analysis workbench</h1>
        <span className="pill mono">{caseId}</span>
        <span className="pill">{rows.length} shortlisted</span>
        <span className="pill">{final.size} for report</span>
        {final.size > 0 ? (
          <button
            onClick={clearList}
            title="Clear all variants selected for the report so you can pick a fresh list"
          >
            Clear list
          </button>
        ) : null}
        <Link to={`/cases/${caseId}`}><button>← Back to workbench</button></Link>
        <button
          className="primary"
          disabled={final.size === 0}
          title={final.size === 0 ? "Confirm at least one variant for the report" : ""}
          onClick={() => {
            if (!caseId) return;
            const ids = [...final].join(",");
            navigate(`/cases/${caseId}/report?variants=${encodeURIComponent(ids)}`);
          }}
        >
          Generate report{final.size > 0 ? ` (${final.size})` : ""}
        </button>
      </div>

      {hpoTerms.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            This case has no HPO terms, so phenotype-relevance ranking is unavailable.{" "}
            <Link to={`/cases/${caseId}`}>Return to the workbench</Link> to select variants directly.
          </p>
        </div>
      ) : shortlist.size === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            No variants were carried over. On the <Link to={`/cases/${caseId}`}>workbench</Link>,
            tick the candidate variants and click <strong>Curate in Analysis →</strong>.
          </p>
        </div>
      ) : (
        <>
          {/* Phenotype context + algorithm selector */}
          <section className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start", justifyContent: "space-between" }}>
              <div style={{ maxWidth: 560 }}>
                <h3 style={{ margin: "0 0 6px" }}>Phenotype relevance</h3>
                <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6, margin: "0 0 8px" }}>
                  Each variant is scored 0–100% for how closely its gene matches the case's{" "}
                  <strong>{hpoTerms.length}</strong> recorded clinical phenotype{hpoTerms.length === 1 ? "" : "s"}.
                  {hpoTerms.length > 1
                    ? " The percentage blends the match across all terms — a gene need not match every term to rank highly."
                    : " With a single HPO term, the percentage reflects this one phenotype; add more terms for a blended relevance signal."}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {hpoTerms.map((h) => (
                    <span key={h.hpo_id} className="pill mono" title={h.label} style={{ fontSize: 11 }}>
                      {h.hpo_id}{h.label ? ` · ${h.label}` : ""}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 6 }}>
                  Ranking algorithm
                </label>
                <div role="radiogroup" aria-label="Phenotype ranking algorithm" style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                  {PHENO_ALGORITHMS.map((a) => (
                    <button
                      key={a.id}
                      role="radio"
                      aria-checked={algo === a.id}
                      title={a.blurb}
                      onClick={() => chooseAlgo(a.id)}
                      style={{
                        border: "none",
                        borderRight: "1px solid var(--line)",
                        padding: "6px 12px",
                        fontSize: 13,
                        cursor: "pointer",
                        background: algo === a.id ? "var(--primary-soft)" : "var(--paper)",
                        color: algo === a.id ? "var(--primary)" : "var(--ink)",
                        fontWeight: algo === a.id ? 600 : 400,
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5, margin: "8px 0 0", maxWidth: 320 }}>
                  {algoMeta.blurb}
                </p>
              </div>
            </div>
          </section>

          {/* Stackable filters on the curated list — ACMG tier (multi-select)
              + a phenotype-relevance floor. They combine (AND) and are
              display-only, so ticked variants stay selected even when hidden. */}
          <section className="card" style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--ink-soft)", fontWeight: 600 }}>ACMG tier</span>
              {(["P", "LP", "VUS", "LB", "B"] as Tier[]).map((t) => {
                const on = tierFilter.has(t);
                const n = tierCounts[t];
                return (
                  <button
                    key={t}
                    onClick={() => toggleTier(t)}
                    aria-pressed={on}
                    disabled={n === 0 && !on}
                    title={`${on ? "Hide" : "Show"} ${t} variants (${n})`}
                    style={{
                      fontSize: 12,
                      padding: "3px 10px",
                      borderRadius: 999,
                      border: `1px solid ${on ? "var(--primary)" : "var(--line)"}`,
                      background: on ? "var(--primary-soft)" : "var(--paper)",
                      color: on ? "var(--primary)" : "var(--ink)",
                      fontWeight: on ? 600 : 400,
                      cursor: n === 0 && !on ? "not-allowed" : "pointer",
                      opacity: n === 0 && !on ? 0.4 : 1,
                    }}
                  >
                    {t} <span style={{ color: "var(--ink-soft)" }}>{n}</span>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--ink-soft)", fontWeight: 600 }}>
                Phenotype relevance
              </span>
              <div role="radiogroup" aria-label="Minimum phenotype relevance" style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                {[{ v: 0, label: "Any" }, { v: 40, label: "≥40%" }, { v: 70, label: "≥70%" }].map((opt) => (
                  <button
                    key={opt.v}
                    role="radio"
                    aria-checked={minRel === opt.v}
                    onClick={() => setMinRel(opt.v)}
                    style={{
                      border: "none",
                      borderRight: "1px solid var(--line)",
                      padding: "4px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      background: minRel === opt.v ? "var(--primary-soft)" : "var(--paper)",
                      color: minRel === opt.v ? "var(--primary)" : "var(--ink)",
                      fontWeight: minRel === opt.v ? 600 : 400,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                {visibleRows.length} of {rows.length} shown
              </span>
              {filtersActive ? (
                <button onClick={clearFilters} style={{ fontSize: 12 }} title="Reset tier + relevance filters">
                  Clear filters
                </button>
              ) : null}
              <button
                onClick={selectShown}
                disabled={visibleRows.length === 0}
                style={{ fontSize: 12 }}
                title="Add all currently-shown variants to the report selection"
              >
                Select shown
              </button>
            </div>
          </section>

          {/* Ranked shortlist */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th style={{ width: 28 }} />
                  <th style={{ textAlign: "left" }}>Gene</th>
                  <th style={{ textAlign: "left" }}>HGVS</th>
                  <th style={{ textAlign: "left" }}>Consequence</th>
                  <th style={{ width: 64 }}>Tier</th>
                  <th style={{ width: 150 }}>Relevance ({algoMeta.label})</th>
                  <th style={{ textAlign: "left" }} title="HPO phenotypes the gene is associated with in the genes_to_phenotype catalog — shown for clinical-utility context even when none overlap the case phenotype">Gene phenotypes</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((v, i) => {
                  const score = phenoScore(v, algo);
                  const pct = phenoPercent(v, algo);
                  const isOpen = expanded === v.id;
                  const checked = final.has(v.id);
                  return (
                    <RankRow
                      key={v.id}
                      v={v}
                      rank={i + 1}
                      pct={pct}
                      checked={checked}
                      isOpen={isOpen}
                      caseTermCount={hpoTerms.length}
                      matched={score?.matched_terms ?? []}
                      onToggleFinal={() => toggleFinal(v.id)}
                      onToggleOpen={() => setExpanded(isOpen ? null : v.id)}
                    />
                  );
                })}
                {visibleRows.length === 0 ? (
                  <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--ink-soft)", padding: 24 }}>
                    {rows.length === 0 ? "No shortlisted variants." : "No variants match the current filters."}
                  </td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function RankRow({
  v, rank, pct, checked, isOpen, caseTermCount, matched, onToggleFinal, onToggleOpen,
}: {
  v: VariantRow;
  rank: number;
  pct: number;
  checked: boolean;
  isOpen: boolean;
  caseTermCount: number;
  matched: { hpo_id: string; label?: string; contribution: number }[];
  onToggleFinal: () => void;
  onToggleOpen: () => void;
}) {
  const hgvs = `${v.hgvs_c ?? ""}${v.hgvs_p ? ` (${v.hgvs_p})` : ""}`;
  const maxContrib = Math.max(0.0001, ...matched.map((m) => m.contribution));
  return (
    <>
      <tr style={{ cursor: "pointer", opacity: checked ? 1 : 0.55 }}>
        <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}>
          <input type="checkbox" checked={checked} onChange={onToggleFinal} aria-label={`Include ${v.gene ?? v.id} in report`} />
        </td>
        <td className="num" onClick={onToggleOpen}>{rank}</td>
        <td className="mono" onClick={onToggleOpen} title={v.gene}>{v.gene ?? "—"}</td>
        <td className="mono" onClick={onToggleOpen} title={hgvs} style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {v.hgvs_c}
          {v.hgvs_p ? <span style={{ color: "var(--ink-soft)" }}> {v.hgvs_p}</span> : null}
        </td>
        <td onClick={onToggleOpen}>{v.consequence ?? "—"}</td>
        <td onClick={onToggleOpen} style={{ textAlign: "center" }}><TierChip tier={v.baseline_tier} /></td>
        <td className="num" onClick={onToggleOpen}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <PhenotypeBar percent={v.phenotype_relevance ? pct : null} width={64} />
            <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>{isOpen ? "▾" : "▸"}</span>
          </span>
        </td>
        <td onClick={onToggleOpen}>
          <GenePhenotypeCell phenotypes={v.gene_phenotypes ?? []} total={v.gene_phenotype_total ?? 0} />
        </td>
      </tr>
      {isOpen ? (
        <tr>
          <td colSpan={8} style={{ background: "var(--paper-2, #fafafa)", padding: "10px 16px 14px" }}>
            {matched.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)" }}>
                {v.gene ?? "This gene"} has no recorded association with the case's HPO terms under this algorithm.
              </p>
            ) : (
              <>
                <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--ink-soft)" }}>
                  Contributing phenotypes — {matched.length} of {caseTermCount} case term{caseTermCount === 1 ? "" : "s"} drive this gene's {pct.toFixed(0)}% relevance:
                </p>
                <div style={{ display: "grid", gap: 6, maxWidth: 620 }}>
                  {matched.map((m) => (
                    <div key={m.hpo_id} style={{ display: "grid", gridTemplateColumns: "200px 1fr 48px", alignItems: "center", gap: 8 }}>
                      <a
                        href={`https://hpo.jax.org/browse/term/${m.hpo_id}`}
                        target="_blank" rel="noreferrer"
                        className="mono" style={{ fontSize: 11, textDecoration: "none" }}
                        title={m.label}
                      >
                        {m.hpo_id}
                      </a>
                      <span style={{ height: 7, borderRadius: 4, background: "var(--line, #e5e7eb)", overflow: "hidden" }}>
                        <span style={{ display: "block", height: "100%", width: `${(m.contribution / maxContrib) * 100}%`, background: "var(--primary, #2563eb)" }} />
                      </span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", textAlign: "right" }}>
                        {(m.contribution * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
                {matched.some((m) => m.label) ? (
                  <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                    {matched.filter((m) => m.label).map((m) => m.label).join(" · ")}
                  </p>
                ) : null}
              </>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The gene's HPO catalog associations, independent of the case phenotype.
 *  Shows the top few terms (case-matching ones highlighted) so a curator can
 *  judge clinical utility even when the Relevance column is empty. */
function GenePhenotypeCell({
  phenotypes,
  total,
}: {
  phenotypes: { hpo_id: string; label?: string; matches_case: boolean }[];
  total: number;
}) {
  if (phenotypes.length === 0) {
    return <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>—</span>;
  }
  const SHOWN = 4;
  const shown = phenotypes.slice(0, SHOWN);
  const moreFromSlice = phenotypes.length - shown.length;
  const moreTotal = Math.max(0, total - shown.length);
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, maxWidth: 360 }}>
      {shown.map((p) => (
        <a
          key={p.hpo_id}
          href={`https://hpo.jax.org/browse/term/${p.hpo_id}`}
          target="_blank"
          rel="noreferrer"
          title={`${p.hpo_id}${p.label ? ` · ${p.label}` : ""}${p.matches_case ? " — also a case phenotype" : ""}`}
          onClick={(e) => e.stopPropagation()}
          className="pill"
          style={{
            fontSize: 11,
            textDecoration: "none",
            background: p.matches_case ? "var(--primary-soft, #e0e7ff)" : "var(--paper-2, #f3f4f6)",
            color: p.matches_case ? "var(--primary, #2563eb)" : "var(--ink-soft, #666)",
            fontWeight: p.matches_case ? 600 : 400,
            maxWidth: 170,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.label || p.hpo_id}
        </a>
      ))}
      {moreTotal > 0 ? (
        <span
          className="mono"
          style={{ fontSize: 11, color: "var(--ink-soft)", alignSelf: "center" }}
          title={`${total} total HPO associations for this gene${moreFromSlice > 0 ? `; ${moreFromSlice} more in the top slice` : ""}`}
        >
          +{moreTotal} more
        </span>
      ) : null}
    </span>
  );
}
