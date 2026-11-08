import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@0/shared";
import { formatSarif } from "./sarif.js";

function physicalLocation(reviewAnnotation?: Finding["reviewAnnotation"]): unknown {
  const report: ScanReport = {
    target: "/home/runner/work/app/app",
    scanDepth: "quick",
    startedAt: "2026-11-08T04:00:00.000Z",
    completedAt: "2026-11-08T04:01:00.000Z",
    durationMs: 60_000,
    warnings: [],
    summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    findings: [{
      id: "finding-1", templateId: "0:path-traversal", title: "Download route reads any file",
      description: "The download handler joins the user path to the storage root without containment.",
      severity: "high", category: "path-traversal", status: "confirmed",
      evidence: { request: "", response: "", analysis: "" },
      reviewAnnotation, timestamp: 1_794_110_400_000,
    }],
  };
  return JSON.parse(formatSarif(report)).runs[0].results[0].locations[0].physicalLocation;
}

describe("formatSarif", () => {
  it("locates a source-review finding at its cited file and lines", () => {
    expect(physicalLocation({ path: "src/routes/download.ts", startLine: 42, endLine: 44 })).toEqual({
      artifactLocation: { uri: "src/routes/download.ts" },
      region: { startLine: 42, endLine: 44 },
    });
  });

  it("keeps the cited file but drops an invalid cited line range", () => {
    expect(physicalLocation({ path: "src/routes/download.ts", startLine: 0 })).toEqual({
      artifactLocation: { uri: "src/routes/download.ts" },
    });
    expect(physicalLocation({ path: "src/routes/download.ts", startLine: 42, endLine: 40 })).toEqual({
      artifactLocation: { uri: "src/routes/download.ts" },
      region: { startLine: 42 },
    });
  });

  it("locates a finding without a source annotation at the scan target", () => {
    expect(physicalLocation()).toEqual({ artifactLocation: { uri: "/home/runner/work/app/app" } });
  });
});
