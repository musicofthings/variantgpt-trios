import { useState } from "react";
import type { EvidenceRow } from "../types";

/** Evidence ledger — design spec §4.4 + §5.5. The product's transparency centerpiece:
 * every ACMG criterion considered, grouped by Pathogenic / Benign, fired in full color,
 * not-fired muted. Each fired row expands to show the data point that triggered it. */
export function EvidenceLedger({ rows }: { rows: EvidenceRow[] }) {
  const pathogenic = rows.filter((r) => r.polarity === "P");
  const benign = rows.filter((r) => r.polarity === "B");

  return (
    <div className="ledger">
      <LedgerGroup title="Pathogenic" tone="warm" rows={pathogenic} />
      <LedgerGroup title="Benign" tone="cool" rows={benign} />
    </div>
  );
}

function LedgerGroup({
  title, tone, rows,
}: { title: string; tone: "warm" | "cool"; rows: EvidenceRow[] }) {
  if (!rows.length) return null;
  return (
    <section className={`ledger-group ledger-${tone}`}>
      <header className="ledger-group-header">
        <span>{title}</span>
        <span className="ledger-count">
          {rows.filter((r) => r.fired).length}/{rows.length} fired
        </span>
      </header>
      <ul className="ledger-list">
        {rows.map((r) => <LedgerRow key={r.criterion} row={r} />)}
      </ul>
    </section>
  );
}

function LedgerRow({ row }: { row: EvidenceRow }) {
  const [open, setOpen] = useState(false);
  const expandable = row.fired && (row.trigger || row.source);
  return (
    <li className={`ledger-row${row.fired ? " fired" : " muted"}`}>
      <button
        type="button"
        className="ledger-row-head"
        onClick={() => expandable && setOpen(!open)}
        aria-expanded={open}
        disabled={!expandable}
      >
        <span className="ledger-criterion mono">{row.criterion}</span>
        <span className="ledger-strength">{row.strength ?? (row.fired ? "" : "—")}</span>
        <span className="ledger-summary">{row.summary ?? (row.fired ? "Fired" : "Not fired")}</span>
        {expandable ? <span className="ledger-chev" aria-hidden>{open ? "▾" : "▸"}</span> : null}
      </button>
      {open && expandable ? (
        <div className="ledger-row-body">
          {row.trigger ? (
            <div><span className="ledger-label">Trigger</span><span className="mono">{row.trigger}</span></div>
          ) : null}
          {row.source ? (
            <div><span className="ledger-label">Source</span>{row.source}</div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
