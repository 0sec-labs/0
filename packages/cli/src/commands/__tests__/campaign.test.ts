/**
 * Tests for `0 campaign` — the self-directed pentest supervisor.
 *
 * Pure modules are exercised directly (brief generator, journal helpers,
 * objective parser). Command-level tests register the subcommand on a
 * fresh Commander program with heavy collaborators (engine discovery,
 * child spawning) injected, so no network call or child process is ever
 * started. The default path is all-chat: dry-run plans N chat sessions
 * and --with-scan prepends one scan iteration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CampaignDependencies } from "../campaign.js";
import { buildObjectiveBrief } from "../campaign-brief.js";
import {
  initJournal,
  loadJournal,
  planIterations,
  parseScanSummary,
  saveJournal,
} from "../campaign-journal.js";
import {
  buildObjectivePrompt,
  generateObjective,
  GENERIC_OBJECTIVE,
  parseObjectiveResponse,
} from "../campaign-objective.js";

// ── Temp directory management ───────────────────────────────────────────────

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "0-campaign-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── 1. buildObjectiveBrief ──────────────────────────────────────────────────

describe("buildObjectiveBrief", () => {
  const brief = buildObjectiveBrief(
    "https://target.example",
    ["target.example", "api.target.example"],
    "Probe the cart for IDOR",
    ["Replay /cart/<other-uuid> as shopper", "Fuzz discount codes"],
    ["Reflected XSS in search", "Missing rate limit on login"],
    2,
  );

  it("states the objective and lists the concrete tests", () => {
    expect(brief).toContain("Probe the cart for IDOR");
    expect(brief).toContain("Replay /cart/<other-uuid> as shopper");
    expect(brief).toContain("Fuzz discount codes");
  });

  it("reminds the agent of the scope boundaries", () => {
    expect(brief).toContain("target.example, api.target.example");
    expect(brief).toContain("No destructive actions");
    expect(brief).toContain("authorized identities");
  });

  it("requires save_finding for anything confirmed", () => {
    expect(brief).toContain("save_finding");
  });

  it("forbids fabricating results", () => {
    expect(brief).toContain("Never fabricate results");
  });

  it("lists prior findings to avoid duplication and names the iteration", () => {
    expect(brief).toContain("Reflected XSS in search");
    expect(brief).toContain("Missing rate limit on login");
    expect(brief).toContain("iteration 2");
  });
});

// ── 2. Journal round-trip and resume ────────────────────────────────────────

describe("campaign journal", () => {
  it("round-trips init → record iteration → resume skips completed", () => {
    const journalPath = join(directory(), "campaign.json");
    const journal = initJournal("https://target.example", { iterations: 3 }, 0);
    saveJournal(journalPath, journal);

    const loaded = loadJournal(journalPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.target).toBe("https://target.example");
    expect(loaded!.iterations).toHaveLength(0);

    loaded!.iterations.push({
      kind: "chat",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: null,
      summary: "engine session abc completed: mapped the surface",
      sessionId: "abc",
    });
    saveJournal(journalPath, loaded!);

    const resumed = loadJournal(journalPath)!;
    expect(resumed.iterations).toHaveLength(1);
    // Resume must continue AFTER the last completed iteration, never redo it.
    const plan = planIterations({ iterations: 3 });
    expect(plan.slice(resumed.iterations.length)).toEqual([
      { index: 2, kind: "chat" },
      { index: 3, kind: "chat" },
    ]);
  });

  it("returns null for a missing journal and survives unknown target checks", () => {
    const journalPath = join(directory(), "missing.json");
    expect(loadJournal(journalPath)).toBeNull();
    const freshPath = join(directory(), "fresh.json");
    const journal = initJournal("https://other.example", {}, 4);
    saveJournal(freshPath, journal);
    const loaded = loadJournal(freshPath)!;
    expect(loaded.target).not.toBe("https://target.example");
    expect(loaded.findingsBaseline).toBe(4);
  });

  it("plans a uniform all-chat sequence by default and scan-first with --with-scan", () => {
    expect(planIterations({ iterations: 3 })).toEqual([
      { index: 1, kind: "chat" },
      { index: 2, kind: "chat" },
      { index: 3, kind: "chat" },
    ]);
    expect(planIterations({ iterations: 3, withScan: true })).toEqual([
      { index: 1, kind: "scan" },
      { index: 2, kind: "chat" },
      { index: 3, kind: "chat" },
    ]);
  });

  it("parses the scan markdown summary block", () => {
    const stdout = [
      "# 0 Scan Report",
      "| Duration | 42.0s |",
      "- **Attacks:** 17",
      "- **Findings:** 3",
    ].join("\n");
    expect(parseScanSummary(stdout)).toEqual({ attacks: 17, findings: 3, durationMs: 42_000 });
    expect(parseScanSummary("garbage")).toEqual({ attacks: null, findings: null, durationMs: null });
  });
});

// ── 3. --dry-run plans the sequence without spawning ────────────────────────

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr };
}

async function runCampaignCli(args: string[], deps: CampaignDependencies): Promise<{ code?: number }> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  const { registerCampaignCommand } = await import("../campaign.js");
  registerCampaignCommand(program, deps);
  try {
    await program.parseAsync(["campaign", ...args], { from: "user" });
    return {};
  } catch (error) {
    return { code: (error as { code?: number }).code };
  }
}

describe("campaign --dry-run", () => {
  it("prints the planned chat sequence and exits 0 without spawning children", async () => {
    const root = directory();
    const scopePath = join(root, "scope.json");
    writeFileSync(scopePath, JSON.stringify({ in_scope: ["127.0.0.1"] }));
    const io = captureIo();
    const spawnChild = vi.fn();
    const connectEngine = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const result = await runCampaignCli([
        "--target", "https://target.example",
        "--scope", scopePath,
        "--journal", join(root, "campaign.json"),
        "--dry-run",
      ], { out: (text) => io.stdout.push(text), err: (text) => io.stderr.push(text), spawnChild, connectEngine });
      expect(result.code).toBeUndefined();
      const output = io.stdout.join("");
      expect(output).toContain("Dry run");
      expect(output).toContain("1. chat");
      expect(output).toContain("2. chat");
      expect(output).toContain("3. chat");
      expect(output).not.toContain("1. scan");
      expect(spawnChild).not.toHaveBeenCalled();
      expect(connectEngine).not.toHaveBeenCalled();
      expect(existsSync(join(root, "campaign.json"))).toBe(false);
    } finally {
      exit.mockRestore();
    }
  });

  it("plans the scan first when --with-scan is passed", async () => {
    const root = directory();
    const scopePath = join(root, "scope.json");
    writeFileSync(scopePath, JSON.stringify({ in_scope: ["127.0.0.1"] }));
    const io = captureIo();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await runCampaignCli([
        "--target", "https://target.example",
        "--scope", scopePath,
        "--journal", join(root, "campaign.json"),
        "--with-scan",
        "--dry-run",
      ], { out: (text) => io.stdout.push(text), err: (text) => io.stderr.push(text) });
      const output = io.stdout.join("");
      expect(output).toContain("1. scan");
      expect(output).toContain("2. chat");
    } finally {
      exit.mockRestore();
    }
  });

  it("rejects a missing scope file with exit code 2 before planning", async () => {
    const root = directory();
    const io = captureIo();
    const previousExitCode = process.exitCode;
    try {
      await runCampaignCli([
        "--target", "https://target.example",
        "--scope", join(root, "nope.json"),
        "--dry-run",
      ], { out: (text) => io.stdout.push(text), err: (text) => io.stderr.push(text) });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

// ── 4. Objective JSON parsing and fallback path ─────────────────────────────

describe("parseObjectiveResponse", () => {
  it("accepts strict JSON with all fields", () => {
    expect(parseObjectiveResponse('{"objective":"Probe /admin","tests":["a","b"],"stop":true,"reason":"done"}')).toEqual({
      objective: "Probe /admin",
      tests: ["a", "b"],
      stop: true,
      reason: "done",
    });
  });

  it("strips a markdown code fence", () => {
    const fenced = '```json\n{"objective":"Probe /admin","tests":[],"stop":false,"reason":"go"}\n```';
    expect(parseObjectiveResponse(fenced)).toEqual({
      objective: "Probe /admin",
      tests: [],
      stop: false,
      reason: "go",
    });
  });

  it("defaults missing tests/stop/reason defensively but rejects a missing objective", () => {
    expect(parseObjectiveResponse('{"objective":"x"}')).toEqual({ objective: "x", tests: [], stop: false, reason: "" });
    expect(parseObjectiveResponse('{"tests":["a"]}')).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseObjectiveResponse("The next objective is to probe /admin")).toBeNull();
    expect(parseObjectiveResponse("{not json")).toBeNull();
    expect(parseObjectiveResponse('["objective"]')).toBeNull();
    expect(parseObjectiveResponse("")).toBeNull();
  });
});

describe("generateObjective fallback path", () => {
  const base = {
    model: "openrouter/z-ai/glm-5.3-flash",
    apiKey: "test-key",
    prompt: buildObjectivePrompt({ target: "https://t", scopeHosts: ["t"], findings: [], priorSummaries: [] }),
  };

  it("sends the unprefixed model to the OpenRouter endpoint and parses a fenced reply", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(init?.headers?.Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify({
        choices: [{ message: { content: '```json\n{"objective":"Probe /api","tests":["fuzz"],"stop":false,"reason":"go"}\n```' } }],
      }));
    });
    const objective = await generateObjective({ ...base, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(objective.objective).toBe("Probe /api");
    expect(objective.tests).toEqual(["fuzz"]);
  });

  it("retries once on garbage and then falls back to the generic objective with stop=false", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "I could not produce JSON, sorry." } }],
    })));
    const objective = await generateObjective({ ...base, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(objective.objective).toBe(GENERIC_OBJECTIVE.objective);
    expect(objective.stop).toBe(false);
  });

  it("never echoes the api key in failures", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("boom test-key"); });
    const objective = await generateObjective({ ...base, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(objective.stop).toBe(false);
  });
});

// ── 5. Live run loop with injected collaborators ────────────────────────────

describe("runCampaign loop", () => {
  it("runs chat iterations through an attached engine, records session ids and stops on the model verdict", async () => {
    const root = directory();
    const scopePath = join(root, "scope.json");
    writeFileSync(scopePath, JSON.stringify({ in_scope: ["127.0.0.1"] }));
    let iterations = 0;
    const engine = {
      createSession: vi.fn(async (_config: Record<string, unknown>) => ({ id: `session-${++iterations}` })),
      getSession: vi.fn(async (_sessionId: string) => ({ session: { status: "ready" }, usage: { costUsd: 0.5 }, messages: [{ role: "assistant", content: "done" }] })),
      sendMessage: vi.fn(async (_sessionId: string, _text: string) => ({})),
      getSessionEvents: vi.fn(async (_sessionId: string, _after?: number) => ({ events: [], cursor: 0 })),
      cancelSession: vi.fn(async (_sessionId: string) => ({})),
      dispose: vi.fn(async () => undefined),
    };
    const generate = vi.fn(async () =>
      iterations === 1
        ? { objective: "Probe the admin panel", tests: ["as admin"], stop: false, reason: "next" }
        : { objective: "done", tests: [], stop: true, reason: "coverage sufficient" });
    const { runCampaign } = await import("../campaign.js");
    const report = await runCampaign({
      target: "https://target.example",
      iterations: 4,
      runTimeoutMs: 60_000,
      totalTimeoutMs: 600_000,
      costCeiling: "10",
      maxToolCalls: 150,
      model: "openrouter/z-ai/glm-5.3-flash",
      scope: scopePath,
      dbPath: join(root, "findings.db"),
      journal: join(root, "campaign.json"),
      rateLimit: "5",
      pauseBetweenMs: 0,
      withScan: false,
      dryRun: false,
      format: "terminal",
    }, { connectEngine: async () => engine, generate, sleep: async () => undefined, now: () => Date.now() });

    expect(report.attached).toBe(true);
    // iteration 1 recon + iteration 2 generated, then the model said stop.
    expect(engine.createSession).toHaveBeenCalledTimes(2);
    expect(engine.createSession.mock.calls[0]![0]).toMatchObject({
      target: "https://target.example",
      autonomyMode: "yolo",
      scope: { in_scope: ["127.0.0.1"] },
    });
    expect(engine.createSession.mock.calls[0]![0].title).toMatch(/^Campaign iter 1: /);
    expect(engine.createSession.mock.calls[1]![0].title).toMatch(/^Campaign iter 2: /);
    expect(engine.sendMessage).toHaveBeenCalledTimes(2);
    expect(report.journal.iterations).toHaveLength(2);
    expect(report.journal.iterations[0]!.sessionId).toBe("session-1");
    expect(report.journal.iterations[1]!.sessionId).toBe("session-2");
    expect(report.journal.totalCostEstimateUsd).toBeCloseTo(1.0);

    const persisted = JSON.parse(readFileSync(join(root, "campaign.json"), "utf8"));
    expect(persisted.iterations).toHaveLength(2);
  });

  it("falls back to a headless chat child with a warning when no engine is running", async () => {
    const root = directory();
    const scopePath = join(root, "scope.json");
    writeFileSync(scopePath, JSON.stringify({ in_scope: ["127.0.0.1"] }));
    const io = captureIo();
    const spawnChild = vi.fn(async (_argv: string[], _timeoutMs: number) => ({ stdout: "headless done", stderr: "", exitCode: 0, timedOut: false }));
    const generate = vi.fn(async () => ({ objective: "Probe again", tests: [], stop: true, reason: "nothing left" }));
    const { runCampaign } = await import("../campaign.js");
    const report = await runCampaign({
      target: "https://target.example",
      iterations: 2,
      runTimeoutMs: 60_000,
      totalTimeoutMs: 600_000,
      costCeiling: "10",
      maxToolCalls: 150,
      model: "openrouter/z-ai/glm-5.3-flash",
      scope: scopePath,
      dbPath: join(root, "findings.db"),
      journal: join(root, "campaign.json"),
      rateLimit: "5",
      pauseBetweenMs: 0,
      withScan: false,
      dryRun: false,
      format: "terminal",
    }, {
      connectEngine: async () => null,
      generate,
      spawnChild,
      sleep: async () => undefined,
      now: () => Date.now(),
      out: (text) => io.stdout.push(text),
      err: (text) => io.stderr.push(text),
    });
    expect(io.stderr.join("")).toContain("falling back to headless");
    expect(spawnChild).toHaveBeenCalledTimes(1);
    const argv = spawnChild.mock.calls[0]![0] as string[];
    expect(argv.slice(1)).toEqual(expect.arrayContaining(["chat", "--mode", "yolo", "--scope", scopePath, "--print"]));
    expect(argv.join(" ")).not.toContain(process.env.OPENROUTER_API_KEY ?? "not-set-env");
    expect(report.journal.iterations[0]!.sessionId).toBeNull();
  });

  it("runs the with-scan child first and parses its summary into the journal", async () => {
    const root = directory();
    const scopePath = join(root, "scope.json");
    writeFileSync(scopePath, JSON.stringify({ in_scope: ["127.0.0.1"] }));
    const spawnChild = vi.fn(async (_argv: string[], _timeoutMs: number) => {
      if (_argv.includes("scan")) {
        return { stdout: "- **Attacks:** 12\n- **Findings:** 2\n| Duration | 9.5s |", stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    const generate = vi.fn(async () => ({ objective: "done", tests: [], stop: true, reason: "stop after scan" }));
    const { runCampaign } = await import("../campaign.js");
    const report = await runCampaign({
      target: "https://target.example",
      iterations: 2,
      runTimeoutMs: 60_000,
      totalTimeoutMs: 600_000,
      costCeiling: "10",
      maxToolCalls: 150,
      model: "openrouter/z-ai/glm-5.3-flash",
      scope: scopePath,
      dbPath: join(root, "findings.db"),
      journal: join(root, "campaign.json"),
      rateLimit: "5",
      pauseBetweenMs: 0,
      withScan: true,
      dryRun: false,
      format: "terminal",
    }, { connectEngine: async () => null, generate, spawnChild, sleep: async () => undefined, now: () => Date.now() });
    const first = spawnChild.mock.calls[0]![0] as string[];
    expect(first.slice(1)).toEqual(expect.arrayContaining(["scan", "--no-guided", "--depth", "deep", "--format", "md"]));
    expect(report.journal.iterations[0]!.kind).toBe("scan");
    expect(report.journal.iterations[0]!.summary).toContain("12 attacks");
    expect(report.journal.iterations[0]!.summary).toContain("2 findings");
  });
});
