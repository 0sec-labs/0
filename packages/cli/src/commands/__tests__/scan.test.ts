import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCAN_MODEL, headlessConsoleArgs, resolveScanTarget, runScan, withoutCredentials, type ScanDeps } from "../scan.js";

const dirs: string[] = [];
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "scan-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); process.exitCode = undefined; });

const finishedSnapshot = (extra: Record<string, unknown> = {}) => ({
  session: { id: "t1", status: "ready", ...extra },
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.12 },
  messages: [
    { role: "assistant", content: [{ type: "text", text: "Covered app.js." }] },
  ],
});

const storedFinding = { id: "f1", templateId: "manual", title: "eval of query", description: "d", severity: "critical", category: "code-injection", status: "discovered", timestamp: 1, evidence: { request: "r", response: "s" }, reviewAnnotation: { path: "app.js", startLine: 1 } };
const storedReport = (findings: unknown[] = [storedFinding]) => ({ target: "", scanDepth: "default", startedAt: "", completedAt: "", durationMs: 0, summary: { totalAttacks: 0, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings, warnings: [] });

function fakes(snapshot: unknown, findings: unknown[] = [storedFinding]) {
  const requests: Array<[string, string, unknown]> = [];
  const out: Array<Uint8Array | string> = [];
  const err: string[] = [];
  const client = { request: vi.fn(async (method: string, path: string, body?: unknown) => { requests.push([method, path, body]); return method === "GET" ? { snapshot } : { session: { id: "t1" } }; }), dispose: vi.fn() };
  const deps: ScanDeps = {
    open: async () => client as never, out: bytes => out.push(bytes), err: text => err.push(text), sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"),
    writeBytes: vi.fn(), loadReport: vi.fn(async () => storedReport(findings) as never), startConsole: vi.fn(async () => () => {}), changedFiles: vi.fn(async () => undefined), clone: vi.fn(async () => ({ dir: "/tmp/cloned", dispose: vi.fn() })),
  };
  return { deps, client, requests, out, err };
}
const options = (extra: Record<string, unknown> = {}) => ({ budget: "5", format: "json", timeout: "60", skill: "scan", passes: "1", ...extra }) as never;

describe("headlessConsoleArgs", () => {
  it("runs the script when node runs a .js file, or the compiled binary itself, always on a free port", () => {
    expect(headlessConsoleArgs("/app/dist/index.js")).toEqual(["/app/dist/index.js", "--headless", "--port", "0"]);
    expect(headlessConsoleArgs("/app/dist/index.mjs")).toEqual(["/app/dist/index.mjs", "--headless", "--port", "0"]);
    expect(headlessConsoleArgs("/$bunfs/root/0")).toEqual(["--headless", "--port", "0"]);
    expect(headlessConsoleArgs(undefined)).toEqual(["--headless", "--port", "0"]);
  });
});

describe("resolveScanTarget", () => {
  it("accepts a folder", async () => {
    const dir = folder();
    expect((await resolveScanTarget(dir, { clone: vi.fn() })).folder).toBe(dir);
  });
  it("clones a git URL", async () => {
    const clone = vi.fn(async () => ({ dir: "/tmp/x", dispose: () => {} }));
    const target = await resolveScanTarget("https://github.com/a/b", { clone });
    expect(clone).toHaveBeenCalledWith("https://github.com/a/b");
    expect(target.folder).toBe("/tmp/x");
  });
  it("names a folder target by its folder name, and keeps its real path to make finding paths relative", async () => {
    const dir = folder();
    const target = await resolveScanTarget(dir, { clone: vi.fn() });
    expect(target.reportTarget).toBe(dir.split("/").pop());
    expect(target.reportTarget).not.toContain("/");
    expect(target.roots).toContain(dir);
  });
  it("never lets a git URL's credentials reach the clone label, the thread or the report", async () => {
    const clone = vi.fn(async () => ({ dir: "/tmp/x", dispose: () => {} }));
    const target = await resolveScanTarget("https://ci-user:s3cret-token@github.com/acme/app.git", { clone });
    expect(clone).toHaveBeenCalledWith("https://ci-user:s3cret-token@github.com/acme/app.git");
    expect(target.label).toBe("https://github.com/acme/app.git");
    expect(target.reportTarget).toBe("https://github.com/acme/app.git");
    expect(JSON.stringify(target)).not.toContain("s3cret-token");
    expect(withoutCredentials("git@github.com:acme/app.git")).toBe("git@github.com:acme/app.git");
    expect(withoutCredentials("not a url")).toBe("not a url");
  });
  it("sends the thread and the title the target without credentials", async () => {
    const { deps, requests } = fakes(finishedSnapshot());
    deps.clone = vi.fn(async () => ({ dir: folder(), dispose: vi.fn() }));
    await runScan("https://ci:s3cret@github.com/acme/app.git", options(), deps);
    expect(JSON.stringify(requests)).not.toContain("s3cret");
  });
  it("does not guess what a package name or prefix means", async () => {
    for (const name of ["npm:lodash", "lodash"]) await expect(resolveScanTarget(name, { clone: vi.fn() })).rejects.toThrow(/not a folder/);
  });
  it("rejects a name that is not a folder", async () => {
    await expect(resolveScanTarget("lodash", { clone: vi.fn() })).rejects.toThrow(/not a folder/);
  });
});

describe("runScan", () => {
  it("starts a thread with the skill and budget, then prints the JSON report", async () => {
    const { deps, requests, out } = fakes(finishedSnapshot());
    await runScan(folder(), options(), deps);
    const create = requests.find(([method, path]) => method === "POST" && path === "/api/console/sessions")!;
    expect(create[2]).toMatchObject({ costCeilingUsd: 5 });
    expect(create[2]).not.toHaveProperty("verifySkill");
    expect(requests.find(([method, path]) => method === "POST" && path.endsWith("/messages"))![2]).toMatchObject({ text: expect.stringContaining("`scan` skill") });
    expect(requests.some(([method, path]) => method === "PATCH" && path.endsWith("/configuration"))).toBe(true);
    const report = JSON.parse(String(out[0]));
    expect(report).toMatchObject({ schemaVersion: 1, threadId: "t1", status: "complete", summary: "Covered app.js.", counts: { total: 1, critical: 1 } });
    expect(process.exitCode).toBeUndefined();
  });

  it("starts a console when none is running, waits for it, and stops it afterwards", async () => {
    const { deps, client, err } = fakes(finishedSnapshot());
    const stop = vi.fn();
    deps.startConsole = vi.fn(async () => stop);
    let attempts = 0;
    deps.open = vi.fn(async () => { if (++attempts < 3) throw new Error("No console running. Start one with: 0 --headless"); return client as never; });
    await runScan(folder(), options(), deps);
    expect(deps.startConsole).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(3);
    expect(err.join("\n")).toMatch(/starting one for this scan/);
    expect(stop).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("does not start a console when one is already running", async () => {
    const { deps } = fakes(finishedSnapshot());
    await runScan(folder(), options(), deps);
    expect(deps.startConsole).not.toHaveBeenCalled();
  });

  it("does not start a console for any other connection error", async () => {
    const { deps } = fakes(finishedSnapshot());
    deps.open = vi.fn(async () => { throw new Error("--engine-token-env requires --engine-url."); });
    await runScan(folder(), options(), deps);
    expect(deps.startConsole).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("stops the console it started even when the scan fails", async () => {
    const { deps, client } = fakes(finishedSnapshot());
    const stop = vi.fn();
    deps.startConsole = vi.fn(async () => stop);
    let first = true;
    deps.open = vi.fn(async () => { if (first) { first = false; throw new Error("No console running."); } return client as never; });
    client.request.mockImplementation(async (method: string) => { if (method === "PATCH") throw new Error("boom"); return { session: { id: "t1" } }; });
    await runScan(folder(), options(), deps);
    expect(stop).toHaveBeenCalled();
  });

  it("fails the scan and names the files when the scan changed the target", async () => {
    const { deps, out, err } = fakes(finishedSnapshot());
    deps.changedFiles = vi.fn().mockResolvedValueOnce(new Set([" M already-dirty.ts"])).mockResolvedValueOnce(new Set([" M already-dirty.ts", " M lib/insecurity.ts", "?? notes.md"]));
    await runScan(folder(), options(), deps);
    const report = JSON.parse(String(out[0]));
    expect(report.status).toBe("failed");
    expect(report.error).toMatch(/changed 2 files.*lib\/insecurity\.ts, notes\.md/);
    expect(err.join("\n")).toMatch(/must not edit the code it reads/);
    expect(process.exitCode).toBe(1);
  });

  it("does not blame the scan for files that were already changed, or when the target is not a git tree", async () => {
    for (const [first, second] of [[new Set([" M a.ts"]), new Set([" M a.ts"])], [undefined, undefined]] as const) {
      const { deps, out } = fakes(finishedSnapshot());
      deps.changedFiles = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      await runScan(folder(), options(), deps);
      expect(JSON.parse(String(out[0])).status).toBe("complete");
      expect(process.exitCode).toBeUndefined();
    }
  });

  it("uses the default model unless --model is given", async () => {
    for (const [extra, expected] of [[{}, DEFAULT_SCAN_MODEL], [{ model: "other-model" }, "other-model"]] as const) {
      const { deps, requests } = fakes(finishedSnapshot());
      await runScan(folder(), options(extra), deps);
      expect(requests.find(([method, path]) => method === "POST" && path === "/api/console/sessions")![2]).toMatchObject({ runtime: { model: expected } });
    }
  });

  it("deletes the thread and hints at --model when setup fails", async () => {
    const { deps, client, err } = fakes(finishedSnapshot());
    client.request.mockImplementation(async (method: string, path: string) => {
      if (method === "PATCH") throw new Error("The selected model is not available to this account.");
      return method === "GET" ? { snapshot: finishedSnapshot() } : { session: { id: "t1" } };
    });
    await runScan(folder(), options(), deps);
    expect(client.request).toHaveBeenCalledWith("POST", "/api/console/sessions/t1/delete", {});
    expect(err.join("\n")).toMatch(/Pick another with --model/);
    expect(err.join("\n")).not.toMatch(/was created/);
    expect(process.exitCode).toBe(1);
  });

  it("reads findings from the store by thread id, not from the transcript", async () => {
    const { deps } = fakes(finishedSnapshot());
    await runScan(folder(), options(), deps);
    expect(deps.loadReport).toHaveBeenCalledWith(expect.anything(), "t1");
  });

  it("reports a clean scan with no findings", async () => {
    const { deps, out } = fakes(finishedSnapshot(), []);
    await runScan(folder(), options({ failOn: "low" }), deps);
    expect(JSON.parse(String(out[0]))).toMatchObject({ status: "complete", counts: { total: 0 } });
    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 when a finding reaches --fail-on", async () => {
    const { deps } = fakes(finishedSnapshot());
    await runScan(folder(), options({ failOn: "high" }), deps);
    expect(process.exitCode).toBe(1);
  });

  it("exits 3 and marks the report partial when the budget ran out", async () => {
    const { deps, out } = fakes(finishedSnapshot({ costCeilingExceeded: true, costCeilingUsd: 5 }));
    await runScan(folder(), options(), deps);
    expect(JSON.parse(String(out[0])).status).toBe("budget_exhausted");
    expect(process.exitCode).toBe(3);
  });

  it("keeps scanning when a few status requests fail", async () => {
    const { deps, client, out, err } = fakes(finishedSnapshot());
    let gets = 0;
    client.request.mockImplementation(async (method: string) => {
      if (method !== "GET") return { session: { id: "t1" } };
      if (++gets <= 3) throw new Error("Backend transport failed.");
      return { snapshot: finishedSnapshot() };
    });
    await runScan(folder(), options(), deps);
    expect(gets).toBe(4);
    expect(JSON.parse(String(out[0]))).toMatchObject({ status: "complete" });
    expect(process.exitCode).toBeUndefined();
    expect(err.join("\n")).not.toMatch(/Lost contact/);
  });

  it("gives up after a long run of failed status requests and names the thread", async () => {
    const { deps, client, err } = fakes(finishedSnapshot());
    client.request.mockImplementation(async (method: string) => {
      if (method !== "GET") return { session: { id: "t1" } };
      throw new Error("Backend transport failed.");
    });
    await runScan(folder(), options(), deps);
    expect(err.join("\n")).toMatch(/Lost contact with the console.*thread t1.*findings export --scan t1/);
    expect(process.exitCode).toBe(1);
  });

  it("cancels a thread that outlives --timeout and still reports what it stored, exit 3", async () => {
    const { deps, requests, out } = fakes({ session: { id: "t1", status: "working" }, usage: {}, messages: [] });
    await runScan(folder(), options({ timeout: "0.001" }), deps);
    expect(requests.some(([method, path]) => method === "POST" && path.endsWith("/cancel"))).toBe(true);
    expect(JSON.parse(String(out[0]))).toMatchObject({ status: "timed_out", counts: { total: 1 } });
    expect(process.exitCode).toBe(3);
  });

  it("writes to a file with -o", async () => {
    const { deps, out } = fakes(finishedSnapshot());
    await runScan(folder(), options({ output: "/tmp/report.json" }), deps);
    expect(deps.writeBytes).toHaveBeenCalledWith("/tmp/report.json", expect.any(Uint8Array));
    expect(out).toEqual([]);
  });

  it("rejects bad options before opening a thread", async () => {
    for (const bad of [{ budget: "0" }, { budget: "abc" }, { format: "xml" }, { failOn: "urgent" }, { timeout: "-1" }, { skill: "../x" }, { format: "pdf" }, { passes: "0" }, { passes: "6" }, { passes: "1.5" }, { passes: "abc" }]) {
      const { deps, client } = fakes(finishedSnapshot());
      await runScan(folder(), options(bad), deps);
      expect(client.request, JSON.stringify(bad)).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    }
  });

  it("removes a cloned folder when it is done", async () => {
    const { deps } = fakes(finishedSnapshot());
    const dispose = vi.fn();
    deps.clone = vi.fn(async () => ({ dir: folder(), dispose }));
    await runScan("https://github.com/a/b", options(), deps);
    expect(dispose).toHaveBeenCalled();
  });
});

describe("runScan with several passes", () => {
  const finding = (id: string, title: string, severity: string, path: string, line: number) => ({ id, templateId: "manual", title, description: `${title} description`, severity, category: "sql-injection", status: "discovered", timestamp: 1, evidence: { request: "r", response: "s" }, reviewAnnotation: { path, startLine: line } });
  /** A console whose threads are t1, t2, ... each with its own stored findings. */
  function multi(perThread: Record<string, unknown[]>, options2: { failThreads?: string[] } = {}) {
    const created: Array<Record<string, unknown>> = [];
    const out: Array<Uint8Array | string> = [];
    const err: string[] = [];
    let counter = 0;
    const client = { request: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/api/console/sessions") { created.push(body as Record<string, unknown>); return { session: { id: `t${++counter}` } }; }
      if (method === "GET") {
        const id = /sessions\/(t\d+)/.exec(path)![1]!;
        if (options2.failThreads?.includes(id)) throw new Error("Backend transport failed.");
        return { snapshot: finishedSnapshot() };
      }
      return {};
    }), dispose: vi.fn() };
    const deps: ScanDeps = {
      open: async () => client as never, out: bytes => out.push(bytes), err: text => err.push(text), sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"),
      writeBytes: vi.fn(), loadReport: vi.fn(async (_client, id: string) => storedReport(perThread[id] ?? []) as never), startConsole: vi.fn(async () => () => {}),
      changedFiles: vi.fn(async () => undefined), clone: vi.fn(),
    };
    return { deps, created, out, err, client };
  }

  it("runs the passes, splits the budget between them and merges what they found", async () => {
    const { deps, created, out } = multi({
      t1: [finding("a1", "SQL injection in users", "high", "src/users.ts", 10), finding("b1", "Path traversal", "high", "src/files.ts", 5)],
      t2: [finding("a2", "User id reaches a query", "critical", "src/users.ts", 11)],
      t3: [finding("a3", "Query built from the id", "medium", "src/users.ts", 12), finding("c3", "Open redirect", "medium", "src/go.ts", 3)],
    });
    await runScan(folder(), options({ passes: "3", budget: "6" }), deps);
    expect(created).toHaveLength(3);
    for (const body of created) expect(body).toMatchObject({ costCeilingUsd: 2 });
    expect(created.map(body => body.title)).toEqual(expect.arrayContaining([expect.stringContaining("pass 1 of 3"), expect.stringContaining("pass 3 of 3")]));
    const report = JSON.parse(String(out[0]));
    expect(report).toMatchObject({ threadId: "t1", threadIds: ["t1", "t2", "t3"], passes: { requested: 3, completed: 3, failed: 0 }, status: "complete", budgetUsd: 6 });
    const bySeverity = Object.fromEntries(report.findings.map((f: { location: { path: string }; severity: string; foundInPasses: number }) => [f.location.path, [f.severity, f.foundInPasses]]));
    expect(bySeverity).toEqual({ "src/users.ts": ["critical", 3], "src/files.ts": ["high", 1], "src/go.ts": ["medium", 1] });
    expect(report.counts.total).toBe(3);
  });

  it("starts at most three passes at once", async () => {
    const { deps, client } = multi({});
    let running = 0; let peak = 0;
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/api/console/sessions") { running++; peak = Math.max(peak, running); }
      const result = await original(method, path, body);
      if (method === "GET") running--;
      return result;
    });
    await runScan(folder(), options({ passes: "5" }), deps);
    expect(peak).toBeLessThanOrEqual(3);
    expect(client.request.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/console/sessions")).toHaveLength(5);
  });

  it("keeps the other passes when one cannot finish, and says so", async () => {
    const { deps, out, err } = multi({ t1: [finding("a1", "SQL injection", "high", "src/users.ts", 10)], t3: [finding("a3", "SQL injection", "high", "src/users.ts", 10)] }, { failThreads: ["t2"] });
    await runScan(folder(), options({ passes: "3" }), deps);
    const report = JSON.parse(String(out[0]));
    expect(report.passes).toEqual({ requested: 3, completed: 2, failed: 1 });
    expect(report.findings[0].foundInPasses).toBe(2);
    expect(err.join("\n")).toMatch(/pass 2: Lost contact/);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails when no pass can finish", async () => {
    const { deps, err } = multi({}, { failThreads: ["t1", "t2"] });
    await runScan(folder(), options({ passes: "2" }), deps);
    expect(err.join("\n")).toMatch(/No scan pass finished/);
    expect(process.exitCode).toBe(1);
  });

  it("applies --fail-on to the merged findings, and checks the target for edits once", async () => {
    const { deps } = multi({ t1: [], t2: [finding("a2", "SQL injection", "high", "src/users.ts", 10)] });
    deps.changedFiles = vi.fn(async () => new Set<string>());
    await runScan(folder(), options({ passes: "2", failOn: "high" }), deps);
    expect(process.exitCode).toBe(1);
    expect(deps.changedFiles).toHaveBeenCalledTimes(2);
  });

  it("says which pass each thread is, and one scan does not mention passes", async () => {
    const many = multi({});
    await runScan(folder(), options({ passes: "2", budget: "3" }), many.deps);
    expect(many.err.join("\n")).toMatch(/in thread t1 \(pass 1 of 2, budget \$1\.5\)/);
    const one = multi({});
    await runScan(folder(), options({ passes: "1", budget: "3" }), one.deps);
    expect(one.err.join("\n")).toMatch(/in thread t1 \(budget \$3\)/);
    expect(one.err.join("\n")).not.toMatch(/pass 1 of/);
  });

  it("does not describe one pass as several: no pass fields, no per-finding count", async () => {
    const { deps, out } = multi({ t1: [finding("a1", "SQL injection", "high", "src/users.ts", 10)] });
    await runScan(folder(), options({ passes: "1" }), deps);
    const report = JSON.parse(String(out[0]));
    expect(report.passes).toBeUndefined();
    expect(report.threadIds).toBeUndefined();
    expect(report.findings[0].foundInPasses).toBeUndefined();
  });
});
