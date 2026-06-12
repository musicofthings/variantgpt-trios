import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Pedigree } from "../components/Pedigree";
import { FileDropzone, type StagedFile } from "../components/FileDropzone";
import { RunMonitor, useJobStatus } from "../components/RunMonitor";
import { HpoSearch, type HpoHit } from "../components/HpoSearch";
import { pedigreeForMode, type PedigreeState } from "../types-pedigree";
import { autoMapSample, sniffFile } from "../vcfSniff";
import { api, apiFetch } from "../apiBase";
import { uploadStaged } from "../upload";
import { fetchLibrarySamples, assignDataToCase, humanBytes, type LibrarySample } from "../data";

/** Mode → human label for the topbar pill. Drives only display; the engine
 *  reasons about whichever members the pedigree contains. */
const MODE_LABEL: Record<string, string> = {
  singleton: "Singleton pipeline",
  duo: "Duo pipeline",
  trio: "Trio pipeline",
};

/** Case intake (design spec §4.2 + PRD §4.1). Vertical sectioned flow.
 * Final step uploads VCF/BAM to the dev API and triggers an engine run. */

interface HPOEntry { id: string; label?: string; definition?: string; confirmed: boolean; sourcePhrase?: string; }

const HPO_LABEL: Record<string, string> = {
  "HP:0001250": "Seizure",
  "HP:0001263": "Global developmental delay",
  "HP:0002376": "Developmental regression",
  "HP:0000252": "Microcephaly",
  "HP:0001903": "Anemia",
};

interface StagedByRole {
  [role: string]: (StagedFile & {
    detectedBuild?: string;
    sniffOk?: boolean;
    sniffError?: string;
    /** Curator override: trust the role assignment even if sample name doesn't match. */
    ackMismatch?: boolean;
    /** Curator override: reassign this VCF to a different pedigree member id. */
    reassignedTo?: string;
  }) | undefined;
}

type RunStage = "idle" | "uploading" | "submitted" | "error";

