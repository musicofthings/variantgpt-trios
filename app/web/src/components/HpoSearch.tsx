import { useEffect, useRef, useState } from "react";
import { api, apiFetch } from "../apiBase";

export interface HpoHit {
  id: string;          // "HP:0001250"
  label: string;
  definition?: string;
  synonyms?: string[];
}

interface Props {
  /** IDs already selected — hidden from results so we don't suggest duplicates. */
  excludeIds: string[];
  onPick: (hit: HpoHit) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Debounced typeahead against /api/hpo/search (which proxies EBI OLS4).
 *
 * Behavior:
 *   - Type ≥2 chars → debounced fetch after 200ms idle.
 *   - Arrow up/down navigates results; Enter picks the highlighted row.
 *   - Esc clears the input and closes the dropdown.
 *   - Click outside closes.
 *
 * Accepts both label text ("seiz") and partial IDs ("HP:00012") — the Worker
 * passes the raw query through to OLS, which matches both fields.
 */
export function HpoSearch({ excludeIds, onPick, placeholder, autoFocus }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HpoHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce + abort: a stale in-flight request (older keystroke) must never
  // overwrite results from a newer one.
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]); setError(null); setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const res = await apiFetch(api(`/hpo/search?q=${encodeURIComponent(q.trim())}&limit=12`), {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { results: HpoHit[] };
        const filtered = data.results.filter((h) => !excludeIds.includes(h.id));
        setHits(filtered);
        setActive(0);
        setOpen(true);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError((e as Error).message);
          setHits([]);
        }
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, excludeIds]);

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(hit: HpoHit) {
    onPick(hit);
    setQ("");
    setHits([]);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault(); pick(hits[active]);
    } else if (e.key === "Escape") {
      e.preventDefault(); setQ(""); setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="hpo-search" style={{ position: "relative" }}>
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => { if (hits.length) setOpen(true); }}
        onKeyDown={onKey}
        placeholder={placeholder ?? "Search HPO — type a phenotype (e.g. \"seizure\") or HP id"}
        aria-label="Search HPO terms"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="hpo-listbox"
        role="combobox"
        style={{ width: "100%" }}
      />
      {(loading || error) && (
        <div style={{ fontSize: 12, color: error ? "var(--rust)" : "var(--ink-soft)", marginTop: 4 }}>
          {loading ? "Searching…" : error}
        </div>
      )}
      {open && hits.length > 0 && (
        <ul
          id="hpo-listbox"
          role="listbox"
          className="hpo-results"
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
            margin: 0,
            padding: 4,
            listStyle: "none",
          }}
        >
          {hits.map((h, i) => (
            <li
              key={h.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }}
              style={{
                padding: "8px 10px",
                borderRadius: 4,
                cursor: "pointer",
                background: i === active ? "var(--paper-soft, #f6f1e6)" : "transparent",
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                columnGap: 10,
                alignItems: "baseline",
              }}
            >
              <span className="mono" style={{ color: "var(--ink-soft)", fontSize: 12 }}>{h.id}</span>
              <span style={{ fontFamily: "var(--font-body)" }}>
                <strong style={{ fontWeight: 500 }}>{h.label}</strong>
                {h.synonyms && h.synonyms.length > 0 && (
                  <span style={{ color: "var(--ink-soft)", fontSize: 12, marginLeft: 6 }}>
                    · {h.synonyms[0]}
                  </span>
                )}
                {h.definition && (
                  <div style={{ color: "var(--ink-soft)", fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.definition}
                  </div>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
