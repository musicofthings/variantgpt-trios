/** /cases/:caseId/diff — side-by-side validation view.
 *
 *  Currently hosts the Franklin (Genoox) CSV diff. Could later host
 *  additional external-platform diffs (Varsome, Emedgene, etc.) as new
 *  tabs.
 */
import { Link, useParams } from "react-router-dom";
import { useDemoCase } from "../caseData";
import { FranklinDiff } from "../components/FranklinDiff";

export function Diff() {
  const { caseId } = useParams<{ caseId: string }>();
  const { data, loading, error } = useDemoCase(caseId);

  if (loading) return <div className="card">Loading case…</div>;
  if (error || !data) {
    return (
      <div className="card">
        <p>Could not load case: {error}</p>
        <Link to={`/cases/${caseId}`}>← Back to workbench</Link>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Validation diff</h1>
        <span className="pill mono">{caseId}</span>
        <span className="pill">{data.variants.length} variants in case</span>
        <Link to={`/cases/${caseId}`} style={{ marginLeft: "auto" }}>
          <button>← Back to workbench</button>
        </Link>
      </div>

      <section style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", maxWidth: 760, lineHeight: 1.6 }}>
          Compare this case's VariantGPT output against an external platform's analysis of the
          same trio. Variants are joined by genomic coordinate, then bucketed as agree / differ
          / Franklin-only / VariantGPT-only with per-row hints on the likely cause of each
          divergence. Use alongside the ClinVar audit (on the workbench) for ground-truth
          calibration.
        </p>
      </section>

      <FranklinDiff variants={data.variants} />
    </>
  );
}
