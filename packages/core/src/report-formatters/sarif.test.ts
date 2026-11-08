import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@0/shared";
import { formatSarif } from "./sarif.js";

function physicalLocation(reviewAnnotation?: Finding["reviewAnnotation"], target = "/home/runner/work/app/app"): unknown {
  const report: ScanReport = {
    target,
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
      artifactLocation: { uri: "file:///home/runner/work/app/app/src/routes/download.ts" },
      region: { startLine: 42, endLine: 44 },
    });
  });

  it("keeps the cited file but drops an invalid cited line range", () => {
    expect(physicalLocation({ path: "src/routes/download.ts", startLine: 0 })).toEqual({
      artifactLocation: { uri: "file:///home/runner/work/app/app/src/routes/download.ts" },
    });
    expect(physicalLocation({ path: "src/routes/download.ts", startLine: 42, endLine: 40 })).toEqual({
      artifactLocation: { uri: "file:///home/runner/work/app/app/src/routes/download.ts" },
      region: { startLine: 42 },
    });
  });

  it("locates a finding without a source annotation at the scan target", () => {
    expect(physicalLocation()).toEqual({ artifactLocation: { uri: "/home/runner/work/app/app" } });
  });
  it.each([
    ["repo:/checkout/packages/api", "src/auth #1%?.ts", "file:///checkout/packages/api/src/auth%20%231%25%3F.ts"],
    ["packages/app@old", "src/auth.ts", "packages/app%40old/src/auth.ts"],
    ["@apps/api", "src/auth.ts", "%40apps/api/src/auth.ts"],
    ["\\\\server\\share\\api", "src/auth.ts", "file://server/share/api/src/auth.ts"],
    ["repo:packages/api", "src/auth.ts", "packages/api/src/auth.ts"],
    ["repo:.", "src/auth.ts", "src/auth.ts"],
    ["./packages/api", "src/ü.ts", "packages/api/src/%C3%BC.ts"],
    ["file:///checkout/packages/api", "src/auth.ts", "file:///checkout/packages/api/src/auth.ts"],
    ["C:\\checkout\\packages\\api", "src/auth.ts", "file:///C:/checkout/packages/api/src/auth.ts"],
    ["https://example.test/repository.git", "src/auth.ts", "src/auth.ts"],
  ])("anchors %s without using the renderer working directory", (target, path, uri) => {
    expect(physicalLocation({ path, startLine: 42 }, target)).toEqual({ artifactLocation: { uri }, region: { startLine: 42 } });
  });

  it.each(["../secret.ts", "/outside.ts", "C:\\outside.ts", "https://outside.test/a.ts"])("rejects invalid persisted annotation path %s", path => {
    expect(physicalLocation({ path, startLine: 42 }, "repo:packages/api")).toEqual({ artifactLocation: { uri: "repo:packages/api" } });
  });

});
