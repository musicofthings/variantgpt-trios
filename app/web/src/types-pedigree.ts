/** Pedigree types (PRD §4.1). Persisted as PED + JSON server-side; this is the UI shape. */
export type Sex = "male" | "female" | "unknown";
export type PedRole = "proband" | "father" | "mother" | "sibling" | "other";

export interface PedMember {
  id: string;
  role: PedRole;
  sex: Sex;
  affected: boolean;
  sample_name: string;
  vcf_filename?: string;
  /** True if no VCF will be provided for this member (e.g. parent not sequenced).
   * Per PRD §4.1: "missing members (e.g., duo with one parent)" — engine reasons
   * over whichever members are present and degrades inheritance models gracefully. */
  missing?: boolean;
}

export interface PedigreeState {
  members: PedMember[];
  consanguineous: boolean;
}

export const DEFAULT_TRIO: PedigreeState = {
  consanguineous: false,
  members: [
    { id: "father",  role: "father",  sex: "male",    affected: false, sample_name: "" },
    { id: "mother",  role: "mother",  sex: "female",  affected: false, sample_name: "" },
    { id: "proband", role: "proband", sex: "unknown", affected: true,  sample_name: "" },
  ],
};

/** Singleton — proband only. Parents marked missing so de-novo and trans-phased
 *  comp-het auto-degrade in the engine; user can still toggle them present
 *  later if they realize they have one. */
export const DEFAULT_SINGLETON: PedigreeState = {
  consanguineous: false,
  members: [
    { id: "proband", role: "proband", sex: "unknown", affected: true, sample_name: "" },
  ],
};

/** Duo — proband + one parent. Defaults to mother present; the pedigree
 *  builder's "⇄ Use father instead" button (Pedigree.tsx) swaps to father
 *  in one click — the engine's de-novo logic treats either parent
 *  symmetrically (inheritance.py), so this is a UI-only choice. */
export const DEFAULT_DUO: PedigreeState = {
  consanguineous: false,
  members: [
    { id: "mother",  role: "mother",  sex: "female",  affected: false, sample_name: "" },
    { id: "proband", role: "proband", sex: "unknown", affected: true,  sample_name: "" },
  ],
};

/** Sibling-based duo — proband + one sibling, no parent sequenced at all
 *  (distinct from DEFAULT_DUO, which is proband + one parent). Defaults the
 *  sibling to unaffected: the most clinically common reason to reach for
 *  this shape is using a healthy full sibling to argue against a recessive
 *  candidate (engine: inheritance.py's AR-hom / unaffected-sibling check).
 *  Toggle the sibling to affected in the builder for the other supported
 *  case — a shared candidate between two affected sibs. Neither PS2 nor
 *  PM6 (de novo) are available with no parent present at all; the engine
 *  degrades gracefully rather than guessing. */
export const DEFAULT_SIBLING_DUO: PedigreeState = {
  consanguineous: false,
  members: [
    { id: "sibling", role: "sibling", sex: "unknown", affected: false, sample_name: "" },
    { id: "proband", role: "proband", sex: "unknown", affected: true,  sample_name: "" },
  ],
};

/** Resolve a pipeline-mode string from the home screen to its starting
 *  pedigree. Falls back to trio for unknown values. */
export function pedigreeForMode(mode?: string | null): PedigreeState {
  switch ((mode ?? "").toLowerCase()) {
    case "singleton": return DEFAULT_SINGLETON;
    case "duo": return DEFAULT_DUO;
    case "sibling_duo": return DEFAULT_SIBLING_DUO;
    case "trio": return DEFAULT_TRIO;
    default: return DEFAULT_TRIO;
  }
}
