import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkProtectedPaths, protectedCheckFailure } from "./self-edit-policy.js";
import { runGates, type Exec } from "./self-edit-gates.js";
import { SelfEditPreview, frameAncestorFor, frameProtectionHeaders, previewEnv, slugFor, type SelfEditDeps } from "./self-edit-preview.js";
import { handleSelfEditRequest } from "./self-edit-routes.js";

describe("protected paths", () => {
  it("flags guard, auth, lockfile, CI and gate code", () => {
    const files = [
      "packages/cli/src/web/team-auth.ts", "packages/engine/src/scope/scope-guard.ts", "pnpm-lock.yaml", "packages/web/package.json",
      ".github/workflows/main.yml", "packages/cli/src/web/self-edit-gates.ts", "packages/cli/src/state/session-store.ts",
      "packages/web/src/console/approvals.tsx", "scripts/dev-web.mjs", "packages/web/vite.config.ts", "AGENTS.md", "packages/cli/src/web/../web/x.ts",
    ];
    const check = checkProtectedPaths(files);
    expect(check.ok).toBe(false);
    expect(check.hits.map(hit => hit.path).sort()).toEqual([...files].sort());
  });
  it("allows ordinary UI edits and fails closed on errors", () => {
    expect(checkProtectedPaths(["packages/web/src/components/button.tsx", "packages/web/src/styles.css", "packages/cli/src/web/author-badge.ts"]).ok).toBe(true);
    expect(protectedCheckFailure(new Error("boom")).ok).toBe(false);
    expect(checkProtectedPaths(["/etc/passwd"]).ok).toBe(false);
  });
});

function fakeExec(handlers: { diff?: string; untracked?: string; failOn?: string; log?: string[] } = {}): Exec {
  return async (command, args) => {
    handlers.log?.push(`${command} ${args.join(" ")}`);
    if (command === "git") {
      if (args[0] === "rev-parse") return { code: 0, output: "abc123\n", timedOut: false };
      if (args[0] === "diff" && args.includes("--name-only")) return { code: 0, output: handlers.diff ?? "", timedOut: false };
      if (args[0] === "ls-files") return { code: 0, output: handlers.untracked ?? "", timedOut: false };
      return { code: 0, output: "patch", timedOut: false };
    }
    if (handlers.failOn && args.join(" ").includes(handlers.failOn)) return { code: 1, output: "type error", timedOut: false };
    return { code: 0, output: "ok", timedOut: false };
  };
}

