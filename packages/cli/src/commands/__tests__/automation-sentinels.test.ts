import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openConsoleClient, type ConsoleClient } from "../../console-embed-client.js";
import { registerLocalEngine } from "../../local-engine.js";
import { registerAutomationManageCommands } from "../automation-manage.js";
import { registerSentinelsCommand } from "../sentinels.js";
import { registerCommandTree } from "../tree.js";
import type { ConsoleCommandDeps } from "../console-command.js";

const temp: string[] = [];
const FAKE_TOKEN = "fake-control-token-0123456789abcdef0123456789";
function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temp.push(dir);
  return dir;
}
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { process.exitCode = 0; for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(open: ConsoleCommandDeps["open"], homeDir?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ConsoleCommandDeps = { out: line => out.push(line), err: line => err.push(line), open, homeDir };
  const program = new Command().exitOverride();
  const automation = program.command("automation").alias("automations");
  registerAutomationManageCommands(automation, deps);
  registerSentinelsCommand(program, deps);
  const run = async (...args: string[]) => { out.length = 0; err.length = 0; process.exitCode = 0; await program.parseAsync(["node", "0", ...args]); return { out: out.join("\n"), err: err.join("\n"), code: Number(process.exitCode ?? 0) }; };
  return { run };
}

describe("command tree", () => {
  it("registers the new groups and the plural alias", () => {
    const program = new Command();
    registerCommandTree(program);
    const find = (...path: string[]) => path.reduce<Command | undefined>((parent, name) => parent?.commands.find(c => c.name() === name || c.aliases().includes(name)), program);
    for (const path of [["automations", "create"], ["automation", "delete"], ["automation", "triggers", "enable"], ["agents", "run"], ["agents", "files", "put"], ["agents", "triggers", "add"], ["agents", "budget"]]) expect(find(...path), path.join(" ")).toBeDefined();
  });
});

describe("destructive commands", () => {
  it("refuse without --yes (exit 2) and never send a request", async () => {
    const calls: string[] = [];
    const client: ConsoleClient = { mode: "embedded", request: async (method, path) => { calls.push(`${method} ${path}`); return {}; }, dispose: async () => {} };
    const { run } = harness(async () => client);
    for (const args of [["automation", "delete", "a"], ["agents", "delete", "s"], ["agents", "run", "s"], ["agents", "files", "rm", "s", "AGENTS.md"], ["agents", "triggers", "rm", "s", "t"], ["automation", "triggers", "remove", "t"]]) {
      const result = await run(...args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.err).toContain("--yes");
    }
    expect(calls).toEqual([]);
  });

  it("prints JSON errors on stderr and exits 1 for server failures", async () => {
    const client: ConsoleClient = { mode: "attached", request: async () => { throw new Error("Agent not found."); }, dispose: async () => {} };
    const { run } = harness(async () => client);
    const result = await run("agents", "show", "nope", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err)).toEqual({ error: "Agent not found." });
  });
});

