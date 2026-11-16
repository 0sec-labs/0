import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OciRunner, type ConsoleSession, type ContainerRunner, type NativeMessage } from "@0/engine";
import { ConsoleGateway, ConsoleGatewayError, type ConsoleGatewaySessionFactoryInput } from "./console-gateway.js";

vi.mock("../console-mcp.js", () => ({ connectConsoleMcp: async () => undefined }));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };

const WORKFLOW = (action: string) => `name: ci\non:\n  pull_request:\npermissions: {}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${action}\n      - run: echo hi\n`;

/** A tiny repo with one deliberately unpinned third-party action, committed. */
function fixtureRepo(): string {
  const repo = temp("0-wf-fixture-");
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/ci.yml"), WORKFLOW("some-org/some-action@v1"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
  return repo;
}

/** The "model": edits the workflow like an agent would, then claims it is fixed. */
function fakeModel(repo: string, claim: string, edit: boolean): (input: ConsoleGatewaySessionFactoryInput) => ConsoleSession {
  return input => {
    const messages: NativeMessage[] = [];
    return {
      scanId: input.scanId, ready: Promise.resolve(), systemPrompt: "Fixture", tools: [], messages, approvals: "auto", target: input.target, scope: undefined,
      scopeEnforcement: { pluginId: "scope", enabled: true, pluginEnabled: true, explicit: true, scopeDefined: true, denied: false, projectPath: repo, message: "" },
      localScopePath: repo, webSearchEnabled: false, workerPolicy: input.workerPolicy,
      configureWorkspace: () => undefined, setWebSearchEnabled: () => undefined, setApprovals: async () => undefined, reconfigureRuntime: () => undefined,
      configureEngagement: () => undefined, setWorkerPolicy: () => undefined, clearConversation: () => undefined, stopPersistentAgent: async () => true,
      stopPersistentAgents: async () => undefined, exportCheckpoint: () => { throw new Error("no"); }, prepareHandoff: async () => ({}), cleanup: async () => undefined,
      async send(text) {
        messages.push({ role: "user", content: [{ type: "text", text }] });
        sent.push(text);
        if (edit) writeFileSync(join(repo, ".github/workflows/ci.yml"), WORKFLOW(`some-org/some-action@${"c".repeat(40)} # v1`));
        messages.push({ role: "assistant", content: [{ type: "text", text: claim }] });
        return { assistantText: claim, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, budget: { tokensUsed: 2, tokenBudget: Infinity, iterations: 1, maxToolIterations: 10 }, stopReason: "end_turn" as const };
      },
    } as unknown as ConsoleSession;
  };
}
const sent: string[] = [];

/** Fake runtime: zizmor findings drop from 1 to 0 once the action is pinned; actionlint always passes. */
function fakeRunner(available = true): ContainerRunner {
  return {
    isolation: "container",
    probe: async () => available ? { ok: true, runtime: "fake" } : { ok: false, reason: "no runtime" },
    async run(req) {
      if (req.command.startsWith("actionlint")) return { exitCode: 0, output: "", timedOut: false, durationMs: 100 };
      const wf = readFileSync(join(req.dir, ".github/workflows/ci.yml"), "utf8");
      let canary = false;
      try { canary = readFileSync(join(req.dir, ".github/workflows/zz-0-canary.yml"), "utf8").includes("@v1"); } catch { /* absent */ }
      const findings = (wf.includes("@v1") ? 1 : 0) + (canary ? 1 : 0);
      return { exitCode: findings ? 14 : 0, output: findings ? `unpinned-uses\n${findings} findings (1 high)` : "No findings to report.", timedOut: false, durationMs: 2300 };
    },
  };
}

async function run(repo: string, model: ReturnType<typeof fakeModel>, runner: ContainerRunner) {
  const gateway = new ConsoleGateway({ homeDir: temp("0-home-"), projectPath: repo, createSession: model, verifierRunner: runner, createId: () => "session-1-1", now: () => new Date("2026-09-30T00:00:00Z") });
  const created = gateway.create({ verifySkill: "workflow-hardening" });
  await gateway.send(created.id, "Harden the workflows.");
  await vi.waitFor(() => expect(gateway.get(created.id).lastOutcome?.verification).toBeDefined(), { timeout: 20_000 });
  const snapshot = gateway.get(created.id);
  return { snapshot, outcome: snapshot.lastOutcome! };
}

describe("thread with a verifier skill", () => {
  it("rejects a skill that is unknown or declares no verifier", () => {
    const gateway = new ConsoleGateway({ homeDir: temp("0-home-"), projectPath: "/fixture", createId: () => "s-1" });
    expect(() => gateway.create({ verifySkill: "does-not-exist" })).toThrow(ConsoleGatewayError);
    expect(() => gateway.create({ verifySkill: "scoped-fix" })).toThrow(/does not declare a verifier/);
  });

  it("gives the skill instructions to the model and ends with 'Verified by' when the harness check passes", async () => {
    sent.length = 0;
    const repo = fixtureRepo();
    const { outcome } = await run(repo, fakeModel(repo, "Pinned the action to a commit SHA; fixed.", true), fakeRunner());
    expect(sent[0]).toContain("Pin every third-party");
    expect(outcome.verification).toMatchObject({ claimBlocked: false, result: { status: "pass", canary: "ok", baseline: { before: 1, after: 0 } } });
    expect(outcome.assistantText).toMatch(/Verified by: .*zizmor.* passed, 1 to 0 findings \(\d+\.\ds\)$/);
  });

  it("blocks a fixed claim when the agent changed nothing", async () => {
    const repo = fixtureRepo();
    const { outcome } = await run(repo, fakeModel(repo, "Everything is fixed.", false), fakeRunner());
    expect(outcome.verification).toMatchObject({ claimBlocked: true, result: { status: "fail", reason: "no-improvement" } });
    expect(outcome.assistantText).toContain("Not verified:");
  });

  it("says Not verified, never Verified, when there is no container runtime", async () => {
    const repo = fixtureRepo();
    const { outcome } = await run(repo, fakeModel(repo, "All fixed and verified.", true), fakeRunner(false));
    expect(outcome.verification).toMatchObject({ claimBlocked: true, result: { status: "not-run" } });
    expect(outcome.assistantText).toContain("Not verified: no container runtime is available");
    expect(outcome.assistantText).not.toContain("Verified by");
  });
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0;
describe.skipIf(!hasDocker)("thread with a verifier skill (real zizmor and actionlint)", () => {
  it("verifies a pinned fixture in a real container", async () => {
    const repo = fixtureRepo();
    const { outcome } = await run(repo, fakeModel(repo, "Pinned the action; fixed.", true), new OciRunner());
    expect(outcome.verification?.result).toMatchObject({ status: "pass", canary: "ok" });
    expect(outcome.assistantText).toContain("Verified by:");
  }, 600_000);
});