describe("gate runner", () => {
  it("passes when the diff is clean and every step succeeds", async () => {
    const result = await runGates({ worktree: "/w", base: "base", exec: fakeExec({ diff: "packages/web/src/a.tsx\0" }) });
    expect(result.status).toBe("passed");
    expect(result.steps.every(step => step.status === "passed")).toBe(true);
    expect(result.headSha).toBe("abc123");
    expect(result.diffHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("fails closed and runs nothing else when a protected path changed", async () => {
    const log: string[] = [];
    const result = await runGates({ worktree: "/w", base: "base", exec: fakeExec({ diff: "pnpm-lock.yaml\0", log }) });
    expect(result.status).toBe("failed");
    expect(result.steps.find(step => step.id === "protected-paths")?.status).toBe("failed");
    expect(result.steps.filter(step => step.id !== "protected-paths").every(step => step.status === "skipped")).toBe(true);
    expect(log.some(line => line.startsWith("pnpm"))).toBe(false);
  });
  it("counts untracked protected files", async () => {
    const result = await runGates({ worktree: "/w", base: "base", exec: fakeExec({ untracked: ".github/workflows/x.yml\0" }) });
    expect(result.status).toBe("failed");
  });
  it("fails when git cannot compute the diff", async () => {
    const exec: Exec = async () => ({ code: 128, output: "fatal", timedOut: false });
    expect((await runGates({ worktree: "/w", base: "b", exec })).status).toBe("failed");
  });
  it("fails on a failing or timed-out command and skips later steps", async () => {
    const failed = await runGates({ worktree: "/w", base: "b", exec: fakeExec({ failOn: "tsc" }) });
    expect(failed.status).toBe("failed");
    expect(failed.steps.find(step => step.id === "typecheck")?.status).toBe("failed");
    expect(failed.steps.find(step => step.id === "web-build")?.status).toBe("skipped");
    const exec: Exec = async (command, args) => command === "git" ? fakeExec()(command, args, { cwd: "", timeoutMs: 0 }) : { code: null, output: "", timedOut: true };
    expect((await runGates({ worktree: "/w", base: "b", exec })).status).toBe("failed");
  });
});

describe("preview helpers", () => {
  it("scrubs the environment to an allow-list with a scratch HOME", () => {
    const env = previewEnv({ PATH: "/bin", HOME: "/real", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y", ZERO_CONTROL_TOKEN: "z" }, "/scratch", { ZERO_DEV_PORT: "1" });
    expect(env.HOME).toBe("/scratch");
    expect(env.PATH).toBe("/bin");
    expect(Object.keys(env).some(key => /KEY|TOKEN/.test(key))).toBe(false);
  });
  it("builds branch-safe slugs and loopback frame ancestors", () => {
    expect(slugFor("Fix the Header!!", Date.UTC(2026, 10, 13, 9, 5), "ab12")).toBe("fix-the-header-202611130905-ab12");
    expect(frameAncestorFor("127.0.0.1:48123")).toBe("http://127.0.0.1:48123");
    expect(frameAncestorFor("evil.example:80")).toBeUndefined();
    expect(frameProtectionHeaders({})).toEqual({ "X-Frame-Options": "DENY" });
    expect(frameProtectionHeaders({ ZERO_PREVIEW_FRAME_ANCESTORS: "http://127.0.0.1:1234" })).toEqual({ "Content-Security-Policy": "frame-ancestors http://127.0.0.1:1234" });
    expect(frameProtectionHeaders({ ZERO_PREVIEW_FRAME_ANCESTORS: "https://evil.example" })).toEqual({ "X-Frame-Options": "DENY" });
  });
});

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "self-edit-test-"));
  const calls: string[] = [];
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv; child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number } }> = [];
  const killed: Array<[number, string]> = [];
  let ports = [40001, 40002];
  const deps: SelfEditDeps = {
    repoRoot: "/repo", stateRoot,
    exec: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, output: "base1\n", timedOut: false };
      if (args[0] === "rev-parse") return { code: 0, output: ".git-exclude-test\n", timedOut: false };
      if (args[0] === "diff" && args.includes("--name-only")) return { code: 0, output: "packages/web/src/a.tsx\0pnpm-lock.yaml\0", timedOut: false };
      if (args[0] === "diff" && args.includes("--name-status")) return { code: 0, output: "M\0packages/web/src/a.tsx\0M\0pnpm-lock.yaml\0", timedOut: false };
      return { code: 0, output: "", timedOut: false };
    },
    spawn: ((_c: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242 });
      spawned.push({ args, env: options.env, child });
      return child;
    }) as never,
    pickPort: async () => ports.shift()!,
    env: { PATH: "/bin", OPENAI_API_KEY: "secret" },
    now: () => 1_800_000_000_000,
    killGroup: (pid, signal) => { killed.push([pid, signal]); },
  };
  return { deps, calls, spawned, killed, stateRoot };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe("SelfEditPreview", () => {
  it("creates a self/* worktree, launches with a scratch home and reports the ready URL", async () => {
    const f = fixture();
    // Worktree dir does not exist in fakes, so the exclude mirror write must not be required to succeed via git.
    const preview = new SelfEditPreview(f.deps);
    const started = await preview.start({ title: "Header tweak" }).catch(error => error as Error);
    // appendFileSync into a non-existent fake worktree git dir is created recursively; no throw expected.
    expect(started).not.toBeInstanceOf(Error);
    await settle();
    expect(f.calls.some(call => /^git worktree add -b self\/header-tweak-\d{12}-[0-9a-f]{4} /.test(call))).toBe(true);
    expect(f.calls.some(call => call.startsWith("pnpm install --frozen-lockfile"))).toBe(true);
    const run = f.spawned[0]!;
    expect(run.args).toContain("40001");
    expect(run.env.HOME).toContain(f.stateRoot);
    expect(run.env.OPENAI_API_KEY).toBeUndefined();
    expect(existsSync(join(run.env.HOME!, ".0"))).toBe(true);
    run.child.stdout.emit("data", Buffer.from(`ZERO_DEV_READY ${JSON.stringify({ backendUrl: "http://127.0.0.1:40001", frontendUrl: "http://127.0.0.1:40002" })}\n`));
    const status = preview.status();
    expect(status.phase).toBe("running");
    expect(status.url).toBe("http://127.0.0.1:40001");
    expect(status.logTail.join("\n")).toContain("ZERO_DEV_READY");
    await expect(preview.start()).rejects.toMatchObject({ statusCode: 409 });
    const stopping = preview.stop();
    await settle();
    run.child.emit("close", 0, "SIGTERM");
    await stopping;
    expect(f.killed[0]).toEqual([4242, "SIGTERM"]);
    expect(preview.status().phase).toBe("idle");
    expect(f.calls.some(call => call.startsWith("git worktree remove"))).toBe(false);
  });

  it("reports diff with protected hits and persists gate results outside the worktree", async () => {
    const f = fixture();
    const preview = new SelfEditPreview(f.deps);
    await preview.start({});
    const diff = await preview.diff();
    expect(diff.protected.ok).toBe(false);
    expect(diff.protected.hits.map(hit => hit.path)).toEqual(["pnpm-lock.yaml"]);
    await preview.runGates();
    await settle();
    const gates = preview.status().gates!;
    expect(gates.status).toBe("failed");
    expect(JSON.parse(readFileSync(join(f.stateRoot, preview.status().slug!, "gates.json"), "utf8")).status).toBe("failed");
  });

  it("reports a silent clean exit with its log tail", async () => {
    const f = fixture();
    const preview = new SelfEditPreview(f.deps);
    await preview.start({});
    await settle();
    f.spawned[0]!.child.emit("close", 0, null);
    expect(preview.status().phase).toBe("failed");
    expect(preview.status().error).toMatch(/without becoming ready/);
  });

  it("discards a kept worktree after a plain stop", async () => {
    const f = fixture();
    const preview = new SelfEditPreview(f.deps);
    await preview.start({});
    await settle();
    const stopping = preview.stop();
    await settle();
    f.spawned[0]!.child.emit("close", 0, "SIGTERM");
    await stopping;
    expect(preview.status().worktree).toBeDefined();
    await preview.stop({ discard: true });
    expect(f.calls.some(call => call.startsWith("git worktree remove"))).toBe(true);
    expect(preview.status().worktree).toBeUndefined();
    const before = f.calls.length;
    await preview.stop({ discard: true });
    expect(f.calls.length).toBe(before);
  });

  it("aborts a running install before discarding while preparing", async () => {
    const f = fixture();
    let aborted = false;
    let release!: () => void;
    const base = f.deps.exec;
    f.deps.exec = (command, args, options) => {
      if (command === "pnpm") return new Promise(resolveRun => {
        release = () => resolveRun({ code: null, output: "", timedOut: false });
        options.signal?.addEventListener("abort", () => { aborted = true; release(); });
      });
      return base(command, args, options);
    };
    const preview = new SelfEditPreview(f.deps);
    await preview.start({});
    await settle();
    expect(preview.status().phase).toBe("preparing");
    await preview.stop({ discard: true });
    expect(aborted).toBe(true);
    expect(preview.status().phase).toBe("idle");
    expect(f.spawned.length).toBe(0);
    expect(f.calls.some(call => call.startsWith("git worktree remove"))).toBe(true);
  });

  it("marks failed when the stack exits early", async () => {
    const f = fixture();
    const preview = new SelfEditPreview(f.deps);
    await preview.start({});
    await settle();
    f.spawned[0]!.child.emit("close", 1, null);
    expect(preview.status().phase).toBe("failed");
  });
});

