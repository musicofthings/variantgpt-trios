import { PipelinePicker } from "../components/PipelinePicker";

/** "New case" entry screen — choose the analysis pipeline (singleton / duo /
 *  trio) before entering Intake. Reached from the "New Case" nav item. */
export function NewCase() {
  return (
    <>
      <div className="topbar">
        <h1>New case</h1>
        <span className="pill">Choose a pipeline</span>
      </div>

      <section style={{ marginBottom: 24 }}>
        <p style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 720, color: "var(--ink-soft)" }}>
          Select the pipeline that matches the samples you have. All three share the same
          ACMG/AMP engine, South-Asian reclassification, and HPO matching — they differ only
          in how segregation and de-novo evidence is interpreted. You can edit the pedigree
          on the next screen.
        </p>
      </section>

      <PipelinePicker />
    </>
  );
}
