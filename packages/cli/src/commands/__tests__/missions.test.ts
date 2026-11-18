import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCommandTree } from "../tree.js";
import { registerMissionsCommand, type MissionsDeps } from "../missions.js";
import type { ConsoleClient } from "../../console-client.js";

interface Call { method: string; path: string; body?: unknown }
function harness(responses: Record<string, unknown> | ((call: Call) => unknown) = {}) {
  const calls: Call[] = []; const out: string[] = []; const err: string[] = []; const files = new Map<string, string>();
  let opened = 0; let disposed = 0;
  const client: ConsoleClient = {
    async request(method, path, body) {
      const call = { method, path, ...(body === undefined ? {} : { body }) };
      calls.push(call);
      const value = typeof responses === "function" ? responses(call) : responses[`${method} ${path}`];
      if (value instanceof Error) throw value;
      return value ?? { session: { id: "m1", status: "ready" } };
    },
    dispose() { disposed++; },
  };
  const deps: MissionsDeps = {
    open: async () => { opened++; return client; }, out: t => out.push(t), err: t => err.push(t),
    sleep: async () => {}, readFile: path => files.get(path) ?? "{}", writeFile: (path, text) => { files.set(path, text); },
  };
  const run = async (...argv: string[]) => {
    const program = new Command().exitOverride(); program.command("threads"); registerMissionsCommand(program, deps);
    await program.parseAsync(["node", "0", "threads", ...argv]);
  };
  return { calls, out, err, files, run, opened: () => opened, disposed: () => disposed };
}
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { process.exitCode = 0; });

