/**
 * Coverage seed for `@0/cli`'s `run.ts` entry point. The two files
 * (`run.ts` + `scan.ts`) are the on-ramp every CLI user hits, yet they
 * had zero tests prior to this seed.
 *
 * Strategy: mock `@0/core` at the module boundary (the same boundary
 * `loadCoreModule` resolves), drive `runUnified` directly, and assert
 * on (a) which core entry point gets dispatched given `targetType`,
 * (b) how the runtime gate handles invalid runtime names, and
 * (c) the result-line + cost-summary shapes that downstream relays parse.
 *
 * Anything that requires real subprocesses (Ink/OpenTUI), real network
 * (cloud sink), or real LLM runtimes is intentionally out of scope.
 * The internal pure helpers (`toScanReport`, `printCostSummary`,
 * `emitResultLine`, `getCloudFinalSinkConfig`) are not exported from
 * `run.ts`, so we exercise them through their observable side effects
 * (stdout shape, dispatch routing, exit code). Promoting them to
 * exports would let us drop the mocks, but that's a refactor, not a
 * test seed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanReport } from "@0/shared";
import * as formatters from "../../formatters/index.js";

const { connectLocalEngineMock } = vi.hoisted(() => ({ connectLocalEngineMock: vi.fn() }));
vi.mock("../../local-engine.js", () => ({ connectLocalEngine: connectLocalEngineMock }));
beforeEach(() => { connectLocalEngineMock.mockReset().mockResolvedValue(null); });

// ── Module-level mocks ──────────────────────────────────────────────────────
//
// `runUnified` calls `loadCoreModule()` which does a dynamic
// `import("@0/core")`. Vitest hoists `vi.mock` so both static and
// dynamic imports see the stub.
//
// We expose four shims:
//   • agenticScan      — for url / web-app dispatch
//   • runPipeline      — for everything else (npm / pypi / source-code / …)
//   • createRuntime    — non-{api,auto} runtime availability probe
//   • eventBus         — the cost-summary subscription happens here
//
// Each test resets the mocks in beforeEach so call counts don't leak.

const agenticScanMock = vi.fn();
const runPipelineMock = vi.fn();
const createRuntimeMock = vi.fn();
const ScanCostLedgerMock = class {
  totalCostUsd() {
    return 0;
  }
};
const loadAppsecFinderLensesMock = vi.fn(() => []);
let eventBusListener:
  | { emit: (type: string, payload: unknown) => void }
  | null = null;
const eventBusMock = {
  subscribe(listener: { emit: (type: string, payload: unknown) => void }) {
    eventBusListener = listener;
    return () => {
      eventBusListener = null;
    };
  },
};

vi.mock("@0/core", async () => {
  const assessmentModuleUrl = new URL("../../../../core/src/assessment.ts", import.meta.url).href;
  const { executeAssessmentRun } = await import(assessmentModuleUrl);
  return ({
  executeAssessmentRun: (options: any, _dependencies: unknown, lifecycle: unknown) => executeAssessmentRun(options, {
    agenticScan: agenticScanMock, runPipeline: runPipelineMock, branchJournal: vi.fn(),
  }, lifecycle),
  agenticScan: agenticScanMock,
  runPipeline: runPipelineMock,
  createRuntime: createRuntimeMock,
  ScanCostLedger: ScanCostLedgerMock,
  eventBus: eventBusMock,
  loadAppsecFinderLenses: loadAppsecFinderLensesMock,
});
});


const workflowStoreMock = {
  createExecutionFromSnapshot: vi.fn(() => ({ id: "cli-run" })),
  updateExecution: vi.fn(), saveExecutionResults: vi.fn(),
  getExecution: vi.fn(() => ({ status: "running" })), close: vi.fn(),
};
vi.mock("@0/db", () => ({ SecurityWorkflowStore: class { constructor() { return workflowStoreMock; } } }));

// `runUnified` calls `checkRuntimeAvailability` for terminal format. We
// stub it to a no-op so tests don't probe the user's environment.
vi.mock("../../utils.js", () => ({
  checkRuntimeAvailability: vi.fn().mockResolvedValue(undefined),
  getRuntimeAvailability: vi.fn().mockResolvedValue({
    hasApiKey: false,
    availableRuntimes: [],
    apiRuntime: { providerLabel: "stub", configured: false, valid: false },
  }),
  buildShareUrl: vi.fn(),
}));

// Formatters: short-circuit to a fixed string so we don't import pdfkit
// / chalk-heavy renderers for a test that only cares about dispatch.
vi.mock("../../formatters/index.js", () => ({
  formatAuditReport: vi.fn(() => "FORMATTED_AUDIT"),
  formatReviewReport: vi.fn(() => "FORMATTED_REVIEW"),
  formatReport: vi.fn(() => "FORMATTED_REPORT"),
  generatePdfReport: vi.fn().mockResolvedValue(undefined),
}));

const { runUnified } = await import("../run.js");

// ── Test fixtures ───────────────────────────────────────────────────────────

function emptySummary(): ScanReport["summary"] {
  return {
    totalAttacks: 0,
    totalFindings: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
}

function cleanReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    target: "https://example.com",
    scanDepth: "default",
    startedAt: "2026-05-13T00:00:00.000Z",
    completedAt: "2026-05-13T00:00:01.000Z",
    durationMs: 1000,
    summary: emptySummary(),
    findings: [],
    warnings: [],
    ...overrides,
  };
}

interface ExitThrown extends Error {
  __exit: true;
  code: number;
}
/**
 * Stub `process.exit` so it throws a sentinel error (lets us inspect
 * the would-be exit code from the test). We also record the first
 * exit code on a shared marker — `run.ts` has a top-level catch that
 * calls `process.exit(2)` again when our throw re-raises out of the
 * try, so the *thrown* code we ultimately see can be 2 even when the
 * intended exit code is 1 or 4. The marker captures the original.
 */