describe("embedded (no running engine)", () => {
  it("manages Sentinels end to end against a temp database", async () => {
    const home = makeDir("0-sent-home-");
    const dbPath = join(home, "test.db");
    const { run } = harness(options => openConsoleClient(options), home);
    const db = ["--db-path", dbPath, "--json"];

    const presets = JSON.parse((await run("agents", "presets", ...db)).out) as Array<{ id: string }>;
    expect(presets.length).toBeGreaterThan(0);
    const created = await run("agents", "create", "--preset", presets[0]!.id, "--name", "Nightly", ...db);
    expect(created.code).toBe(0);
    const sentinel = JSON.parse(created.out) as { id: string; name: string; version: number };
    expect(sentinel.name).toBe("Nightly");
    const prefix = sentinel.id.slice(0, 8);

    expect(JSON.parse((await run("agents", "list", ...db)).out)).toHaveLength(1);
    expect((await run("agents", "show", prefix, "--db-path", dbPath)).out).toContain("Nightly");

    const set = await run("agents", "set", prefix, "--daily-usd", "3", ...db);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out).budget.dailyUsd).toBe(3);
    // Access is two choices; the older spellings stay as hidden aliases of "changes".
    const changes = JSON.parse((await run("agents", "set", prefix, "--access", "changes", ...db)).out);
    expect(changes).toMatchObject({ accessLevel: "changes", autonomy: "act" });
    expect(JSON.parse((await run("agents", "set", prefix, "--access", "read-only", ...db)).out)).toMatchObject({ accessLevel: "read-only", autonomy: "observe" });
    for (const alias of ["commands", "pull-requests"]) expect(JSON.parse((await run("agents", "set", prefix, "--access", alias, ...db)).out)).toMatchObject({ accessLevel: "changes", autonomy: "act" });
    expect((await run("agents", "set", prefix, "--access", "root", ...db)).code).toBe(2);
    const viaAutonomy = JSON.parse((await run("agents", "create", "--preset", presets[0]!.id, "--name", "Legacy", "--autonomy", "run", ...db)).out);
    expect(viaAutonomy).toMatchObject({ accessLevel: "changes", autonomy: "run" });
    expect((await run("agents", "show", viaAutonomy.id.slice(0, 8), "--db-path", dbPath)).out).toContain("Can make changes");
    expect((await run("agents", "set", prefix, "--autonomy", "bogus", ...db)).code).toBe(2);
    expect((await run("agents", "set", prefix, ...db)).code).toBe(2);

    expect((await run("agents", "pause", prefix, ...db)).code).toBe(0);
    const budget = JSON.parse((await run("agents", "budget", prefix, ...db)).out);
    expect(budget.budget.dailyUsd).toBe(3);
    expect(JSON.parse((await run("agents", "activations", prefix, ...db)).out)).toEqual([]);

    const put = await run("agents", "files", "put", prefix, "reports/note.md", "--content", "hello", ...db);
    expect(put.code, put.err).toBe(0);
    expect((await run("agents", "files", "put", prefix, "reports/note.md", "--content", "hello again", ...db)).code).toBe(0);
    expect(JSON.parse((await run("agents", "files", "get", prefix, "reports/note.md", ...db)).out).content).toBe("hello again");
    const removed = await run("agents", "files", "rm", prefix, "reports/note.md", "--yes", ...db);
    expect(removed.err).toBe("");
    expect(removed.code).toBe(0);

    const running = await run("agents", "run", prefix, "--yes", ...db);
    expect(running.code).toBe(1);
    expect(running.err).toContain("running engine");

    expect((await run("agents", "archive", prefix, ...db)).code).toBe(0);
    expect(JSON.parse((await run("agents", "list", "--status", "archived", ...db)).out)).toHaveLength(1);
    expect((await run("agents", "delete", prefix, "--yes", ...db)).code).toBe(0);
    expect(JSON.parse((await run("agents", "list", ...db)).out)).toEqual([]);
  });

  it("manages automations end to end and keeps schedules host-only", async () => {
    const home = makeDir("0-auto-home-");
    const dbPath = join(home, "test.db");
    const { run } = harness(options => openConsoleClient(options), home);
    const db = ["--db-path", dbPath, "--json"];

    expect((await run("automations", "create", ...db)).code).toBe(2);
    expect((await run("automations", "create", "--template", "no-such-template", ...db)).code).toBe(2);
    const created = await run("automations", "create", "--template", "repository-review", "--name", "Weekly review", "--target", "/tmp/repo", ...db);
    expect(created.code, created.err).toBe(0);
    const definition = JSON.parse(created.out) as { id: string; revision: number; name: string };
    expect(definition.name).toBe("Weekly review");

    const copy = JSON.parse((await run("automation", "duplicate", definition.id.slice(0, 8), ...db)).out) as { id: string; name: string };
    expect(copy.name).toBe("Weekly review copy");
    expect(copy.id).not.toBe(definition.id);

    const edited = join(home, "edit.json");
    const reader = await openConsoleClient({ dbPath, homeDir: home });
    const stored = ((await reader.request("GET", `/api/console/workflow-definitions/${definition.id}`)) as { definition: object }).definition;
    await reader.dispose();
    writeFileSync(edited, JSON.stringify({ ...stored, name: "Renamed" }));
    const edit = await run("automation", "edit", definition.id, "--file", edited, ...db);
    expect(edit.code, edit.err).toBe(0);
    expect(JSON.parse(edit.out)).toMatchObject({ name: "Renamed", revision: definition.revision + 1 });

    expect(JSON.parse((await run("automation", "versions", definition.id, ...db)).out).versions.length).toBeGreaterThanOrEqual(2);
    const rolled = await run("automation", "rollback", definition.id, "--revision", String(definition.revision), ...db);
    expect(rolled.code, rolled.err).toBe(0);
    expect(JSON.parse(rolled.out).name).toBe("Weekly review");

    const schedules = await run("automation", "triggers", "list", definition.id, ...db);
    expect(schedules.code).toBe(1);
    expect(schedules.err).toContain("running engine");

    expect((await run("automation", "delete", copy.id, "--yes", ...db)).code).toBe(0);
    expect((await run("automation", "delete", definition.id, "--yes", ...db)).code).toBe(0);
  });
});

