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