interface ExitTracker {
  firstCode?: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeExitMock(tracker: ExitTracker): any {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    const c = (code ?? 0) as number;
    if (tracker.firstCode === undefined) tracker.firstCode = c;
    const err = new Error(`__exit__:${c}`) as ExitThrown;
    err.__exit = true;
    err.code = c;
    throw err;
  }) as never);
}

// ── Tests ───────────────────────────────────────────────────────────────────

/**
 * Module-shared tracker; replaced freshly in every `beforeEach` so a
 * leaked tracker can't bleed exit codes between tests.
 */
let tracker: ExitTracker;

describe("runUnified — runtime gating", () => {
  let exitSpy: { mockRestore: () => void };
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const mock of Object.values(workflowStoreMock)) mock.mockClear();
  agenticScanMock.mockReset();
    runPipelineMock.mockReset();
    createRuntimeMock.mockReset();
    eventBusListener = null;
    tracker = {};
    exitSpy = makeExitMock(tracker);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("rejects an unknown runtime with exit code 2", async () => {
    try {
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        // intentionally invalid; the valid set is api|claude|codex|gemini|auto
        runtime: "definitely-not-a-runtime" as never,
        timeout: 30000,
        verbose: false,
      });
    } catch {
      // process.exit throws by design — swallow
    }
    expect(tracker.firstCode).toBe(2);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(
      /Unknown runtime/,
    );
  });

  it("probes runtime availability for non-auto/non-api runtimes (exit 2 when missing)", async () => {
    createRuntimeMock.mockReturnValueOnce({
      isAvailable: vi.fn().mockResolvedValue(false),
    });
    try {
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "claude",
        timeout: 30000,
        verbose: false,
      });
    } catch {
      // expected
    }
    expect(createRuntimeMock).toHaveBeenCalledWith({ type: "claude", timeout: 30000 });
    expect(tracker.firstCode).toBe(2);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(
      /Runtime 'claude' not available/,
    );
  });

  it("skips the availability probe for 'auto' and 'api'", async () => {
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    await runUnified({
      target: "https://example.com",
      targetType: "url",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
    });
    expect(createRuntimeMock).not.toHaveBeenCalled();
    expect(agenticScanMock).toHaveBeenCalledOnce();
  });


  it("returns a findings outcome to the hosting TUI instead of terminating its process", async () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const sessionUi = {
      onEvent: vi.fn(),
      setReport: vi.fn(),
      waitForExit: vi.fn().mockResolvedValue(undefined),
    };
    try {
      agenticScanMock.mockResolvedValueOnce(cleanReport({
        summary: { ...emptySummary(), high: 1, low: 1, totalFindings: 2 },
      }));
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "terminal",
        runtime: "auto",
        timeout: 30000,
        verbose: false,
        sessionUiFactory: async () => sessionUi,
      });
      expect(sessionUi.setReport).toHaveBeenCalledOnce();
      expect(tracker.firstCode).toBeUndefined();
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });

  it("skips the Codex CLI availability probe when direct ChatGPT Codex auth is configured", async () => {
    const oldRefreshToken = process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
    process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] = "fake-refresh-token";
    try {
      agenticScanMock.mockResolvedValueOnce(cleanReport());
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "codex",
        timeout: 30000,
        verbose: false,
      });
    } finally {
      if (oldRefreshToken === undefined) {
        delete process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
      } else {
        process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] = oldRefreshToken;
      }
    }

    expect(createRuntimeMock).not.toHaveBeenCalled();
    expect(agenticScanMock).toHaveBeenCalledOnce();
    expect(agenticScanMock.mock.calls[0]?.[0]?.config.runtime).toBe("codex");
  });

  it("skips the Codex CLI availability probe when only ZERO_CHATGPT_ACCESS_TOKEN is set (cloud sandbox path)", async () => {
    // The 0-cloud worker forwards ZERO_CHATGPT_ACCESS_TOKEN to
    // sandboxes — NOT the refresh token — so the gate must accept the
    // access token alone, otherwise the CLI preflight tries to find a
    // Codex binary the sandbox image doesn't ship.
    const oldRefreshToken = process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
    const oldAccessToken = process.env["ZERO_CHATGPT_ACCESS_TOKEN"];
    delete process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
    process.env["ZERO_CHATGPT_ACCESS_TOKEN"] = "fake-access-token";
    try {
      agenticScanMock.mockResolvedValueOnce(cleanReport());
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "codex",
        timeout: 30000,
        verbose: false,
      });
    } finally {
      if (oldRefreshToken === undefined) {
        delete process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
      } else {
        process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] = oldRefreshToken;
      }
      if (oldAccessToken === undefined) {
        delete process.env["ZERO_CHATGPT_ACCESS_TOKEN"];
      } else {
        process.env["ZERO_CHATGPT_ACCESS_TOKEN"] = oldAccessToken;
      }
    }

    expect(createRuntimeMock).not.toHaveBeenCalled();
    expect(agenticScanMock).toHaveBeenCalledOnce();
    expect(agenticScanMock.mock.calls[0]?.[0]?.config.runtime).toBe("codex");
  });

  it("still probes the Codex CLI when neither ChatGPT env var is set (no direct provider)", async () => {
    const oldRefreshToken = process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
    const oldAccessToken = process.env["ZERO_CHATGPT_ACCESS_TOKEN"];
    delete process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
    delete process.env["ZERO_CHATGPT_ACCESS_TOKEN"];
    createRuntimeMock.mockReturnValueOnce({
      isAvailable: vi.fn().mockResolvedValue(false),
    });
    try {
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "codex",
        timeout: 30000,
        verbose: false,
      });
    } catch {
      // expected — process.exit throws by design
    } finally {
      if (oldRefreshToken !== undefined) {
        process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] = oldRefreshToken;
      }
      if (oldAccessToken !== undefined) {
        process.env["ZERO_CHATGPT_ACCESS_TOKEN"] = oldAccessToken;
      }
    }

    expect(createRuntimeMock).toHaveBeenCalledWith({ type: "codex", timeout: 30000 });
    expect(tracker.firstCode).toBe(2);
  });
});