export function Intake() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  // Pipeline mode comes in via /cases/new?mode=singleton|duo|trio (set by the
  // Home screen's pipeline picker). Seeds the initial pedigree shape;
  // membership can still be edited freely in the pedigree widget.
  const mode = (search.get("mode") ?? "trio").toLowerCase();
  const [pedigree, setPedigree] = useState<PedigreeState>(() => pedigreeForMode(mode));
  const [hpo, setHpo] = useState<HPOEntry[]>([]);
  const [hpoInput, setHpoInput] = useState("");
  const [history, setHistory] = useState("");
  const [onsetAge, setOnsetAge] = useState("");
  const [priorTesting, setPriorTesting] = useState("");
  const [familyHistory, setFamilyHistory] = useState("");
  const [consanguinityNote, setConsanguinityNote] = useState("");
  const [staged, setStaged] = useState<StagedByRole>({});
  // Input modality:
  //   "vcf"     — VCF + aligned BAM/CRAM (one file per member)
  //   "fastq"   — paired raw reads uploaded from this browser (R1 + R2 per member)
  //   "library" — pick an already-synced sample from the data library (no upload)
  const [inputType, setInputType] = useState<"vcf" | "fastq" | "library">("vcf");
  // Data-library samples (fetched when inputType === "library"); per-member pick.
  const [librarySamples, setLibrarySamples] = useState<LibrarySample[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({}); // memberId -> sample name
  const [pickedType, setPickedType] = useState<Record<string, "vcf" | "fastq">>({}); // memberId -> chosen data type
  const [runStage, setRunStage] = useState<RunStage>("idle");
  const [runMsg, setRunMsg] = useState<string>("");
  const [caseId] = useState(() => `case-${Date.now().toString(36)}`);
  // Poll engine status once we've submitted the run.
  const jobStatus = useJobStatus(runStage === "submitted" ? caseId : undefined);

  // Auto-redirect to workbench when the engine reports ready. Small delay so
  // the user sees the green "ready" state for a beat first.
  useEffect(() => {
    if (jobStatus?.status === "ready") {
      const t = setTimeout(() => navigate(`/cases/${caseId}`), 800);
      return () => clearTimeout(t);
    }
  }, [jobStatus?.status, caseId, navigate]);

  // Load data-library samples when the user switches to library mode.
  useEffect(() => {
    if (inputType !== "library") return;
    let cancelled = false;
    fetchLibrarySamples()
      .then((s) => { if (!cancelled) { setLibrarySamples(s); setLibraryError(null); } })
      .catch((e) => { if (!cancelled) setLibraryError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [inputType]);

  // LLM-extracted candidates from /api/ai/hpo-extract (button-triggered to keep
  // cost predictable). Each carries the source phrase for curator transparency.
  const [aiSuggested, setAiSuggested] = useState<HPOEntry[]>([]);
  const [extractState, setExtractState] = useState<"idle" | "loading" | "done" | "error" | "unavailable">("idle");
  const [extractMsg, setExtractMsg] = useState("");

  // Lightweight offline baseline — a few common terms matched by regex so the
  // panel is useful even before (or without) an LLM call. Merged with the
  // LLM results below; deduped against each other and against confirmed terms.
  const localSuggested = useMemo<HPOEntry[]>(() => {
    const text = history.toLowerCase();
    const hits: HPOEntry[] = [];
    if (/seizure|epilep|convuls/.test(text)) hits.push({ id: "HP:0001250", label: "Seizure", confirmed: false });
    if (/(developmental|global) delay|gdd/.test(text)) hits.push({ id: "HP:0001263", label: "Global developmental delay", confirmed: false });
    if (/regress/.test(text)) hits.push({ id: "HP:0002376", label: "Developmental regression", confirmed: false });
    if (/microcephal/.test(text)) hits.push({ id: "HP:0000252", label: "Microcephaly", confirmed: false });
    if (/anemi|haemoglob|hemoglob|hbe|sickle/.test(text)) hits.push({ id: "HP:0001903", label: "Anemia", confirmed: false });
    return hits;
  }, [history]);

  const suggested = useMemo<HPOEntry[]>(() => {
    const merged: HPOEntry[] = [];
    const seen = new Set(hpo.map((h) => h.id));
    for (const s of [...aiSuggested, ...localSuggested]) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(s);
    }
    return merged;
  }, [aiSuggested, localSuggested, hpo]);

  async function extractHpoFromHistory() {
    if (history.trim().length < 3) return;
    setExtractState("loading");
    setExtractMsg("");
    try {
      const resp = await apiFetch(api("/ai/hpo-extract"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: history, existing_ids: hpo.map((h) => h.id) }),
      });
      if (resp.status === 503) {
        setExtractState("unavailable");
        setExtractMsg("AI extraction isn't configured on this server — using keyword matches only.");
        return;
      }
      if (!resp.ok) {
        setExtractState("error");
        setExtractMsg(`Extraction failed (${resp.status}).`);
        return;
      }
      const data = (await resp.json()) as {
        suggestions?: Array<{ id: string; label: string; definition?: string; source_phrase?: string }>;
      };
      const next: HPOEntry[] = (data.suggestions ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        definition: s.definition,
        sourcePhrase: s.source_phrase,
        confirmed: false,
      }));
      setAiSuggested(next);
      setExtractState("done");
      setExtractMsg(
        next.length
          ? `${next.length} term${next.length === 1 ? "" : "s"} extracted — click + to confirm.`
          : "No new phenotype terms found in the history.",
      );
    } catch (e) {
      setExtractState("error");
      setExtractMsg(`Extraction failed: ${String(e).slice(0, 120)}`);
    }
  }

  function confirmSuggested(e: HPOEntry) { setHpo([...hpo, { ...e, confirmed: true }]); }
  function removeHpo(id: string) { setHpo(hpo.filter((h) => h.id !== id)); }
  function addHpoManual() {
    const v = hpoInput.trim().toUpperCase();
    if (/^HP:\d{7}$/.test(v) && !hpo.some((h) => h.id === v)) {
      setHpo([...hpo, { id: v, label: HPO_LABEL[v], confirmed: true }]);
    }
    setHpoInput("");
  }
  function addFromSearch(hit: HpoHit) {
    if (hpo.some((h) => h.id === hit.id)) return;
    setHpo([...hpo, { id: hit.id, label: hit.label, definition: hit.definition, confirmed: true }]);
  }

  // Sniff a staged file in the background — extracts sample names from VCF header.
  async function handleStage(role: string, sf: StagedFile) {
    setStaged((s) => ({ ...s, [role]: { ...sf, sniffOk: undefined } }));
    if (sf.kind === "vcf" || sf.kind === "vcf_gz") {
      const r = await sniffFile(sf.file, sf.kind);
      const sample = r.samples[0];
      setStaged((s) => ({
        ...s,
        [role]: {
          ...sf,
          sample: sample ?? null,
          detectedBuild: r.build,
          sniffOk: r.ok,
          sniffError: r.error,
        },
      }));
    } else if (sf.kind === "bam") {
      const r = await sniffFile(sf.file, sf.kind);
      setStaged((s) => ({
        ...s,
        [role]: { ...sf, sniffOk: r.ok, sniffError: r.error },
      }));
    } else if (sf.kind === "fastq") {
      // FASTQ carries no sample header to sniff; accept as-is.
      setStaged((s) => ({ ...s, [role]: { ...sf, sniffOk: true } }));
    }
  }

  function clearStage(role: string) {
    setStaged((s) => { const c = { ...s }; delete c[role]; return c; });
  }

  // Members the user actively expects to sequence (excludes "no sample" parents).
  const presentMembers = pedigree.members.filter((m) => !m.missing);
  const missingCount = pedigree.members.length - presentMembers.length;
  const proband = pedigree.members.find((m) => m.role === "proband");

  // A member is "ready" when its required upload(s) are staged without error:
  //   vcf mode   → one VCF/BAM file (key = member id)
  //   fastq mode → paired R1 (key = id) + R2 (key = `${id}__R2`)
  function memberReady(id: string): boolean {
    if (inputType === "library") {
      const s = librarySamples.find((x) => x.sample === picked[id]);
      if (!s) return false;
      const t = pickedType[id] ?? (s.vcf ? "vcf" : "fastq");
      return t === "vcf" ? !!s.vcf : !!s.r1;
    }
    if (inputType === "fastq") {
      const r1 = staged[id];
      const r2 = staged[`${id}__R2`];
      return !!(r1 && r1.kind === "fastq" && !r1.error && r2 && r2.kind === "fastq" && !r2.error);
    }
    const sf = staged[id];
    return !!(sf && (sf.kind === "vcf" || sf.kind === "vcf_gz" || sf.kind === "bam") && !sf.error);
  }
  const vcfReadyCount = presentMembers.filter((m) => memberReady(m.id)).length;
  const probandStaged = !!(proband && memberReady(proband.id));

  // Collision check: did the curator reassign two VCFs to the same target role?
  const targetCounts = new Map<string, number>();
  for (const [role, sf] of Object.entries(staged)) {
    if (!sf) continue;
    const tgt = sf.reassignedTo ?? role;
    targetCounts.set(tgt, (targetCounts.get(tgt) ?? 0) + 1);
  }
  const collisions = Array.from(targetCounts.entries()).filter(([_, n]) => n > 1).map(([r]) => r);

  // Unresolved name mismatches block the run unless explicitly acknowledged.
  const unresolvedMismatches = Object.entries(staged).filter(([role, sf]) => {
    if (!sf || !sf.sample) return false;
    const member = pedigree.members.find((m) => m.id === role);
    if (!member) return false;
    const mapped = autoMapSample(sf.sample, member.role, sf.file.name);
    return !mapped && !sf.ackMismatch && !sf.reassignedTo;
  });

  const ready =
    pedigree.members.length >= 1 &&
    hpo.length >= 1 &&
    history.trim().length >= 20 &&
    probandStaged &&
    vcfReadyCount === presentMembers.length &&
    collisions.length === 0 &&
    unresolvedMismatches.length === 0 &&
    runStage === "idle";

  // Build detection summary across uploads.
  const detectedBuilds = Array.from(
    new Set(Object.values(staged).map((s) => s?.detectedBuild).filter(Boolean))
  );
  const buildConflict = detectedBuilds.length > 1;

  async function runAnalysis() {
    setRunStage("uploading");
    setRunMsg("Uploading…");
    try {
      // 1. Upload each staged file straight to R2 (single PUT for small files,
      //    resumable multipart for large ones — bytes never touch the Worker).
      //    `files` records a representative per-role filename for the manifest;
      //    the Worker routes by extension/mate (FASTQ→align, BAM→call, VCF→annotate).
      const files: Record<string, string> = {};
      if (inputType === "library") {
        // No upload — point the case's roles at already-synced library objects.
        setRunMsg("Assigning library samples…");
        const assignments: { role: string; mate: "R1" | "R2" | ""; key: string }[] = [];
        for (const m of presentMembers) {
          const s = librarySamples.find((x) => x.sample === picked[m.id]);
          if (!s) continue;
          const t = pickedType[m.id] ?? (s.vcf ? "vcf" : "fastq");
          if (t === "vcf" && s.vcf) {
            assignments.push({ role: m.id, mate: "", key: s.vcf });
            files[m.id] = s.vcf.toLowerCase().endsWith(".gz") ? `${m.id}.vcf.gz` : `${m.id}.vcf`;
          } else if (s.r1) {
            assignments.push({ role: m.id, mate: "R1", key: s.r1 });
            if (s.r2) assignments.push({ role: m.id, mate: "R2", key: s.r2 });
            files[m.id] = `${m.id}.R1.fastq.gz`;
          }
        }
        await assignDataToCase(caseId, assignments);
      } else if (inputType === "fastq") {
        for (const m of presentMembers) {
          const r1 = staged[m.id];
          const r2 = staged[`${m.id}__R2`];
          if (!r1 || !r2) continue;
          await uploadStaged(caseId, m.id, r1.file,
            (p) => setRunMsg(`Uploading ${m.id} R1 — ${Math.round(p.fraction * 100)}%`), "R1");
          await uploadStaged(caseId, m.id, r2.file,
            (p) => setRunMsg(`Uploading ${m.id} R2 — ${Math.round(p.fraction * 100)}%`), "R2");
          setRunMsg(`Uploaded ${m.id} (R1+R2)`);
          const ext = r1.file.name.toLowerCase().endsWith(".fq.gz") ? "fq.gz" : "fastq.gz";
          files[m.id] = `${m.id}.R1.${ext}`;
        }
      } else {
        for (const [role, sf] of Object.entries(staged)) {
          if (!sf || sf.kind === "bai" || sf.kind === "unknown" || sf.kind === "fastq" || sf.error) continue;
          const target = sf.reassignedTo ?? role;
          const verb = sf.kind === "bam" ? "BAM/CRAM" : "VCF";
          await uploadStaged(caseId, target, sf.file, (p) => {
            setRunMsg(`Uploading ${target} (${verb}) — ${Math.round(p.fraction * 100)}%`);
          });
          setRunMsg(`Uploaded ${target}`);
          const lower = sf.file.name.toLowerCase();
          const ext = sf.kind === "bam"
            ? (lower.endsWith(".cram") ? "cram" : "bam")
            : (lower.endsWith(".gz") ? "vcf.gz" : "vcf");
          files[target] = `${target}.${ext}`;
        }
      }

      // 2. Trigger engine run with manifest.
      setRunMsg("Submitting run…");
      const manifest = {
        pedigree: pedigree.members.map((m) => ({
          id: m.id, role: m.role, sex: m.sex, affected: m.affected,
          sample_name: staged[m.id]?.sample ?? m.sample_name ?? m.id,
          missing: !!m.missing,
        })),
        consanguineous: pedigree.consanguineous,
        hpo: hpo.map((h) => ({ id: h.id, label: h.label ?? null, definition: h.definition ?? null })),
        // Clinical context — rendered on page 1 of the report. The engine
        // stores this verbatim into CaseEmission.clinical_history; if any
        // field is empty we still send it so the report layout stays stable.
        clinical_history: {
          text: history,
          onset_age: onsetAge,
          consanguinity_note: consanguinityNote,
          family_history: familyHistory,
          prior_testing: priorTesting,
        },
        history,  // back-compat for older engine builds expecting flat `history`
        files,
      };
      const runResp = await apiFetch(api(`/cases/${caseId}/run`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(manifest),
      });
      if (!runResp.ok) throw new Error(`run failed: ${runResp.status}`);

      // Engine is now running asynchronously. The useJobStatus hook polls and
      // RunMonitor renders progress; the useEffect above redirects on ready.
      setRunStage("submitted");
      setRunMsg("");
    } catch (e) {
      setRunStage("error");
      setRunMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>New case</h1>
        <span className="pill mono">{caseId}</span>
        <span className="pill" title={`Pipeline mode set from the home screen — ${mode}`}>
          {MODE_LABEL[mode] ?? "Trio pipeline"}
        </span>
        <span className="pill">
          {runStage === "idle" ? "Draft"
            : runStage === "uploading" ? "Uploading"
            : runStage === "error" ? "Error"
            : jobStatus?.status ?? "Submitted"}
        </span>
      </div>

      {runStage === "submitted" || runStage === "uploading" ? (
        <div style={{ marginBottom: 24 }}>
          <RunMonitor
            caseId={caseId}
            status={
              runStage === "uploading"
                ? { status: "queued", log: ["Uploading VCFs…"] }
                : jobStatus
            }
            showOpenLink={true}
          />
          <p style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 8, textAlign: "center" }}>
            You'll be redirected to the workbench automatically when the engine finishes.
          </p>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 32 }}>
        <nav
          aria-label="Intake sections"
          style={{ position: "sticky", top: 24, alignSelf: "start", display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}
        >
          <a href="#sec-pedigree" style={{ color: "var(--ink-soft)" }}>1. Pedigree</a>
          <a href="#sec-hpo" style={{ color: "var(--ink-soft)" }}>2. Phenotype</a>
          <a href="#sec-history" style={{ color: "var(--ink-soft)" }}>3. Clinical history</a>
          <a href="#sec-vcf" style={{ color: "var(--ink-soft)" }}>4. Upload data</a>
        </nav>

        <div>
          <section id="sec-pedigree" className="card" style={{ marginBottom: 24 }}>
            <h3>1. Pedigree</h3>
            <p style={{ color: "var(--ink-soft)", marginTop: 4 }}>
              Click to toggle affected status. Mark consanguinity if parents are related; add siblings as needed.
            </p>
            <div style={{ marginTop: 16 }}>
              <Pedigree state={pedigree} onChange={setPedigree} />
            </div>
          </section>

          <section id="sec-hpo" className="card" style={{ marginBottom: 24 }}>
            <h3>2. Phenotype (HPO)</h3>
            <p style={{ color: "var(--ink-soft)", marginTop: 4 }}>
              At least one HPO term required. Search by phenotype name or HP id, or paste a known id below.
              History-derived suggestions appear as dashed chips.
            </p>

            {/* Typeahead — primary input. Hits Worker /api/hpo/search → EBI OLS4. */}
            <div style={{ marginTop: 12 }}>
              <HpoSearch
                excludeIds={hpo.map((h) => h.id)}
                onPick={addFromSearch}
                placeholder='Search HPO — e.g. "seizure", "microcephaly", or "HP:0001250"'
              />
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12, minHeight: 32 }}>
              {hpo.map((h) => (
                <span key={h.id} className="hpo-chip confirmed">
                  <span>{h.id}</span>
                  {h.label ? <span style={{ fontFamily: "var(--font-body)" }}>· {h.label}</span> : null}
                  <button className="remove" onClick={() => removeHpo(h.id)} aria-label={`Remove ${h.id}`}>×</button>
                </span>
              ))}
              {suggested.map((s) => (
                <span
                  key={s.id}
                  className="hpo-chip suggested"
                  title={s.sourcePhrase ? `From history: "${s.sourcePhrase}" — confirm to add` : "Suggested — confirm to add"}
                >
                  <span>{s.id}</span>
                  {s.label ? <span style={{ fontFamily: "var(--font-body)" }}>· {s.label}</span> : null}
                  <button onClick={() => confirmSuggested(s)} aria-label={`Confirm ${s.id}`}>+</button>
                </span>
              ))}
            </div>

            {/* Escape hatch: advanced users who already know an HP id can paste it. */}
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--ink-soft)" }}>
                Add by HP id
              </summary>
              <form
                style={{ marginTop: 8, display: "flex", gap: 8 }}
                onSubmit={(e) => { e.preventDefault(); addHpoManual(); }}
              >
                <input
                  value={hpoInput}
                  onChange={(e) => setHpoInput(e.target.value)}
                  placeholder="HP:0001250"
                  className="mono"
                  style={{ flex: 1 }}
                  aria-label="Add HPO term by ID"
                />
                <button>Add</button>
              </form>
            </details>
          </section>

          <section id="sec-history" className="card" style={{ marginBottom: 24 }}>
            <h3>3. Clinical history</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
                Age of onset
                <input value={onsetAge} onChange={(e) => setOnsetAge(e.target.value)} placeholder="e.g. 6 months" />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
                Prior testing
                <input value={priorTesting} onChange={(e) => setPriorTesting(e.target.value)} placeholder="e.g. CMA normal" />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
                Consanguinity notes
                <input
                  value={consanguinityNote}
                  onChange={(e) => setConsanguinityNote(e.target.value)}
                  placeholder="e.g. First-cousin parents"
                />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-soft)" }}>
                Family history
                <input
                  value={familyHistory}
                  onChange={(e) => setFamilyHistory(e.target.value)}
                  placeholder="e.g. Affected paternal cousin"
                />
              </label>
            </div>
            <textarea
              value={history}
              onChange={(e) => setHistory(e.target.value)}
              rows={6}
              style={{ width: "100%", marginTop: 12 }}
              placeholder="Onset, course, examination findings, imaging, prior testing — anything relevant to interpretation. Free text. Used verbatim on the report's first page."
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={extractHpoFromHistory}
                disabled={history.trim().length < 3 || extractState === "loading"}
              >
                {extractState === "loading" ? "Extracting…" : "Suggest HPO terms from history"}
              </button>
              <span
                style={{
                  color: extractState === "error" ? "var(--danger, #b00)" : "var(--ink-soft)",
                  fontSize: 12,
                }}
              >
                {extractMsg ||
                  (suggested.length
                    ? `${suggested.length} HPO ${suggested.length === 1 ? "term" : "terms"} suggested above — click + to confirm.`
                    : "Extract HPO candidates from the history above; each is grounded to a real HP id via OLS4. Curator confirms before they're added.")}
              </span>
            </div>
          </section>

          <section id="sec-vcf" className="card" style={{ marginBottom: 24 }}>
            <h3>4. Upload sequencing data</h3>
            <p style={{ color: "var(--ink-soft)", marginTop: 4 }}>
              {inputType === "library"
                ? <>Assign a sample from the <strong>data library</strong> (synced daily from the partner lab)
                    to each member — no upload. The engine reads the FASTQs straight from storage and
                    aligns (BWA-MEM) + calls. Manage the library under the <strong>Data</strong> tab.</>
                : inputType === "fastq"
                ? <>Paired raw reads per member — <code className="mono">R1</code> + <code className="mono">R2</code>{" "}
                    (<code className="mono">.fastq.gz</code> / <code className="mono">.fq.gz</code>). The engine aligns
                    (BWA-MEM) and calls variants. WES alignment runs ~30–60 min per sample.</>
                : <>One drop-zone per member. Accepts <code className="mono">.vcf</code>,{" "}
                    <code className="mono">.vcf.gz</code>, or aligned <code className="mono">.bam</code>/<code className="mono">.cram</code>.
                    VCF sample names are read in-browser and matched to roles.</>}
            </p>
            {inputType === "library" && libraryError ? (
              <div className="banner banner-warn">Couldn't load the data library: {libraryError}</div>
            ) : inputType === "library" && librarySamples.length === 0 ? (
              <div className="banner banner-info">No library samples yet — they appear here after the daily SFTP sync runs.</div>
            ) : null}

            {/* Input modality toggle */}
            <div role="radiogroup" aria-label="Input data type" style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", marginTop: 8 }}>
              {([["vcf", "VCF / BAM"], ["fastq", "FASTQ (R1+R2)"], ["library", "Data library"]] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={inputType === v}
                  onClick={() => { setInputType(v); setStaged({}); setPicked({}); setPickedType({}); }}
                  style={{
                    border: "none", borderRight: "1px solid var(--line)", padding: "6px 14px",
                    fontSize: 13, cursor: "pointer",
                    background: inputType === v ? "var(--primary-soft)" : "var(--paper)",
                    color: inputType === v ? "var(--primary)" : "var(--ink)",
                    fontWeight: inputType === v ? 600 : 400,
                  }}
                >{label}</button>
              ))}
            </div>

            {buildConflict ? (
              <div className="banner banner-warn">
                Detected mixed reference builds across uploads: {detectedBuilds.join(", ")}.
                Engine will canonicalize on GRCh38 via liftover (PRD §4.2).
              </div>
            ) : detectedBuilds.length === 1 ? (
              <div className="banner banner-info">
                Reference build detected: <strong className="mono">{detectedBuilds[0]}</strong>
              </div>
            ) : null}

            {missingCount > 0 ? (
              <div className="banner banner-info">
                {missingCount} member{missingCount === 1 ? "" : "s"} marked <strong>no sample</strong> —
                engine will run as a {pedigree.members.length - missingCount === 1 ? "singleton" : "duo"};
                de novo / trans-phasing will be downgraded where parental genotypes are missing (PRD §4.1, §4.3).
              </div>
            ) : null}

            {collisions.length ? (
              <div className="banner banner-warn">
                Two VCFs assigned to the same role: <strong>{collisions.join(", ")}</strong>. Pick distinct targets.
              </div>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 16 }}>
              {pedigree.members.filter((m) => !m.missing).map((m) => {
                if (inputType === "library") {
                  const sel = librarySamples.find((x) => x.sample === picked[m.id]);
                  const total = sel ? sel.files.reduce((n, f) => n + (f.size || 0), 0) : 0;
                  return (
                    <div key={m.id} style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{capitalize(m.role)} · <span className="mono">{m.id}</span></div>
                      <select
                        value={picked[m.id] ?? ""}
                        onChange={(e) => setPicked((p) => ({ ...p, [m.id]: e.target.value }))}
                        style={{ width: "100%", padding: "8px 10px" }}
                        aria-label={`Library sample for ${m.role}`}
                      >
                        <option value="">— choose a sample —</option>
                        {librarySamples.map((s) => (
                          <option key={s.sample} value={s.sample} disabled={!s.r1}>
                            {s.sample}{s.paired ? " (R1+R2)" : s.r1 ? " (R1 only)" : " (unpaired)"}
                          </option>
                        ))}
                      </select>
                      {sel ? (() => {
                        const t = pickedType[m.id] ?? (sel.vcf ? "vcf" : "fastq");
                        return (
                          <div className="sample-map ok" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                            {sel.vcf && sel.r1 ? (
                              <div role="radiogroup" aria-label="Data type" style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden", alignSelf: "flex-start" }}>
                                {([["vcf", "VCF · fast"], ["fastq", "FASTQ · re-call"]] as const).map(([v, label]) => (
                                  <button
                                    key={v}
                                    type="button"
                                    onClick={() => setPickedType((p) => ({ ...p, [m.id]: v }))}
                                    style={{
                                      border: "none", borderRight: "1px solid var(--line)", padding: "3px 10px",
                                      fontSize: 11, cursor: "pointer",
                                      background: t === v ? "var(--primary-soft)" : "var(--paper)",
                                      color: t === v ? "var(--primary)" : "var(--ink)", fontWeight: t === v ? 600 : 400,
                                    }}
                                  >{label}</button>
                                ))}
                              </div>
                            ) : (
                              <span style={{ fontSize: 11 }}>{sel.vcf ? "VCF only" : sel.paired ? "FASTQ R1 + R2" : "R1 only"}</span>
                            )}
                            <span style={{ fontSize: 11 }}>
                              {t === "vcf" ? "Partner-called VCF (annotation + ACMG)" : "Re-call from reads (BWA-MEM + GATK, ~30–60 min)"} · {humanBytes(total)}
                            </span>
                            <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                              {sel.files.map((f) => f.name).join("  ·  ")}
                            </span>
                          </div>
                        );
                      })() : null}
                    </div>
                  );
                }
                if (inputType === "fastq") {
                  const r1 = staged[m.id];
                  const r2 = staged[`${m.id}__R2`];
                  return (
                    <div key={m.id} style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{capitalize(m.role)} · <span className="mono">{m.id}</span></div>
                      <FileDropzone
                        label="R1 · forward reads"
                        hint="Drop R1 .fastq.gz"
                        staged={r1 ?? null}
                        onStage={(s) => handleStage(m.id, s)}
                        onClear={() => clearStage(m.id)}
                      />
                      <FileDropzone
                        label="R2 · reverse reads"
                        hint="Drop R2 .fastq.gz"
                        staged={r2 ?? null}
                        onStage={(s) => handleStage(`${m.id}__R2`, s)}
                        onClear={() => clearStage(`${m.id}__R2`)}
                      />
                      {r1 && r1.kind !== "fastq" ? <div className="sample-map warn">R1 must be a FASTQ file</div> : null}
                      {r2 && r2.kind !== "fastq" ? <div className="sample-map warn">R2 must be a FASTQ file</div> : null}
                    </div>
                  );
                }
                const sf = staged[m.id];
                const effectiveRole = sf?.reassignedTo ?? m.id;
                const effectiveMember = pedigree.members.find((x) => x.id === effectiveRole) ?? m;
                const nameMatches = sf?.sample ? autoMapSample(sf.sample, effectiveMember.role, sf.file.name) : true;
                const showReassign = !!sf?.sample && !nameMatches && !sf.ackMismatch;
                const otherMembers = pedigree.members.filter((x) => !x.missing && x.id !== m.id);

                return (
                  <div key={m.id} style={{ display: "grid", gap: 6 }}>
                    <FileDropzone
                      label={`${capitalize(m.role)} · ${m.id}`}
                      hint={`Drop ${m.role}'s VCF here`}
                      staged={sf ?? null}
                      onStage={(s) => handleStage(m.id, s)}
                      onClear={() => clearStage(m.id)}
                    />
                    {sf?.sample && nameMatches ? (
                      <div className="sample-map ok">
                        VCF sample <span className="mono">{sf.sample}</span> → {effectiveMember.role}
                        {sf.reassignedTo ? <span className="warn-tag" style={{ background: "var(--primary)" }}>reassigned</span> : null}
                      </div>
                    ) : showReassign ? (
                      <div className="sample-map warn" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span>VCF sample <span className="mono">{sf!.sample}</span></span>
                          <span className="warn-tag">name mismatch with role <em>{m.role}</em></span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>Reassign to:</span>
                          <select
                            value={sf!.reassignedTo ?? ""}
                            onChange={(e) => setStaged((s) => ({ ...s, [m.id]: { ...sf!, reassignedTo: e.target.value || undefined } }))}
                            style={{ fontSize: 11, padding: "2px 4px" }}
                          >
                            <option value="">— select role —</option>
                            {otherMembers.map((o) => (
                              <option key={o.id} value={o.id}>{capitalize(o.role)} ({o.id})</option>
                            ))}
                          </select>
                          <button
                            style={{ fontSize: 11, padding: "2px 8px" }}
                            onClick={() => setStaged((s) => ({ ...s, [m.id]: { ...sf!, ackMismatch: true } }))}
                            title="Trust the role assignment even if sample name doesn't match"
                          >Use anyway</button>
                        </div>
                      </div>
                    ) : sf?.sample && sf.ackMismatch ? (
                      <div className="sample-map" style={{ background: "rgba(180,84,30,0.04)", color: "var(--ink-soft)" }}>
                        <span className="mono">{sf.sample}</span> → {m.role}
                        <span className="warn-tag" style={{ background: "var(--ink-soft)" }}>override</span>
                      </div>
                    ) : sf && sf.kind !== "vcf" && sf.kind !== "vcf_gz" ? (
                      <div className="sample-map">
                        {sf.kind === "bam" ? "BAM staged (no sample extraction)" : ""}
                      </div>
                    ) : sf && sf.sniffOk === false ? (
                      <div className="sample-map warn">{sf.sniffError ?? "Could not read header"}</div>
                    ) : null}
                  </div>
                );
              })}

              {pedigree.members.filter((m) => m.missing).map((m) => (
                <div key={m.id} className="drop" style={{ borderStyle: "dashed", borderColor: "var(--accent)", cursor: "default" }}>
                  <div className="drop-label"><strong>{capitalize(m.role)} · {m.id}</strong></div>
                  <div className="drop-empty">
                    <div style={{ color: "var(--accent)" }}>No sample provided</div>
                    <div className="drop-formats">Engine will skip this member's genotypes</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div
        style={{
          position: "sticky", bottom: 0, background: "var(--bg)",
          padding: "16px 0", borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 16, gap: 16,
        }}
      >
        <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
          Pedigree {pedigree.members.length >= 1 ? "✓" : "·"}
          {" · "}HPO {hpo.length >= 1 ? "✓" : "·"}
          {" · "}History {history.trim().length >= 20 ? "✓" : "·"}
          {" · "}Proband {inputType === "library" ? "sample" : inputType === "fastq" ? "FASTQ" : "data"} {probandStaged ? "✓" : "·"}
          {" · "}{inputType === "library" ? "Samples" : inputType === "fastq" ? "Pairs" : "Files"} <span className="mono">{vcfReadyCount}/{presentMembers.length}</span>
          {missingCount ? <span style={{ color: "var(--accent)", marginLeft: 4 }}>({missingCount} no sample)</span> : null}
          {unresolvedMismatches.length ? <span style={{ color: "var(--accent)", marginLeft: 8 }}>· {unresolvedMismatches.length} unresolved mismatch</span> : null}
          {runMsg ? <span style={{ marginLeft: 16, color: runStage === "error" ? "var(--accent)" : "var(--primary)" }}>{runMsg}</span> : null}
        </span>
        <button className="primary" disabled={!ready} onClick={runAnalysis}>
          {runStage === "uploading" ? "Uploading…" : runStage === "submitted" ? "Running…" : "Run analysis"}
        </button>
      </div>
    </>
  );
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
