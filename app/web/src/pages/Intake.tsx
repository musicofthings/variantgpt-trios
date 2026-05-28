import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Pedigree } from "../components/Pedigree";
import { FileDropzone, type StagedFile } from "../components/FileDropzone";
import { RunMonitor, useJobStatus } from "../components/RunMonitor";
import { HpoSearch, type HpoHit } from "../components/HpoSearch";
import { pedigreeForMode, type PedigreeState } from "../types-pedigree";
import { autoMapSample, sniffFile } from "../vcfSniff";
import { api, apiFetch } from "../apiBase";

/** Mode → human label for the topbar pill. Drives only display; the engine
 *  reasons about whichever members the pedigree contains. */
const MODE_LABEL: Record<string, string> = {
  singleton: "Singleton pipeline",
  duo: "Duo pipeline",
  trio: "Trio pipeline",
};

/** Case intake (design spec §4.2 + PRD §4.1). Vertical sectioned flow.
 * Final step uploads VCF/BAM to the dev API and triggers an engine run. */

interface HPOEntry { id: string; label?: string; confirmed: boolean; }

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

  const suggested = useMemo<HPOEntry[]>(() => {
    const text = history.toLowerCase();
    const hits: HPOEntry[] = [];
    if (/seizure|epilep|convuls/.test(text)) hits.push({ id: "HP:0001250", label: "Seizure", confirmed: false });
    if (/(developmental|global) delay|gdd/.test(text)) hits.push({ id: "HP:0001263", label: "Global developmental delay", confirmed: false });
    if (/regress/.test(text)) hits.push({ id: "HP:0002376", label: "Developmental regression", confirmed: false });
    if (/microcephal/.test(text)) hits.push({ id: "HP:0000252", label: "Microcephaly", confirmed: false });
    if (/anemi|haemoglob|hemoglob|hbe|sickle/.test(text)) hits.push({ id: "HP:0001903", label: "Anemia", confirmed: false });
    return hits.filter((s) => !hpo.some((h) => h.id === s.id));
  }, [history, hpo]);

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
    setHpo([...hpo, { id: hit.id, label: hit.label, confirmed: true }]);
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
    }
  }

  function clearStage(role: string) {
    setStaged((s) => { const c = { ...s }; delete c[role]; return c; });
  }

  // Members the user actively expects to sequence (excludes "no sample" parents).
  const presentMembers = pedigree.members.filter((m) => !m.missing);
  const missingCount = pedigree.members.length - presentMembers.length;
  const proband = pedigree.members.find((m) => m.role === "proband");

  const stagedVcfRoles = Object.entries(staged)
    .filter(([_, sf]) => sf && (sf.kind === "vcf" || sf.kind === "vcf_gz") && !sf.error)
    .map(([role]) => role);
  const vcfReadyCount = stagedVcfRoles.length;
  const probandStaged = !!(proband && stagedVcfRoles.includes(proband.id));

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
    const mapped = autoMapSample(sf.sample, member.role);
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
    setRunMsg("Uploading VCFs…");
    try {
      // 1. For each staged VCF, request a presigned upload URL from the API, then
      //    PUT the bytes directly to it. In prod the URL points at R2 (bytes never
      //    touch the Worker); in dev the Vite middleware returns its own URL.
      for (const [role, sf] of Object.entries(staged)) {
        if (!sf || sf.kind === "bai") continue;
        if (sf.kind === "bam") throw new Error("BAM-to-VCF calling is out of scope; please upload a VCF.");
        const target = sf.reassignedTo ?? role;
        const ext = sf.file.name.toLowerCase().endsWith(".gz") ? "vcf.gz" : "vcf";
        const urlResp = await fetch(
          api(`/cases/${caseId}/upload-url/${target}?filename=${encodeURIComponent(sf.file.name)}`),
        );
        if (!urlResp.ok) throw new Error(`signing ${role} failed: ${urlResp.status}`);
        const { url } = await urlResp.json() as { url: string };
        const put = await fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: sf.file,
        });
        if (!put.ok) throw new Error(`upload ${role} failed: ${put.status}`);
        setRunMsg(`Uploaded ${target}.${ext}`);
      }

      // 2. Trigger engine run with manifest.
      setRunMsg("Submitting run…");
      // Resolve reassignments: if VCF was reassigned to a different role, key the manifest
      // by the TARGET role, not the dropzone role.
      const files: Record<string, string> = {};
      for (const [role, sf] of Object.entries(staged)) {
        if (!sf || (sf.kind !== "vcf" && sf.kind !== "vcf_gz")) continue;
        const target = sf.reassignedTo ?? role;
        const ext = sf.file.name.toLowerCase().endsWith(".gz") ? "vcf.gz" : "vcf";
        files[target] = `${target}.${ext}`;
      }
      const manifest = {
        pedigree: pedigree.members.map((m) => ({
          id: m.id, role: m.role, sex: m.sex, affected: m.affected,
          sample_name: staged[m.id]?.sample ?? m.sample_name ?? m.id,
          missing: !!m.missing,
        })),
        consanguineous: pedigree.consanguineous,
        hpo: hpo.map((h) => ({ id: h.id, label: h.label ?? null })),
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
          <a href="#sec-vcf" style={{ color: "var(--ink-soft)" }}>4. VCF / BAM upload</a>
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
                <span key={s.id} className="hpo-chip suggested" title="AI-suggested — confirm to add">
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
            <p style={{ color: "var(--ink-soft)", marginTop: 8, fontSize: 12 }}>
              {suggested.length
                ? `${suggested.length} HPO ${suggested.length === 1 ? "term" : "terms"} suggested above — click + to confirm.`
                : "Save history to surface LLM-extracted HPO candidates. Fields populated here render on page 1 of the report."}
            </p>
          </section>

          <section id="sec-vcf" className="card" style={{ marginBottom: 24 }}>
            <h3>4. VCF / BAM upload</h3>
            <p style={{ color: "var(--ink-soft)", marginTop: 4 }}>
              One drop-zone per pedigree member. Accepts <code className="mono">.vcf</code>,{" "}
              <code className="mono">.vcf.gz</code> (bgzipped OK),{" "}
              <code className="mono">.bam</code>{" "}<span style={{ opacity: 0.7 }}>(BAM is staged but v1 expects post-calling VCF — PRD §1)</span>.
              Sample names are read from the VCF header in-browser and matched to roles.
            </p>

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
                const sf = staged[m.id];
                const effectiveRole = sf?.reassignedTo ?? m.id;
                const effectiveMember = pedigree.members.find((x) => x.id === effectiveRole) ?? m;
                const nameMatches = sf?.sample ? autoMapSample(sf.sample, effectiveMember.role) : true;
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
          {" · "}Proband VCF {probandStaged ? "✓" : "·"}
          {" · "}VCFs <span className="mono">{vcfReadyCount}/{presentMembers.length}</span>
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