describe("runUnified — dispatch routing on targetType", () => {
  let exitSpy: { mockRestore: () => void };
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const mock of Object.values(workflowStoreMock)) mock.mockClear();
  agenticScanMock.mockReset();
    runPipelineMock.mockReset();
    createRuntimeMock.mockReset();
    eventBusListener = null;
    tracker = {};
    exitSpy = makeExitMock(tracker);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("routes targetType=url to agenticScan with full config payload", async () => {
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    await runUnified({
      target: "https://example.com",
      targetType: "url",
      depth: "deep",
      format: "json",
      runtime: "auto",
      mode: "web",
      timeout: 30000,
      verbose: false,
      apiKey: "sk-fake",
      model: "gpt-4o",
      scopeFile: "/tmp/scope.json",
      rateLimit: "5",
      dispatchMode: "xml",
    });
    expect(agenticScanMock).toHaveBeenCalledOnce();
    expect(runPipelineMock).not.toHaveBeenCalled();
    const callArg = agenticScanMock.mock.calls[0]![0];
    expect(callArg.config.target).toBe("https://example.com");
    expect(callArg.config.mode).toBe("web");
    expect(callArg.config.runtime).toBe("auto");
    expect(callArg.config.dispatchMode).toBe("xml");
    expect(callArg.config.scopeFile).toBe("/tmp/scope.json");
  });

  it("routes targetType=web-app to agenticScan (not runPipeline)", async () => {
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    await runUnified({
      target: "https://example.com",
      targetType: "web-app",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
    });
    expect(agenticScanMock).toHaveBeenCalledOnce();
    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  it("routes targetType=npm-package to runPipeline", async () => {
    runPipelineMock.mockResolvedValueOnce({
      ...cleanReport(),
      targetType: "npm-package",
      package: "lodash",
      version: "1.0.0",
    } as never);
    await runUnified({
      target: "lodash",
      targetType: "npm-package",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
      packageVersion: "1.0.0",
    });
    expect(runPipelineMock).toHaveBeenCalledOnce();
    expect(agenticScanMock).not.toHaveBeenCalled();
    const callArg = runPipelineMock.mock.calls[0]![0];
    expect(callArg.target).toBe("lodash");
    expect(callArg.targetType).toBe("npm-package");
    expect(callArg.packageVersion).toBe("1.0.0");
  });

  it("routes targetType=source-code to runPipeline and forwards reviewProfile", async () => {
    runPipelineMock.mockResolvedValueOnce({
      ...cleanReport(),
      targetType: "source-code",
      repo: "/tmp/repo",
    } as never);
    await runUnified({
      target: "/tmp/repo",
      targetType: "source-code",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
      reviewProfile: "c-library",
    });
    expect(runPipelineMock).toHaveBeenCalledOnce();
    const callArg = runPipelineMock.mock.calls[0]![0];
    expect(callArg.targetType).toBe("source-code");
    expect(callArg.reviewProfile).toBe("c-library");
  });
});

describe("runUnified — exit codes", () => {
  let exitSpy: { mockRestore: () => void };
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const mock of Object.values(workflowStoreMock)) mock.mockClear();
  agenticScanMock.mockReset();
    runPipelineMock.mockReset();
    createRuntimeMock.mockReset();
    eventBusListener = null;
    tracker = {};
    exitSpy = makeExitMock(tracker);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("exit code 1 when high-severity findings are present", async () => {
    agenticScanMock.mockResolvedValueOnce(
      cleanReport({
        summary: { ...emptySummary(), totalFindings: 1, high: 1 },
      }),
    );
    try {
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "auto",
        timeout: 30000,
        verbose: false,
      });
    } catch {
      // expected — process.exit(1) is mocked to throw
    }
    expect(tracker.firstCode).toBe(1);
  });

  it("exit code 4 when costCeilingExceeded is set on the report", async () => {
    agenticScanMock.mockResolvedValueOnce(
      cleanReport({ costCeilingExceeded: true }),
    );
    try {
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "auto",
        timeout: 30000,
        verbose: false,
      });
    } catch {
      // expected
    }
    expect(tracker.firstCode).toBe(4);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(
      /cost ceiling exceeded/i,
    );
  });

  it("exit code 2 on a core-thrown error", async () => {
    agenticScanMock.mockRejectedValueOnce(new Error("kaboom"));
    try {
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "auto",
        timeout: 30000,
        verbose: false,
      });
    } catch {
      // expected
    }
    expect(tracker.firstCode).toBe(2);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(
      /kaboom/,
    );
  });
});

