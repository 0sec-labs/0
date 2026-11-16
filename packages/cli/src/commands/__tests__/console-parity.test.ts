import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAudit } from "@0/engine/storage";
import type { ConsoleClient, ConsoleResult } from "../../console-attach-client.js";
import { openConsoleClient } from "../../console-attach-client.js";
import { registerCommandTree } from "../tree.js";
import { runAuditLog } from "../audit-log.js";
import { runConfigGet, runConfigReset, runConfigSet } from "../config.js";
import { runConnectionsAdd, runConnectionsList, runConnectionsRemove, runConnectionsTest } from "../connections.js";
import { runGithubConnect, runGithubStatus } from "../github.js";
import { runModelsDefault, runModelsList } from "../models.js";
import { runUsage } from "../usage.js";
import { runComputersList } from "../worker.js";

const FAKE_KEY = "sk-test-0000000000000000000000000000";
const temp: string[] = [];
const originalHome = process.env.HOME;

function harness(handler: (method: string, path: string, body?: unknown) => ConsoleResult, mode: "attached" | "embedded" = "attached") {
  const out: string[] = []; const err: string[] = []; const codes: number[] = []; const calls: { method: string; path: string; body?: unknown }[] = [];
  const client: ConsoleClient = { mode, dispose: async () => {}, request: async (method, path, body) => { calls.push({ method, path, body }); return handler(method, path, body); } };
  return { out, err, codes, calls, deps: { client, out: (l: string) => out.push(l), err: (l: string) => err.push(l), setExitCode: (c: number) => codes.push(c) } };
}
const last = (codes: number[]) => codes[codes.length - 1];

