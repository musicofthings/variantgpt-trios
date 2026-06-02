/** Shared EBI OLS4 HPO lookup.
 *
 * Used by both the /api/hpo/search typeahead proxy and the AI HPO-extraction
 * route. Grounding model-proposed phenotype phrases through OLS guarantees the
 * returned HP: ids are real ontology terms — the model never gets to mint an id.
 */
export interface HpoResult {
  id: string;
  label: string;
  definition?: string;
  synonyms?: string[];
}

/** Query OLS4's /select autocomplete (prefix matching on label + synonym) for
 *  HPO terms. Returns [] on any upstream failure — callers degrade gracefully.
 *  No edge caching here; the typeahead route wraps this with the Cache API. */
export async function olsSelect(q: string, limit: number): Promise<HpoResult[]> {
  const query = (q ?? "").trim();
  if (query.length < 2) return [];

  const olsUrl = new URL("https://www.ebi.ac.uk/ols4/api/select");
  olsUrl.searchParams.set("q", query);
  olsUrl.searchParams.set("ontology", "hp");
  olsUrl.searchParams.set("rows", String(Math.min(Math.max(limit, 1), 25)));
  olsUrl.searchParams.set("fieldList", "obo_id,label,description,synonym,iri");

  let upstream: Response;
  try {
    upstream = await fetch(olsUrl.toString(), {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch {
    return [];
  }
  if (!upstream.ok) return [];

  const data = (await upstream.json().catch(() => ({}))) as {
    response?: {
      docs?: Array<{
        obo_id?: string;
        label?: string;
        description?: string[];
        synonym?: string[];
      }>;
    };
  };

  return (data.response?.docs ?? [])
    .filter((d) => d.obo_id?.startsWith("HP:"))
    .map((d) => ({
      id: d.obo_id!,
      label: d.label ?? "",
      definition: d.description?.[0],
      synonyms: d.synonym?.slice(0, 3),
    }));
}