describe("runUnified — emitResultLine env gate", () => {
  let exitSpy: { mockRestore: () => void };
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const mock of Object.values(workflowStoreMock)) mock.mockClear();
  agenticScanMock.mockReset();
    runPipelineMock.mockReset();
    createRuntimeMock.mockReset();
    eventBusListener = null;
    tracker = {};
    exitSpy = makeExitMock(tracker);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    envSnapshot["ZERO_EMIT_RESULT_LINE"] = process.env["ZERO_EMIT_RESULT_LINE"];
    delete process.env["ZERO_EMIT_RESULT_LINE"];
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("does NOT emit ZERO_RESULT line without explicit opt-in", async () => {
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    await runUnified({
      target: "https://example.com",
      targetType: "url",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
    });
    const all = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(all).not.toMatch(/ZERO_RESULT=/);
  });

  it("emits ZERO_RESULT line when ZERO_EMIT_RESULT_LINE=1", async () => {
    process.env["ZERO_EMIT_RESULT_LINE"] = "1";
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    await runUnified({
      target: "https://example.com",
      targetType: "url",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
    });
    const line = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((s: string) => s.startsWith("ZERO_RESULT="));
    expect(line).toBeTruthy();
    const payload = JSON.parse(line!.slice("ZERO_RESULT=".length));
    expect(payload.ok).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(payload.exit_reason).toBe("completed");
    expect(payload.target).toBe("https://example.com");
    expect(payload.runtime).toBe("auto");
    expect(payload.format).toBe("json");
  });

  it("emits exit_reason=findings on the result line when findings raise exit 1", async () => {
    process.env["ZERO_EMIT_RESULT_LINE"] = "1";
    agenticScanMock.mockResolvedValueOnce(
      cleanReport({
        summary: { ...emptySummary(), totalFindings: 1, critical: 1 },
      }),
    );
    try {
      await runUnified({
        target: "https://example.com",
        targetType: "url",
        depth: "default",
        format: "json",
        runtime: "auto",
        timeout: 30000,
        verbose: false,
      });
    } catch {
      // expected — process.exit(1) is mocked to throw
    }
    const line = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((s: string) => s.startsWith("ZERO_RESULT="));
    expect(line).toBeTruthy();
    const payload = JSON.parse(line!.slice("ZERO_RESULT=".length));
    expect(payload.exitCode).toBe(1);
    expect(payload.exit_reason).toBe("findings");
    expect(payload.summary.critical).toBe(1);
  });
});

