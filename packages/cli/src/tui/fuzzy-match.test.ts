import { describe, expect, it } from "vitest";

import { fuzzyMatches, fuzzyScore, rankFuzzy } from "./fuzzy-match.js";

describe("fuzzyScore — subsequence matching", () => {
  it("matches characters in order, not necessarily adjacent", () => {
    // "oa" → the o of Open, then the a of agents.
    expect(fuzzyScore("oa", "Open agents")).not.toBeNull();
    expect(fuzzyMatches("oa", "Open agents")).toBe(true);
    expect(fuzzyMatches("opag", "Open agents")).toBe(true);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "Open")).toBeNull();
    expect(fuzzyScore("po", "Open")).toBeNull(); // right chars, wrong order
    expect(fuzzyMatches("zzz", "agents")).toBe(false);
  });

  it("treats an empty or whitespace query as a neutral match (score 0)", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });

  it("returns null for a non-empty query against an empty target", () => {
    expect(fuzzyScore("a", "")).toBeNull();
  });

  it("is case-insensitive on both sides", () => {
    expect(fuzzyScore("OP", "open")).toBe(fuzzyScore("op", "open"));
    expect(fuzzyMatches("OpEn", "OPEN AGENTS")).toBe(true);
  });
});

describe("fuzzyScore — ranking: prefix > word-boundary > scattered", () => {
  const query = "op";
  const prefix = fuzzyScore(query, "Open")!;
  const boundary = fuzzyScore(query, "Backup Ops")!;
  const scattered = fuzzyScore(query, "topology")!;

  it("all three targets match", () => {
    expect(prefix).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(scattered).not.toBeNull();
  });

  it("ranks a prefix match highest", () => {
    expect(prefix).toBeGreaterThan(boundary);
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("ranks a word-boundary match above a scattered one", () => {
    expect(boundary).toBeGreaterThan(scattered);
  });

  it("treats a camelCase hump as a word boundary", () => {
    // "oa" hits the 'A' hump of openAgents — better than the mid-word "float".
    const hump = fuzzyScore("oa", "openAgents")!;
    const mid = fuzzyScore("oa", "floaty")!;
    expect(hump).toBeGreaterThan(mid);
  });

  it("rewards contiguous matches over gappy ones for the same tier", () => {
    const contiguous = fuzzyScore("op", "op-thing")!; // prefix, adjacent
    const gappy = fuzzyScore("op", "o-x-p-thing")!; // prefix start, then a gap
    expect(contiguous).toBeGreaterThan(gappy);
  });
});

describe("rankFuzzy", () => {
  interface Row { readonly label: string }
  const rows: Row[] = [
    { label: "topology" },
    { label: "Open agents" },
    { label: "Backup Ops" },
    { label: "unrelated" },
  ];

  it("keeps only matches, best score first", () => {
    const ranked = rankFuzzy(rows, "op", (r) => r.label);
    // "unrelated" (no subsequence "op") is dropped; the rest rank by score.
    expect(ranked.map((r) => r.item.label)).toEqual([
      "Open agents",
      "Backup Ops",
      "topology",
    ]);
    expect(ranked.every((r) => r.score !== null)).toBe(true);
  });

  it("returns the input order untouched for an empty query", () => {
    const ranked = rankFuzzy(rows, "", (r) => r.label);
    expect(ranked.map((r) => r.item.label)).toEqual(rows.map((r) => r.label));
  });

  it("is stable for equal scores (input order preserved)", () => {
    const tied: Row[] = [{ label: "same" }, { label: "same" }, { label: "same" }];
    const marked = tied.map((r, i) => ({ ...r, i }));
    const ranked = rankFuzzy(marked, "same", (r) => r.label);
    expect(ranked.map((r) => r.item.i)).toEqual([0, 1, 2]);
  });

  it("bounds the result count with limit", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ label: `open-${i}` }));
    expect(rankFuzzy(many, "open", (r) => r.label, 10)).toHaveLength(10);
    expect(rankFuzzy(many, "open", (r) => r.label, 0)).toHaveLength(0);
  });
});
