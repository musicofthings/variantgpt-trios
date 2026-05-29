/** Per-case localStorage keys + helpers for the variant-curation hand-off.
 *
 * Flow:  Workbench (shortlist) ──▶ Analysis Workbench (finalize) ──▶ Report
 *   - SELECTION_KEY  : variants checked in the Workbench (the analysis shortlist)
 *   - FINAL_KEY      : variants the analyst confirmed in the Analysis Workbench
 *   - PHENO_ALGO_KEY : the phenotype-ranking algorithm last chosen for this case
 */
import type { PhenotypeAlgorithm } from "./types";

export const SELECTION_KEY = (caseId: string) => `vgpt:selection:${caseId}`;
export const FINAL_KEY = (caseId: string) => `vgpt:final:${caseId}`;
export const PHENO_ALGO_KEY = (caseId: string) => `vgpt:pheno-algo:${caseId}`;

export function readIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function writeIdSet(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* quota or private mode — non-fatal */
  }
}

export function readPhenoAlgo(caseId: string, fallback: PhenotypeAlgorithm): PhenotypeAlgorithm {
  try {
    const v = localStorage.getItem(PHENO_ALGO_KEY(caseId));
    return v === "coverage" || v === "resnik" || v === "phrank" ? v : fallback;
  } catch {
    return fallback;
  }
}