describe("runUnified — machine-readable output", () => {
  it("emits one parseable JSON report when cost and cross-validation diagnostics arrive", async () => {
    for (const mock of Object.values(workflowStoreMock)) mock.mockClear();
  agenticScanMock.mockReset();
    eventBusListener = null;
    // Load the actual formatter behind the module mock to check consumer JSON bytes.
    const actual = await vi.importActual<typeof formatters>("../../formatters/index.js");
    vi.mocked(formatters.formatReport).mockImplementationOnce(actual.formatReport);
    agenticScanMock.mockImplementationOnce(async () => {
      eventBusListener?.emit("scan_completed", { cost_usd: 0.42 });
      eventBusListener?.emit("cross_validated_leads", {
        count: 1, leads: [{ findingId: "lead", title: "Investigate tenant isolation", severity: "high", confidence: 0.8, foxguardMatches: 2 }],
      });
      return cleanReport({ estimatedCostUsd: 0.42 });
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runUnified({
        target: "https://example.com", targetType: "url", depth: "default",
        format: "json", runtime: "auto", timeout: 30_000, verbose: false,
      });
      const report = JSON.parse(output.mock.calls.map(call => String(call[0])).join("\n"));
      expect(report.target).toBe("https://example.com");
      expect(report.estimatedCostUsd).toBe(0.42);
    } finally {
      output.mockRestore();
    }
  });
});

describe("runUnified — resume / branch (0#374)", () => {
  let exitSpy: { mockRestore: () => void };
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const mock of Object.values(workflowStoreMock)) mock.mockClear();
  agenticScanMock.mockReset();
    runPipelineMock.mockReset();
    createRuntimeMock.mockReset();
    eventBusListener = null;
    tracker = {};
    exitSpy = makeExitMock(tracker);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("threads resumeScanId through to agenticScan for url targets", async () => {
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    await runUnified({
      target: "https://example.com",
      targetType: "url",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
      resumeScanId: "scan-abc-123",
    });
    expect(agenticScanMock).toHaveBeenCalledOnce();
    expect(agenticScanMock.mock.calls[0]![0].resumeScanId).toBe("scan-abc-123");
  });

  it("threads resumeScanId through to runPipeline for source-code targets", async () => {
    runPipelineMock.mockResolvedValueOnce({
      ...cleanReport(),
      targetType: "source-code",
      repo: "/tmp/repo",
    } as never);
    await runUnified({
      target: "/tmp/repo",
      targetType: "source-code",
      depth: "default",
      format: "json",
      runtime: "auto",
      timeout: 30000,
      verbose: false,
      resumeScanId: "scan-def-456",
    });
    expect(runPipelineMock).toHaveBeenCalledOnce();
    expect(runPipelineMock.mock.calls[0]![0].resumeScanId).toBe("scan-def-456");
  });

});