describe("attached to a running engine", () => {
  it("sends the control token as a bearer header and never prints it", async () => {
    const home = makeDir("0-attach-home-");
    const dbPath = join(home, "test.db");
    const workspace = makeDir("0-attach-ws-");
    const unregister = registerLocalEngine({ url: "http://127.0.0.1:59999/", token: FAKE_TOKEN, engineId: "engine-test", serverInstanceId: "instance-test", pid: process.pid, workspace }, dbPath, { homeDir: home });
    try {
      const seen: Array<{ url: string; method: string; auth: string | null }> = [];
      const fetchStub = (async (url: URL, init: RequestInit) => {
        seen.push({ url: String(url), method: String(init.method), auth: new Headers(init.headers).get("authorization") });
        return new Response(JSON.stringify({ sentinels: [{ id: "sent-1", name: "Watcher", status: "active", autonomy: "propose", toolAccess: "read-only", version: 1 }] }), { status: 200, headers: { "content-type": "application/json", "x-0-engine-id": "engine-test" } });
      }) as unknown as typeof fetch;
      const { run } = harness(options => openConsoleClient(options, { fetch: fetchStub }), home);
      const result = await run("agents", "list", "--db-path", dbPath);
      expect(result.code).toBe(0);
      expect(result.out).toContain("Watcher");
      expect(result.out + result.err).not.toContain(FAKE_TOKEN);
      expect(seen).toEqual([{ url: "http://127.0.0.1:59999/api/console/sentinels", method: "GET", auth: `Bearer ${FAKE_TOKEN}` }]);

      const mismatch = (async () => new Response("{}", { status: 200, headers: { "x-0-engine-id": "other" } })) as unknown as typeof fetch;
      const failing = harness(options => openConsoleClient(options, { fetch: mismatch }), home);
      const bad = await failing.run("agents", "list", "--db-path", dbPath);
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("identity");
    } finally { unregister(); }
  });
});

describe("pull request trigger options", () => {
  it("sends the comment and fork options only when asked, and rejects them for other kinds", async () => {
    const posts: Array<Record<string, any>> = [];
    const client: ConsoleClient = {
      mode: "embedded", dispose: async () => {},
      request: async (method, path, body) => {
        if (method === "GET" && path === "/api/console/sentinels") return { sentinels: [{ id: "s1", name: "S", status: "active", autonomy: "propose", toolAccess: "read-only", version: 1 }] };
        if (method === "POST") { posts.push(body as Record<string, any>); return { trigger: { id: "t1", automationId: "a", kind: "github-pr", enabled: false, version: 1, nextFireAt: null, github: (body as any).github } }; }
        return {};
      },
    };
    const { run } = harness(async () => client);
    await run("agents", "triggers", "add", "s1", "--automation", "a", "--kind", "github-pr", "--repo", "o/r", "--json");
    expect(posts[0]!.github).toEqual({ repo: "o/r" });
    await run("agents", "triggers", "add", "s1", "--automation", "a", "--kind", "github-pr", "--repo", "o/r", "--comment", "--include-forks", "--base-branch", "main", "--json");
    expect(posts[1]!.github).toEqual({ repo: "o/r", baseBranch: "main", commentOnPr: true, includeForks: true });
    const refused = await run("agents", "triggers", "add", "s1", "--automation", "a", "--kind", "schedule", "--comment", "--json");
    expect(refused.err).toMatch(/github-pr/);
    expect(posts).toHaveLength(2);
  });
});
