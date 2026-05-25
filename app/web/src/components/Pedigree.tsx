import { useState } from "react";
import type { PedigreeState, PedMember } from "../types-pedigree";

/** Minimal interactive pedigree (design spec §5.1, PRD §4.1).
 * Squares = male, circles = female, diamond = unknown sex;
 * filled = affected; small ↳ on the proband; dashed outline + "no sample"
 * tag on members marked missing (e.g. duo where one parent isn't sequenced).
 *
 * Interactions:
 *   - click       → toggle affected
 *   - selected member's chips below the pedigree → set sex, toggle no-sample
 *   - "Mark consanguinity" / "+ Add sibling" → bottom toolbar */
export function Pedigree({
  state,
  onChange,
}: { state: PedigreeState; onChange: (next: PedigreeState) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const update = (id: string, patch: Partial<PedMember>) =>
    onChange({ ...state, members: state.members.map((m) => m.id === id ? { ...m, ...patch } : m) });

  const father = state.members.find((m) => m.role === "father");
  const mother = state.members.find((m) => m.role === "mother");
  const proband = state.members.find((m) => m.role === "proband");
  const sibs = state.members.filter((m) => m.role === "sibling");
  const selected = state.members.find((m) => m.id === selectedId) ?? null;

  function onNodeClick(m: PedMember) {
    setSelectedId(m.id);
    update(m.id, { affected: !m.affected });
  }

  return (
    <div className="pedigree" aria-label="Pedigree">
      <div className="pedigree-row">
        {father ? <Node m={father} selected={selectedId === father.id} onClick={() => onNodeClick(father)} /> : null}
        {state.consanguineous ? <span className="consang-line" aria-label="Consanguineous" /> : <span style={{ width: 24 }} />}
        {mother ? <Node m={mother} selected={selectedId === mother.id} onClick={() => onNodeClick(mother)} /> : null}
      </div>
      <div className="pedigree-link" aria-hidden />
      <div className="pedigree-row">
        {proband ? <Node m={proband} selected={selectedId === proband.id} onClick={() => onNodeClick(proband)} /> : null}
        {sibs.map((s) => <Node key={s.id} m={s} selected={selectedId === s.id} onClick={() => onNodeClick(s)} />)}
      </div>

      {selected ? (
        <div className="ped-selected" role="group" aria-label={`Edit ${selected.role}`}>
          <div className="ped-selected-title">
            <span style={{ textTransform: "capitalize" }}>{selected.role}</span>
            <span className="ped-selected-sub">{selected.affected ? "affected" : "unaffected"}</span>
          </div>
          <div className="ped-selected-row">
            <span className="ped-selected-label">Sex</span>
            {(["male", "female", "unknown"] as const).map((sx) => (
              <button
                key={sx}
                aria-pressed={selected.sex === sx}
                onClick={() => update(selected.id, { sex: sx })}
                style={{
                  background: selected.sex === sx ? "var(--primary-soft)" : "var(--surface)",
                  borderColor: selected.sex === sx ? "var(--primary)" : "var(--border)",
                  fontSize: 11, padding: "3px 8px",
                }}
              >{sx}</button>
            ))}
          </div>
          <div className="ped-selected-row">
            <span className="ped-selected-label">VCF</span>
            <button
              aria-pressed={!selected.missing}
              onClick={() => update(selected.id, { missing: false })}
              style={{
                background: !selected.missing ? "var(--primary-soft)" : "var(--surface)",
                borderColor: !selected.missing ? "var(--primary)" : "var(--border)",
                fontSize: 11, padding: "3px 8px",
              }}
            >Available</button>
            <button
              aria-pressed={!!selected.missing}
              onClick={() => update(selected.id, { missing: true })}
              disabled={selected.role === "proband"}
              title={selected.role === "proband" ? "Proband VCF is required" : "Mark this member as not sequenced"}
              style={{
                background: selected.missing ? "rgba(180,84,30,0.08)" : "var(--surface)",
                borderColor: selected.missing ? "var(--accent)" : "var(--border)",
                color: selected.missing ? "var(--accent)" : undefined,
                fontSize: 11, padding: "3px 8px",
              }}
            >No sample</button>
            {selected.role !== "proband" ? (
              <button
                onClick={() => onChange({ ...state, members: state.members.filter((m) => m.id !== selected.id) })}
                style={{ marginLeft: "auto", fontSize: 11, padding: "3px 8px", color: "var(--accent)" }}
              >Remove</button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="ped-hint">Click a member to toggle affected status, then edit sex / VCF availability below.</p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          onClick={() => onChange({ ...state, consanguineous: !state.consanguineous })}
          aria-pressed={state.consanguineous}
        >
          {state.consanguineous ? "Consanguineous ✓" : "Mark consanguinity"}
        </button>
        {!father ? (
          <button onClick={() => onChange({ ...state, members: [...state.members, { id: "father", role: "father", sex: "male", affected: false, sample_name: "" }] })}>
            + Add father
          </button>
        ) : null}
        {!mother ? (
          <button onClick={() => onChange({ ...state, members: [...state.members, { id: "mother", role: "mother", sex: "female", affected: false, sample_name: "" }] })}>
            + Add mother
          </button>
        ) : null}
        <button
          onClick={() => onChange({
            ...state,
            members: [
              ...state.members,
              { id: `sib-${state.members.length}`, role: "sibling", sex: "unknown", affected: false, sample_name: "" },
            ],
          })}
        >
          + Add sibling
        </button>
      </div>
    </div>
  );
}

function Node({
  m, selected, onClick,
}: { m: PedMember; selected: boolean; onClick: () => void }) {
  const shape = m.sex === "male" ? "male" : m.sex === "female" ? "female" : "unknown";
  const cls = [
    "ped-node", shape,
    m.affected ? "affected" : "",
    m.role === "proband" ? "proband" : "",
    m.missing ? "missing" : "",
    selected ? "selected" : "",
  ].filter(Boolean).join(" ");
  return (
    <div style={{ display: "grid", justifyItems: "center", gap: 4 }}>
      <button
        type="button"
        className={cls}
        onClick={onClick}
        aria-label={`${m.role}, ${m.sex}, ${m.affected ? "affected" : "unaffected"}${m.missing ? ", no sample" : ""}`}
        title={`${m.role} · ${m.sex} · ${m.affected ? "affected" : "unaffected"}${m.missing ? " · no sample" : ""}`}
      >
        <span>{m.role[0].toUpperCase()}</span>
      </button>
      <span style={{ fontSize: 10, color: m.missing ? "var(--accent)" : "var(--ink-soft)" }}>
        {m.missing ? "no sample" : m.role}
      </span>
    </div>
  );
}