beforeEach(() => { process.exitCode = 0; });
afterEach(() => {
  process.exitCode = 0;
  process.env.HOME = originalHome;
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("command tree", () => {
  it("registers every new group and keeps the worker alias", () => {
    const program = new Command();
    registerCommandTree(program);
    const names = program.commands.map(c => c.name());
    for (const name of ["models", "computers", "config"]) expect(names).toContain(name);
    const nested = (group: string) => program.commands.find(c => c.name() === group)!.commands.map(c => c.name());
    expect(nested("models")).toEqual(expect.arrayContaining(["connections", "usage"]));
    expect(nested("config")).toEqual(expect.arrayContaining(["github", "audit-log"]));
    const computers = program.commands.find(c => c.name() === "computers")!;
    expect(computers.aliases()).toContain("worker");
    expect(computers.commands.map(c => c.name())).toEqual(expect.arrayContaining(["list", "add", "repair", "stop", "hosts"]));
    expect(computers.commands.find(c => c.name() === "add")!.aliases()).toContain("deploy");
    expect(program.commands.find(c => c.name() === "config")!.commands.map(c => c.name())).toEqual(expect.arrayContaining(["get", "set", "reset", "list", "show"]));
  });
});

describe("connections", () => {
  it("lists providers as text and JSON", async () => {
    const h = harness(() => ({ status: 200, data: { providers: [{ id: "openai", label: "OpenAI", configured: true, source: "account-store", diagnostics: { valid: true, reason: null }, accounts: [{ accountId: "a1", active: true }] }], preference: null } }));
    await runConnectionsList({}, h.deps);
    expect(h.out.join("\n")).toMatch(/openai\s+OpenAI\s+ready\s+a1\*/);
    expect(last(h.codes)).toBe(0);
    const j = harness(() => ({ status: 200, data: { providers: [], preference: null } }));
    await runConnectionsList({ json: true }, j.deps);
    expect(JSON.parse(j.out.join("\n"))).toEqual({ providers: [], preference: null });
  });

  it("adds a key from an env var, sends it only in the request body and never prints it", async () => {
    const h = harness(() => ({ status: 200, data: { providers: [] } }));
    await runConnectionsAdd("openai", { keyEnv: "FAKE_KEY_VAR" }, { ...h.deps, env: { FAKE_KEY_VAR: FAKE_KEY } });
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/console/connections", body: { providerId: "openai", action: "connect", apiKey: FAKE_KEY } });
    expect(h.out.join("\n") + h.err.join("\n")).not.toContain(FAKE_KEY);
    expect(last(h.codes)).toBe(0);
  });

  it("reads the key from stdin, and rejects missing or ambiguous key sources with exit 2", async () => {
    const h = harness(() => ({ status: 200, data: {} }));
    await runConnectionsAdd("openai", { stdin: true }, { ...h.deps, readStdin: async () => `${FAKE_KEY}\n` });
    expect((h.calls[0]!.body as { apiKey: string }).apiKey).toBe(FAKE_KEY);
    const none = harness(() => ({ status: 200, data: {} }));
    await runConnectionsAdd("openai", {}, none.deps);
    expect(last(none.codes)).toBe(2);
    expect(none.calls).toHaveLength(0);
    const both = harness(() => ({ status: 200, data: {} }));
    await runConnectionsAdd("openai", { stdin: true, keyEnv: "X" }, both.deps);
    expect(last(both.codes)).toBe(2);
  });

  it("surfaces the server's message as exit 1 when the key is rejected", async () => {
    const h = harness(() => ({ status: 400, data: { error: "The provider rejected this key." } }));
    await runConnectionsAdd("openai", { keyEnv: "K" }, { ...h.deps, env: { K: FAKE_KEY } });
    expect(last(h.codes)).toBe(1);
    expect(h.err.join("\n")).toContain("The provider rejected this key.");
    expect(h.err.join("\n")).not.toContain(FAKE_KEY);
  });

  it("requires --yes to remove and then disconnects", async () => {
    const h = harness(() => ({ status: 200, data: { providers: [] } }));
    await runConnectionsRemove("openai", {}, h.deps);
    expect(last(h.codes)).toBe(2);
    expect(h.calls).toHaveLength(0);
    await runConnectionsRemove("openai", { yes: true, account: "a1" }, h.deps);
    expect(h.calls[0]!.body).toEqual({ providerId: "openai", action: "disconnect", accountId: "a1" });
    expect(last(h.codes)).toBe(0);
  });

  it("tests a provider by probing its models", async () => {
    const ok = harness(() => ({ status: 200, data: { models: [{ id: "m" }], diagnostics: [] } }));
    await runConnectionsTest("openai", {}, ok.deps);
    expect(ok.calls[0]!.path).toBe("/api/console/models?providerId=openai&fresh=1");
    expect(ok.out.join("\n")).toContain("1 models");
    const bad = harness(() => ({ status: 200, data: { models: [], diagnostics: [{ providerId: "openai", message: "Key rejected." }] } }));
    await runConnectionsTest("openai", {}, bad.deps);
    expect(last(bad.codes)).toBe(1);
    expect(bad.err.join("\n")).toContain("Key rejected.");
  });

  it("reports a remote-engine style browser_only denial as exit 1 with the server message", async () => {
    const h = harness(() => ({ status: 403, data: { code: "browser_only", error: "This action is only available from the browser console." } }));
    await runConnectionsRemove("openai", { yes: true }, h.deps);
    expect(last(h.codes)).toBe(1);
    expect(h.err.join("\n")).toContain("only available from the browser console");
  });
});

describe("models", () => {
  const models = { models: [{ id: "gpt-x", provider: "openai", enabled: true, price: "$1", contextWindowTokens: 1000 }], diagnostics: [], recommended: [] };
  it("lists models and filters by provider", async () => {
    const h = harness(() => ({ status: 200, data: models }));
    await runModelsList({ provider: "openai" }, h.deps);
    expect(h.calls[0]!.path).toContain("providerId=openai");
    expect(h.out.join("\n")).toMatch(/openai\s+gpt-x\s+yes/);
  });
  it("gets and sets the default model", async () => {
    const h = harness((method) => method === "GET" ? { status: 200, data: { providers: [], preference: { providerId: "openai", model: "gpt-x" } } } : { status: 200, data: { preference: { providerId: "openai", model: "gpt-y" } } });
    await runModelsDefault(undefined, {}, h.deps);
    expect(h.out[0]).toBe("openai/gpt-x");
    await runModelsDefault("gpt-y", { provider: "openai" }, h.deps);
    expect(h.calls[1]).toMatchObject({ method: "PATCH", path: "/api/console/models/preference", body: { providerId: "openai", model: "gpt-y" } });
    const noProvider = harness(() => ({ status: 200, data: {} }));
    await runModelsDefault("gpt-y", {}, noProvider.deps);
    expect(last(noProvider.codes)).toBe(2);
  });
});

describe("github", () => {
  it("shows status and connects with a token from the environment", async () => {
    const account = { available: true, connected: true, account: "octo", missingScopes: [] };
    const h = harness(() => ({ status: 200, data: { github: account } }));
    await runGithubStatus({}, h.deps);
    expect(h.out[0]).toBe("Signed in as octo.");
    await runGithubConnect({ keyEnv: "GH_FAKE" }, { ...h.deps, env: { GH_FAKE: "ghp_fake_token" } });
    expect(h.calls[1]).toMatchObject({ method: "POST", path: "/api/console/github/connect", body: { token: "ghp_fake_token" } });
    expect(h.out.join("\n")).not.toContain("ghp_fake_token");
  });
});

describe("usage", () => {
  it("aggregates open missions by model and handles a missing engine", async () => {
    const snap = (model: string, input: number, output: number, cost: number) => ({ status: 200, data: { snapshot: { title: "t", runtime: { model }, usage: { inputTokens: input, outputTokens: output, costUsd: cost } } } });
    const h = harness((_m, path) => path.endsWith("/sessions") ? { status: 200, data: { sessions: [{ id: "a" }, { id: "b" }, { id: "c" }] } } : path.includes("/a?") ? snap("m1", 10, 5, 0.5) : path.includes("/b?") ? snap("m1", 1, 1, 0.25) : snap("m2", 0, 0, 0));
    await runUsage({ json: true }, h.deps);
    const report = JSON.parse(h.out.join("\n"));
    expect(report.totals).toEqual({ missions: 2, tokens: 17, costUsd: 0.75 });
    expect(report.models).toEqual([{ model: "m1", missions: 2, tokens: 17, costUsd: 0.75 }]);
    const none = harness(() => ({ status: 200, data: {} }), "embedded");
    await runUsage({}, none.deps);
    expect(none.out[0]).toContain("No running engine");
    expect(last(none.codes)).toBe(0);
    const bad = harness(() => ({ status: 200, data: {} }));
    await runUsage({ by: "week" }, bad.deps);
    expect(last(bad.codes)).toBe(2);
  });
});

describe("audit-log", () => {
  it("reads, filters and paginates the local audit log", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-log-")); temp.push(dir);
    const dbPath = join(dir, "osec.db");
    for (const action of ["connection.add", "settings.update", "connection.remove"]) recordAudit({ actor: "cli", action, subject: "openai", outcome: "ok" }, { dbPath });
    const out: string[] = []; const err: string[] = []; const codes: number[] = [];
    const deps = { dbPath, out: (l: string) => out.push(l), err: (l: string) => err.push(l), setExitCode: (c: number) => codes.push(c) };
    runAuditLog({ json: true, q: "connection" }, deps);
    expect(JSON.parse(out.join("\n")).events.map((e: { action: string }) => e.action)).toEqual(["connection.remove", "connection.add"]);
    out.length = 0;
    runAuditLog({ limit: "1" }, deps);
    expect(out.join("\n")).toContain("connection.remove");
    expect(last(codes)).toBe(0);
    runAuditLog({ limit: "zero" }, deps);
    expect(last(codes)).toBe(2);
  });
});

describe("computers list", () => {
  it("lists nothing from an empty registry and prints JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "computers-")); temp.push(dir);
    process.env.HOME = dir;
    const out: string[] = []; const codes: number[] = [];
    runComputersList({ json: true }, { out: l => out.push(l), setExitCode: c => codes.push(c) });
    expect(JSON.parse(out.join("\n"))).toEqual({ computers: [] });
    expect(last(codes)).toBe(0);
  });
});