describe("runUnified — retained shortcut runs", () => {
  const options = { target: "https://example.com", targetType: "url" as const, depth: "default" as const,
    format: "json" as const, runtime: "api" as const, timeout: 30_000, verbose: false, suppressOutput: true };
  beforeEach(() => {
    for (const mock of Object.values(workflowStoreMock)) mock.mockClear();
    agenticScanMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("retains the snapshot before dispatch and stores successful execution independently of high findings", async () => {
    const tracker: ExitTracker = {};
    makeExitMock(tracker);
    const onOutcome = vi.fn();
    agenticScanMock.mockImplementationOnce(async scannerOptions => {
      scannerOptions.onEvent({ type: "scan_started", message: "started", data: { persisted: true, scanId: "scan-one", dbPath: "/tmp/scan.db" } });
      expect(workflowStoreMock.createExecutionFromSnapshot).toHaveBeenCalledWith(expect.objectContaining({ target: options.target, id: "cli-scan" }), "cli");
      return cleanReport({ summary: { ...emptySummary(), high: 1, low: 1, totalFindings: 2 } });
    });
    await runUnified({ ...options, onOutcome }).catch(() => {});
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ workflowRunId: "cli-run" }));
    expect(workflowStoreMock.saveExecutionResults).toHaveBeenCalledWith("cli-run", expect.objectContaining({
      status: "completed", nodeResults: expect.objectContaining({ assessment: expect.objectContaining({ scanIds: ["scan-one"], dbPaths: ["/tmp/scan.db"] }) }),
    }));
    expect(workflowStoreMock.updateExecution).toHaveBeenCalledWith("cli-run", expect.objectContaining({ status: "completed" }));
    expect(workflowStoreMock.close).toHaveBeenCalledOnce();
    expect(tracker.firstCode).toBe(1);
  });

  it("retains scanner failures before the CLI error exit", async () => {
    const tracker: ExitTracker = {};
    makeExitMock(tracker);
    agenticScanMock.mockRejectedValueOnce(new Error("provider failed"));
    await runUnified(options).catch(() => {});
    expect(workflowStoreMock.saveExecutionResults).toHaveBeenCalledWith("cli-run", expect.objectContaining({ status: "failed", error: "provider failed" }));
    expect(workflowStoreMock.updateExecution).toHaveBeenCalledWith("cli-run", expect.objectContaining({ status: "failed" }));
    expect(tracker.firstCode).toBe(2);
  });

  it("lets embedded browser runs own their retention", async () => {
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    await runUnified({ ...options, embedded: true });
    expect(workflowStoreMock.createExecutionFromSnapshot).not.toHaveBeenCalled();
    expect(workflowStoreMock.saveExecutionResults).not.toHaveBeenCalled();
  });

  it("reports result-retention failure as a CLI failure", async () => {
    const tracker: ExitTracker = {};
    makeExitMock(tracker);
    agenticScanMock.mockResolvedValueOnce(cleanReport());
    workflowStoreMock.saveExecutionResults.mockImplementationOnce(() => { throw new Error("disk full"); });
    workflowStoreMock.getExecution.mockReturnValueOnce({ status: "completed" });
    await runUnified(options).catch(() => {});
    expect(workflowStoreMock.updateExecution).toHaveBeenCalledWith("cli-run", expect.objectContaining({ status: "completed", error: "Run completed, but result retention failed: disk full" }));
    expect(tracker.firstCode).toBe(2);
  });
});

