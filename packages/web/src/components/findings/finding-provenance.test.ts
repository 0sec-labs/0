import { describe, expect, it } from "vitest";
import { provenanceLabel } from "./finding-provenance";

describe("provenanceLabel", () => {
  it("names the scan target and date", () => {
    expect(provenanceLabel({ kind: "scan", target: "https://a.example", startedAt: "2026-03-04T10:00:00Z", scanId: "run-1" })).toMatch(/^From scan https:\/\/a\.example on .*2026/);
  });
  it("names an Agent and a thread in plain words", () => {
    expect(provenanceLabel({ kind: "agent", agent: "Reviewer", target: "repo", startedAt: "2026-03-04T10:00:00Z", scanId: "x" })).toBe("From Agent Reviewer");
    expect(provenanceLabel({ kind: "thread", target: "repo", startedAt: "2026-03-04T10:00:00Z", scanId: "console-1" })).toBe("From thread");
  });
  it("says nothing when the source is unknown", () => {
    expect(provenanceLabel({ kind: "unknown", scanId: "x" })).toBeNull();
    expect(provenanceLabel(undefined)).toBeNull();
  });
  it("falls back to the run id when a scan has no target and tolerates a bad date", () => {
    expect(provenanceLabel({ kind: "scan", target: "", startedAt: "nope", scanId: "abcdef123456" })).toBe("From scan abcdef12");
  });
});
