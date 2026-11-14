/**
 * A scan whose AI layer was needed but skipped is partial, not clean.
 * `--static-only` makes the skip intentional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installPackageMock = vi.fn();
vi.mock("./package-ecosystems.js", () => ({
  installPackageForEcosystem: installPackageMock,
  runDependencyAuditForEcosystem: () => [],
}));
vi.mock("./shared-analysis.js", () => ({
  runFoxguardScan: () => [], runSemgrepScan: () => [],
  selectedStaticScanner: () => "foxguard", runSelectedStaticScan: () => [],
}));
const runAnalysisAgentMock = vi.fn();
vi.mock("./agent-runner.js", () => ({ runAnalysisAgent: runAnalysisAgentMock }));
vi.mock("./source-files.js", () => ({ collectScopeFiles: () => [], countScopeFilesUpTo: () => 0 }));
vi.mock("./runtime/registry.js", () => ({ detectAvailableRuntimes: async () => new Set<string>() }));
vi.mock("./runtime/llm-api.js", () => ({
  LlmApiRuntime: class {
    getConfigurationDiagnostics() { return { valid: false, reason: "no API key" }; }
    resolvedModel() { return undefined; }
  },
}));

const { runPipeline } = await import("./unified-pipeline.js");

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), `0-ai-skipped-${prefix}-`)); dirs.push(d); return d; };
beforeEach(() => {
  installPackageMock.mockReset().mockImplementation(() => { const d = tmp("pkg"); return { ecosystem: "npm", name: "left-pad", version: "1.0.0", path: d, tempDir: d }; });
  runAnalysisAgentMock.mockReset().mockResolvedValue({ findings: [] });
});
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

const base = () => ({ target: "left-pad", targetType: "npm-package" as const, depth: "quick" as const, format: "json" as const, dbPath: join(tmp("db"), "0.db") });

describe("runPipeline — skipped AI layer", () => {
  it("marks an explicit api runtime without a key as partial", async () => {
    const report = await runPipeline({ ...base(), runtime: "api" });
    expect(runAnalysisAgentMock).not.toHaveBeenCalled();
    expect(report.aiAnalysisSkipped).toBe(true);
    expect(report.executionSuccessful).toBe(false);
    expect(report.exitReason).toBe("partial");
  });

  it("marks auto with no usable model as partial", async () => {
    const report = await runPipeline({ ...base(), runtime: "auto" });
    expect(report.aiAnalysisSkipped).toBe(true);
    expect(report.executionSuccessful).toBe(false);
  });

  it("treats staticOnly as an intentional, successful static scan", async () => {
    const report = await runPipeline({ ...base(), runtime: "api", staticOnly: true });
    expect(runAnalysisAgentMock).not.toHaveBeenCalled();
    expect(report.aiAnalysisSkipped).toBeUndefined();
    expect(report.executionSuccessful).not.toBe(false);
    expect(report.exitReason).not.toBe("partial");
    expect(report.warnings.some(w => w.message.includes("--static-only"))).toBe(true);
  });
});