describe("config get/set/reset through the embedded operator transport", () => {
  async function embeddedDeps(home: string) {
    process.env.HOME = home;
    const out: string[] = []; const err: string[] = []; const codes: number[] = [];
    const client = await openConsoleClient({ dbPath: join(home, "osec.db"), homeDir: home }, { attach: async () => null });
    return { out, err, codes, client, deps: { client, out: (l: string) => out.push(l), err: (l: string) => err.push(l), setExitCode: (c: number) => codes.push(c), homeDir: home } };
  }

  it("the telemetry opt-out commands named by the first-run notice work without --yes, and ask is an explicit choice", async () => {
    const home = mkdtempSync(join(tmpdir(), "config-home-")); temp.push(home);
    const h = await embeddedDeps(home);
    try {
      await runConfigSet("analyticsLevel", "off", {}, h.deps);
      expect(last(h.codes)).toBe(0);
      await runConfigSet("diagnosticReporting", "off", {}, h.deps);
      expect(last(h.codes)).toBe(0);
      const read: string[] = [];
      const reader = { homeDir: home, out: (l: string) => read.push(l), err: (l: string) => read.push(l) };
      runConfigGet("analyticsLevel", reader);
      runConfigGet("diagnosticReporting", reader);
      expect(read).toEqual(["off", "off"]);
      await runConfigSet("diagnosticReporting", "ask", {}, h.deps);
      expect(last(h.codes)).toBe(0);
      const saved = JSON.parse(readFileSync(join(home, ".0", "tui-settings.json"), "utf8")) as Record<string, unknown>;
      expect(saved.diagnosticReporting).toBe("ask");
      expect(saved.diagnosticReportingPrompted).toBe(true);
    } finally { await h.client.dispose(); }
  });

  it("`/config set approvals` is the one approvals setting: auto by default, ask or auto only", async () => {
    const home = mkdtempSync(join(tmpdir(), "config-home-")); temp.push(home);
    const h = await embeddedDeps(home);
    try {
      const read: string[] = [];
      const reader = { homeDir: home, out: (l: string) => read.push(l), err: (l: string) => read.push(l) };
      runConfigGet("approvals", reader);
      expect(read).toEqual(["auto"]);
      await runConfigSet("approvals", "ask", {}, h.deps);
      expect(last(h.codes)).toBe(0);
      const saved = JSON.parse(readFileSync(join(home, ".0", "tui-settings.json"), "utf8")) as Record<string, unknown>;
      expect(saved.approvals).toBe("ask");
      await runConfigSet("approvals", "yolo", {}, h.deps);
      expect(last(h.codes)).not.toBe(0);
    } finally { await h.client.dispose(); }
  });

  it("sets, reads and resets a setting, enforcing the web's validation", async () => {
    const home = mkdtempSync(join(tmpdir(), "config-home-")); temp.push(home);
    const h = await embeddedDeps(home);
    try {
      await runConfigSet("compactionThreshold", "85%", {}, h.deps);
      expect(last(h.codes)).toBe(0);
      const read: string[] = [];
      runConfigGet("compactionThreshold", { homeDir: home, out: l => read.push(l), err: l => read.push(l) });
      expect(read[0]).toBe("85%");

      await runConfigSet("compactionThreshold", "12%", {}, h.deps);
      expect(last(h.codes)).toBe(2);
      await runConfigSet("nope", "1", {}, h.deps);
      expect(last(h.codes)).toBe(2);
      await runConfigSet("allowSubagentOperatorMessaging", "on", {}, h.deps);
      expect(last(h.codes)).toBe(2);
      expect(h.err.join("\n")).toContain("--yes");

      await runConfigReset(["compactionThreshold"], {}, h.deps);
      expect(last(h.codes)).toBe(2);
      await runConfigReset(["compactionThreshold"], { yes: true }, h.deps);
      expect(last(h.codes)).toBe(0);
      const after: string[] = [];
      runConfigGet("compactionThreshold", { homeDir: home, json: true, out: l => after.push(l), err: l => after.push(l) });
      expect(JSON.parse(after[0]!)).toMatchObject({ key: "compactionThreshold", value: "80%" });
    } finally { await h.client.dispose(); }
  });

  it("writes an audit entry as the cli actor for privileged embedded changes", async () => {
    const home = mkdtempSync(join(tmpdir(), "config-audit-")); temp.push(home);
    const h = await embeddedDeps(home);
    try {
      await runConfigSet("allowSubagentOperatorMessaging", "on", { yes: true }, h.deps);
      expect(last(h.codes)).toBe(0);
    } finally { await h.client.dispose(); }
  });
});