describe("0 threads (console actions)", () => {
  it("is part of the real command tree with its subcommands", () => {
    const program = new Command(); registerCommandTree(program);
    const group = program.commands.find(c => c.name() === "threads")!;
    expect(group.commands.map(c => c.name())).toEqual(expect.arrayContaining(["archive", "clear", "close", "delete", "export", "rename", "retry", "set", "start", "stop", "list"]));
  });

  it("start creates, configures the folder, sends the prompt and prints the id (the retired --access is accepted and ignored)", async () => {
    const h = harness({ "POST /api/console/sessions": { session: { id: "m1", status: "ready" } } });
    await h.run("start", "map the login flow", "--model", "gpt-x", "--effort", "high", "--access", "read-only", "--folder", "/work");
    expect(h.calls).toEqual([
      { method: "POST", path: "/api/console/sessions", body: { runtime: { model: "gpt-x", reasoningEffort: "high" } } },
      { method: "PATCH", path: "/api/console/sessions/m1/configuration", body: { workspacePath: "/work" } },
      { method: "POST", path: "/api/console/sessions/m1/messages", body: { text: "map the login flow" } },
    ]);
    expect(h.out).toEqual(["m1"]);
    expect(process.exitCode).toBe(0); expect(h.disposed()).toBe(1);
  });

  it("start --wait polls until the reply arrives and --json is lossless", async () => {
    let polls = 0;
    const h = harness(call => {
      if (call.method === "GET") return ++polls < 2
        ? { snapshot: { session: { id: "m1", status: "working" }, messages: [] } }
        : { snapshot: { session: { id: "m1", status: "ready" }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } };
      return { session: { id: "m1", status: "working" } };
    });
    await h.run("start", "hi", "--wait", "--json");
    expect(JSON.parse(h.out[0]!)).toMatchObject({ session: { status: "ready" }, reply: "done" });
  });

  it("start --skill is sent on create; --wait prints the recorded verification line and exits 1 when the claim was blocked", async () => {
    const h = harness(call => {
      if (call.method === "GET") return { snapshot: { session: { id: "m1", status: "ready" }, lastOutcome: { stopReason: "end_turn", verification: { line: "Not verified: no container runtime is available", claimBlocked: true } }, messages: [{ role: "assistant", content: [{ type: "text", text: "All fixed." }] }] } };
      return { session: { id: "m1", status: "ready" } };
    });
    await h.run("start", "harden", "--skill", "workflow-hardening", "--wait");
    expect(h.calls[0]).toMatchObject({ body: { verifySkill: "workflow-hardening" } });
    expect(h.out[0]).toContain("All fixed.\n\nNot verified: no container runtime is available");
    expect(process.exitCode).toBe(1);
  });

  it("start --cost-ceiling is sent on create; --wait prints the reply with usage and exits 1 when the ceiling stopped it", async () => {
    const h = harness(call => {
      if (call.method === "GET") return { snapshot: { session: { id: "m1", status: "ready", lastTurnFailed: true, costCeilingUsd: 0.5, costCeilingExceeded: true }, lastOutcome: { stopReason: "cancelled" }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.52 }, messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }] } };
      return { session: { id: "m1", status: "ready" } };
    });
    await h.run("start", "hi", "--cost-ceiling", "0.5", "--wait");
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/console/sessions", body: { costCeilingUsd: 0.5 } });
    expect(h.out).toEqual([expect.stringContaining("partial")]); expect(h.out[0]).not.toContain("cost $");
    expect(h.err.join("\n")).toContain("cost $0.5200"); expect(h.err.join("\n")).toContain("$0.5 cost ceiling");
    expect(process.exitCode).toBe(1);
  });

  it("start --wait exits 1 and prints the error when the turn errored, and rejects a bad ceiling", async () => {
    const h = harness(call => call.method === "GET"
      ? { snapshot: { session: { id: "m1", status: "failed" }, lastOutcome: { error: "rate limited" }, usage: { inputTokens: 1, outputTokens: 0 }, messages: [] } }
      : { session: { id: "m1", status: "working" } });
    await h.run("start", "hi", "--wait");
    expect(h.err.join("\n")).toContain("Error: rate limited"); expect(h.out).toEqual([]); expect(process.exitCode).toBe(1);
    process.exitCode = 0; const bad = harness(); await bad.run("start", "hi", "--cost-ceiling", "0");
    expect(process.exitCode).toBe(2); expect(bad.opened()).toBe(0);
  });

  it("accepts every retired access flag, sends no access field and does not touch the exit code", async () => {
    for (const flags of [["--access", "read-only"], ["--mode", "chaos"], ["--autonomy", "observe"], ["--tool-access", "read-only"], ["--yolo"]]) {
      const h = harness();
      await h.run("start", "hi", ...flags);
      expect(process.exitCode).toBe(0); expect(h.err).toEqual([]);
      expect(h.calls[0]).toEqual({ method: "POST", path: "/api/console/sessions", body: {} });
      expect(JSON.stringify(h.calls)).not.toMatch(/autonomyMode|access/);
    }
  });

  it("does not list the retired access flags in help", () => {
    const program = new Command(); registerCommandTree(program);
    const group = program.commands.find(c => c.name() === "threads")!;
    for (const name of ["start", "set"]) {
      const help = group.commands.find(c => c.name() === name)!.helpInformation();
      for (const flag of ["--access", "--mode", "--autonomy", "--tool-access", "--yolo"]) expect(help).not.toMatch(new RegExp(`${flag}(?![\\w-])`));
    }
  });

  it("points --approvals at the global setting instead of a per-thread choice", async () => {
    const h = harness();
    await h.run("start", "hi", "--approvals", "ask");
    expect(process.exitCode).toBe(2); expect(h.err[0]).toContain("global setting"); expect(h.opened()).toBe(0);
  });

  it("stop uses cancel, or force-stop with --force", async () => {
    const h = harness();
    await h.run("stop", "m1"); await h.run("stop", "m1", "--force");
    expect(h.calls.map(c => c.path)).toEqual(["/api/console/sessions/m1/cancel", "/api/console/sessions/m1/force-stop"]);
  });

  it("retry, rename, regenerate and set map onto the console routes", async () => {
    const h = harness();
    await h.run("retry", "m1"); await h.run("rename", "m1", "New name"); await h.run("rename", "m1", "--regenerate");
    await h.run("set", "m1", "--model", "m", "--effort", "low", "--access", "read-only", "--folder", "/f");
    expect(h.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      "POST /api/console/sessions/m1/retry", "PATCH /api/console/sessions/m1/configuration",
      "POST /api/console/sessions/m1/title/regenerate", "PATCH /api/console/sessions/m1/configuration",
    ]);
    expect(h.calls[1]!.body).toEqual({ title: "New name" });
    expect(h.calls[3]!.body).toEqual({ runtime: { model: "m", reasoningEffort: "low" }, workspacePath: "/f" });
  });

  it("set and rename need something to change", async () => {
    const h = harness();
    await h.run("set", "m1"); expect(process.exitCode).toBe(2);
    process.exitCode = 0; await h.run("rename", "m1"); expect(process.exitCode).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("destructive commands require --yes and never touch the engine without it", async () => {
    const h = harness();
    await h.run("clear", "m1"); await h.run("delete", "m1"); await h.run("delete", "s1", "--saved");
    expect(process.exitCode).toBe(2); expect(h.calls).toEqual([]); expect(h.opened()).toBe(0);
    process.exitCode = 0;
    await h.run("clear", "m1", "--yes"); await h.run("delete", "m1", "--yes"); await h.run("delete", "s1", "--saved", "--yes");
    expect(h.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      "POST /api/console/sessions/m1/clear", "POST /api/console/sessions/m1/delete", "DELETE /api/console/saved/s1",
    ]);
    expect(process.exitCode).toBe(0);
  });

  it("close and archive (live and saved)", async () => {
    const h = harness();
    await h.run("close", "m1"); await h.run("archive", "m1"); await h.run("archive", "s1", "--saved");
    expect(h.calls.map(c => `${c.method} ${c.path}`)).toEqual(["DELETE /api/console/sessions/m1", "POST /api/console/sessions/m1/archive", "POST /api/console/saved/s1/archive"]);
  });

  it("export writes md or json to a file or stdout", async () => {
    const h = harness({ "GET /api/console/sessions/m1/export": { text: "# transcript", messages: [] }, "GET /api/console/saved/s1/export": { text: "t", messages: [] } });
    await h.run("export", "m1", "--format", "md");
    await h.run("export", "s1", "--saved", "-o", "/tmp/x.json");
    expect(h.out).toEqual(["# transcript"]);
    expect(JSON.parse(h.files.get("/tmp/x.json")!)).toEqual({ text: "t", messages: [] });
  });

  it("surfaces server errors as exit 1 and a JSON error with --json", async () => {
    const h = harness(() => new Error("Mission was not found."));
    await h.run("stop", "gone", "--json");
    expect(process.exitCode).toBe(1); expect(JSON.parse(h.err[0]!)).toEqual({ error: "Mission was not found." });
    expect(h.disposed()).toBe(1);
  });

  it("rejects path-like mission IDs", async () => {
    const h = harness();
    await h.run("stop", "../x"); expect(process.exitCode).toBe(2); expect(h.calls).toEqual([]);
  });
});
