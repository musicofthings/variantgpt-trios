import { describe, expect, it } from "vitest";
import { parsePhrases } from "./ai";

describe("parsePhrases", () => {
  it("parses a bare JSON array", () => {
    expect(parsePhrases('["seizures","microcephaly"]')).toEqual([
      "seizures",
      "microcephaly",
    ]);
  });

  it("strips a ```json fenced block", () => {
    const raw = '```json\n["global developmental delay", "hypotonia"]\n```';
    expect(parsePhrases(raw)).toEqual([
      "global developmental delay",
      "hypotonia",
    ]);
  });

  it("extracts the array even with surrounding prose", () => {
    const raw = 'Here are the terms:\n["ataxia","nystagmus"]\nHope that helps.';
    expect(parsePhrases(raw)).toEqual(["ataxia", "nystagmus"]);
  });

  it("falls back to newline/comma splitting", () => {
    const raw = "- seizures\n- microcephaly\n* hypotonia";
    expect(parsePhrases(raw)).toEqual(["seizures", "microcephaly", "hypotonia"]);
  });

  it("dedupes case-insensitively and trims", () => {
    expect(parsePhrases('["Seizures"," seizures ","SEIZURES"]')).toEqual([
      "Seizures",
    ]);
  });

  it("drops too-short and too-long entries", () => {
    const longPhrase = "x".repeat(90);
    expect(parsePhrases(`["a","ok term","${longPhrase}"]`)).toEqual(["ok term"]);
  });

  it("returns [] for empty or empty-array input", () => {
    expect(parsePhrases("")).toEqual([]);
    expect(parsePhrases("[]")).toEqual([]);
  });
});