describe("self-edit routes", () => {
  const owner = { auth: { enabled: true, resolveSession: () => ({ role: "owner" }) } } as never;
  const editor = { auth: { enabled: true, resolveSession: () => ({ role: "editor" }) } } as never;
  const req = { headers: { host: "127.0.0.1:1" } };
  it("ignores other paths", async () => {
    expect(await handleSelfEditRequest({ method: "GET", path: "sessions", input: undefined, req, team: owner })).toBeUndefined();
  });
  it("rejects agent callers (no team) and non-owners", async () => {
    await expect(handleSelfEditRequest({ method: "GET", path: "self-edit/status", input: undefined, req })).rejects.toMatchObject({ statusCode: 403 });
    await expect(handleSelfEditRequest({ method: "GET", path: "self-edit/status", input: undefined, req, team: editor })).rejects.toMatchObject({ statusCode: 403 });
  });
  it("is opt-in, reports status, and keeps apply unavailable", async () => {
    const f = fixture();
    const preview = new SelfEditPreview(f.deps);
    const status = await handleSelfEditRequest({ method: "GET", path: "self-edit/status", input: undefined, req, team: owner, preview, env: {} });
    expect(status?.data).toMatchObject({ enabled: false, applyAvailable: false });
    await expect(handleSelfEditRequest({ method: "POST", path: "self-edit/start", input: {}, req, team: owner, preview, env: {} })).rejects.toMatchObject({ statusCode: 403 });
    const apply = await handleSelfEditRequest({ method: "POST", path: "self-edit/apply", input: {}, req, team: owner, preview, env: { ZERO_SELF_EDIT: "1" } });
    expect(apply?.status).toBe(501);
    const start = await handleSelfEditRequest({ method: "POST", path: "self-edit/start", input: { title: "x" }, req, team: owner, preview, env: { ZERO_SELF_EDIT: "1" } });
    expect(start?.status).toBe(202);
    await expect(handleSelfEditRequest({ method: "POST", path: "self-edit/start", input: { bogus: 1 }, req, team: owner, preview, env: { ZERO_SELF_EDIT: "1" } })).rejects.toThrow();
  });
});