describe("runUnified attaches assessments to a running local engine", () => {
  afterEach(() => vi.restoreAllMocks());
  it("resolves client-relative source paths before crossing the engine boundary", async () => {
    const engine = { startAssessment: vi.fn(async () => ({ id: "source-run" })), getRun: vi.fn(async () => ({ id: "source-run", status: "completed" })), getRunResults: vi.fn(async () => ({ report: cleanReport(), findings: [], nextCursor: null })), cancelRun: vi.fn(), dispose: vi.fn() };
    connectLocalEngineMock.mockResolvedValue(engine);
    vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = makeExitMock({});
    await runUnified({ target: "./client-repo", targetType: "source-code", depth: "quick", format: "json", runtime: "api", timeout: 1000, verbose: false }).catch(() => undefined);
    expect(engine.startAssessment).toHaveBeenCalledWith(expect.objectContaining({ target: `source:${process.cwd()}/client-repo` }));
    expect(engine.dispose).toHaveBeenCalledOnce(); exit.mockRestore();
  });
  it("does not allocate an assessment when the caller was already cancelled", async () => {
    const engine = { startAssessment: vi.fn(), dispose: vi.fn() }; connectLocalEngineMock.mockResolvedValue(engine);
    const controller = new AbortController(); controller.abort(new Error("Already stopped"));
    await expect(runUnified({ target: "./repo", targetType: "source-code", depth: "quick", format: "json", runtime: "api", timeout: 1000, verbose: false, signal: controller.signal })).rejects.toThrow("Already stopped");
    expect(engine.startAssessment).not.toHaveBeenCalled(); expect(engine.dispose).toHaveBeenCalledOnce();
  });
  it("launches and paginates an engine assessment while retaining normal output and outcome", async () => {
    const findings = [{ id: "engine-finding", severity: "high", status: "hypothesis", title: "Untrusted evidence" }, { id: "engine-second", severity: "low", status: "discovered", title: "Other evidence" }];
    const resultReport = cleanReport({ findings: findings as unknown as ScanReport["findings"], summary: { ...emptySummary(), high: 1, low: 1, totalFindings: 2 } });
    const engine = {
      startAssessment: vi.fn(async () => ({ id: "engine-run" })),
      getRun: vi.fn(async () => ({ id: "engine-run", status: "completed", events: [{ sequence: 1, type: "node_completed" }] })),
      getRunResults: vi.fn(async (_id: string, page: { cursor: number }) => ({ report: { ...resultReport, findings: findings.slice(page.cursor, page.cursor + 1) }, findings: findings.slice(page.cursor, page.cursor + 1), nextCursor: page.cursor === 0 ? 1 : null, costUsd: 0.5 })),
      cancelRun: vi.fn(), dispose: vi.fn(),
    };
    connectLocalEngineMock.mockResolvedValue(engine);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = makeExitMock({}); const onReport = vi.fn(); const onOutcome = vi.fn(); const onEvent = vi.fn();
    const oldCalls = agenticScanMock.mock.calls.length;
    const retainedCalls = workflowStoreMock.createExecutionFromSnapshot.mock.calls.length;
    await runUnified({ target: "https://example.com", targetType: "url", depth: "quick", format: "json", runtime: "auto", timeout: 1000, verbose: false, onReport, onOutcome, onEvent }).catch(() => undefined);
    expect(engine.startAssessment).toHaveBeenCalledWith({ target: "https://example.com", plan: expect.objectContaining({ depth: "quick", runCount: 1, timeCapMs: 1000 }) });
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ findings, estimatedCostUsd: 0.5 }));
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ workflowRunId: "engine-run", exitCode: 1, finding_count: 2 }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }));
    expect(agenticScanMock.mock.calls.length).toBe(oldCalls);
    expect(workflowStoreMock.createExecutionFromSnapshot.mock.calls.length).toBe(retainedCalls);
    expect(log).toHaveBeenCalledWith("FORMATTED_REPORT");
    expect(engine.dispose).toHaveBeenCalled(); exit.mockRestore();
  });
  it("forwards cancellation that arrives while the engine is allocating the run", async () => {
    const controller = new AbortController();
    const engine = {
      startAssessment: vi.fn(async () => { controller.abort(new Error("Operator stop")); return { id: "cancelled-engine-run" }; }),
      getRun: vi.fn(async () => ({ id: "cancelled-engine-run", status: "cancelled" })),
      getRunResults: vi.fn(async () => ({ report: cleanReport(), findings: [], nextCursor: null })),
      cancelRun: vi.fn(async () => undefined), dispose: vi.fn(),
    };
    connectLocalEngineMock.mockResolvedValue(engine);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = makeExitMock({}); const onOutcome = vi.fn();
    await runUnified({ target: "https://example.com", depth: "quick", format: "json", runtime: "api", timeout: 1000, verbose: false, signal: controller.signal, onOutcome }).catch(() => undefined);
    expect(engine.cancelRun).toHaveBeenCalledOnce();
    expect(engine.cancelRun).toHaveBeenCalledWith("cancelled-engine-run");
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 2, exit_reason: "cancelled", workflowRunId: "cancelled-engine-run" }));
    expect(engine.dispose).toHaveBeenCalled(); exit.mockRestore();
  });
  it("rejects unsupported execution overrides without starting a separate scan", async () => {
    const engine = { startAssessment: vi.fn(), dispose: vi.fn() };
    connectLocalEngineMock.mockResolvedValue(engine);
    await expect(runUnified({ target: "/fixture", targetType: "source-code", depth: "default", format: "json", runtime: "api", timeout: 1000, verbose: false, reviewProfile: "linux-kernel" })).rejects.toThrow("cannot represent");
    expect(engine.startAssessment).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
    await expect(runUnified({ target: "https://example.com", depth: "default", format: "json", runtime: "api", timeout: 1000, verbose: false, wafEvasion: false })).rejects.toThrow("wafEvasion");
    expect(engine.startAssessment).not.toHaveBeenCalled();
  });
});
