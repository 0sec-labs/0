import { describe, expect, it } from "vitest";
import { DEFAULT_FINDING_FILTERS, fixPrByFindingId, groupBySeverity, matchesFilters, normalizeSeverity, prLabel, severityCounts } from "../src/console/panel/views/findings-model";
import { buildEvidence, clipEvidence, evidenceArtifactCount } from "../src/console/panel/views/evidence-model";
import type { FindingGroup } from "../src/types";

const group = (id: string, severity: string, extra: Partial<FindingGroup["latest"]> = {}, consensus = "pending", signal = "weak"): FindingGroup => ({
  fingerprint: `fp-${id}`, count: 1, scanCount: 1,
  latest: { id, scanId: "s", title: `T ${id}`, description: "", severity, category: "c", status: "unverified", triageStatus: "new", timestamp: 1, evidenceRequest: "", evidenceResponse: "", ...extra },
  workflow: { consensus, evidenceSignal: signal } as FindingGroup["workflow"],
});

describe("findings model", () => {
  it("normalizes severity and groups critical first, newest first, omitting empties", () => {
    expect(normalizeSeverity(" HIGH ")).toBe("high");
    expect(normalizeSeverity("weird")).toBe("info");
    const result = groupBySeverity([group("a", "low"), group("b", "critical", { timestamp: 1 }), group("c", "critical", { timestamp: 5 })]);
    expect(result.map(item => item.severity)).toEqual(["critical", "low"]);
    expect(result[0]!.findings.map(item => item.latest.id)).toEqual(["c", "b"]);
    expect(severityCounts([group("a", "low"), group("b", "low")]).low).toBe(2);
  });
  it("filters by status and severity", () => {
    const fixed = group("f", "high", { status: "fixed" });
    const verified = group("v", "high", {}, "verified");
    const fp = group("p", "high", {}, "false-positive");
    expect(matchesFilters(fixed, { ...DEFAULT_FINDING_FILTERS, status: "fixed" })).toBe(true);
    expect(matchesFilters(fixed, { ...DEFAULT_FINDING_FILTERS, status: "open" })).toBe(false);
    expect(matchesFilters(verified, { ...DEFAULT_FINDING_FILTERS, status: "verified" })).toBe(true);
    expect(matchesFilters(fp, { ...DEFAULT_FINDING_FILTERS, status: "open" })).toBe(false);
    expect(groupBySeverity([fixed, group("l", "low")], { status: "all", severity: "low" }).map(item => item.severity)).toEqual(["low"]);
  });
  it("joins fix PRs by finding id", () => {
    const map = fixPrByFindingId([
      { finding: { id: "a" }, published: { prUrl: "https://github.com/o/r/pull/12" } },
      { finding: { id: "a" }, published: { prUrl: "https://github.com/o/r/pull/13" } },
      { finding: { id: "b" } },
    ]);
    expect(map.get("a")).toBe("https://github.com/o/r/pull/12");
    expect(map.has("b")).toBe(false);
    expect(fixPrByFindingId(undefined).size).toBe(0);
    expect(prLabel("https://github.com/o/r/pull/12")).toBe("#12");
    expect(prLabel("https://example.com/x")).toBe("PR");
  });
});

describe("evidence model", () => {
  it("shapes artifacts, skips empty findings, sorts by severity", () => {
    const items = buildEvidence([
      group("low", "low", { evidenceRequest: "GET /" }),
      group("none", "critical"),
      group("hi", "high", { evidenceRequest: "POST /", evidenceResponse: " 200 ", evidenceAnalysis: "why" }, "pending", "strong"),
    ]);
    expect(items.map(item => item.findingId)).toEqual(["hi", "low"]);
    expect(items[0]!.artifacts.map(item => item.kind)).toEqual(["request", "response", "analysis"]);
    expect(items[0]!.artifacts[1]!.text).toBe("200");
    expect(items[0]!.signal).toBe("strong");
    expect(evidenceArtifactCount(items)).toBe(4);
  });
  it("filters traffic vs analysis and clips huge payloads", () => {
    const g = group("a", "high", { evidenceRequest: "r", evidenceAnalysis: "x" });
    expect(buildEvidence([g], "traffic")[0]!.artifacts.map(item => item.kind)).toEqual(["request"]);
    expect(buildEvidence([g], "analysis")[0]!.artifacts.map(item => item.kind)).toEqual(["analysis"]);
    expect(clipEvidence("a".repeat(30), 10)).toContain("truncated (20 more");
    expect(clipEvidence(null)).toBe("");
  });
});
