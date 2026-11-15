import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandPathsOf, crashCommandFromArgv, installCrashCapture } from "./crash-capture.js";
import type { DiagnosticInfo } from "./state/feedback.js";

type Handler = (value: unknown) => void;
function fakeProcess(argv: string[] = ["node", "0", "scan", "web", "--target", "https://client.example"]) {
  const handlers = new Map<string, Handler>();
  const exit = vi.fn();
  return { handlers, exit, proc: { on: (name: string, fn: Handler) => handlers.set(name, fn), argv, version: "v24.1.0", platform: "darwin" as const, arch: "arm64" as const, exit } };
}
const settle = () => new Promise((done) => setTimeout(done, 25));

describe("command labels come from a closed allowlist", () => {
  const known = new Set(["scan", "scan web", "doctor", "web"]);
  it("uses the longest known command path and ignores flags and values", () => {
    expect(crashCommandFromArgv(["n", "0", "scan", "web", "--target", "https://client.example"], known)).toBe("scan web");
    expect(crashCommandFromArgv(["n", "0", "scan", "secret-host.example"], known)).toBe("scan");
    expect(crashCommandFromArgv(["n", "0", "secret-host.example"], known)).toBeUndefined();
    expect(crashCommandFromArgv(["n", "0", "--flag", "doctor"], known)).toBeUndefined();
    expect(crashCommandFromArgv(["n", "0"], known)).toBe("web");
  });
  it("walks a command tree", () => {
    const tree = { commands: [{ name: () => "scan", commands: [{ name: () => "web", commands: [] }] }, { name: () => "doctor", commands: [] }] };
    expect(commandPathsOf(tree)).toEqual(["scan", "scan web", "doctor"]);
  });
});

describe("installCrashCapture", () => {
  it("keeps stderr and exit code 1, and reports finite info only", async () => {
    const { handlers, exit, proc } = fakeProcess();
    const reports: DiagnosticInfo[] = [];
    const stderr: string[] = [];
    installCrashCapture({ surface: "cli", proc: proc as never, stderr: (t) => stderr.push(t), version: "1.2.3", report: async (i) => { reports.push(i); return "pending"; } });
    expect([...handlers.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
    handlers.get("uncaughtException")!(new Error("kaboom"));
    expect(stderr.join("")).toContain("Error: kaboom");
    expect(stderr.join("")).toContain("Node.js v24.1.0");
    await settle();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "runtime", surface: "cli", platform: "darwin", arch: "arm64", runtime: "node", runtimeVersion: "24.1.0" });
    expect(Object.keys(reports[0]!)).not.toContain("exitOutput");
  });

  it("handles unhandled rejections like an uncaught exception, including non-errors", async () => {
    const { handlers, exit, proc } = fakeProcess();
    const stderr: string[] = [];
    installCrashCapture({ surface: "web", proc: proc as never, stderr: (t) => stderr.push(t), version: "1.2.3", report: async () => "dropped" });
    handlers.get("unhandledRejection")!("plain string reason");
    expect(stderr.join("")).toContain("plain string reason");
    await settle();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("never blocks exit past the budget and never throws when reporting fails", async () => {
    const hang = fakeProcess();
    installCrashCapture({ surface: "cli", proc: hang.proc as never, stderr: () => {}, version: "1", budgetMs: 30, report: () => new Promise(() => {}) });
    hang.handlers.get("uncaughtException")!(new Error("x"));
    expect(hang.exit).not.toHaveBeenCalled();
    await new Promise((done) => setTimeout(done, 80));
    expect(hang.exit).toHaveBeenCalledExactlyOnceWith(1);

    const bad = fakeProcess();
    installCrashCapture({ surface: "cli", proc: bad.proc as never, stderr: () => {}, version: "1", report: async () => { throw new Error("transport"); } });
    expect(() => bad.handlers.get("uncaughtException")!(new Error("x"))).not.toThrow();
    await settle();
    expect(bad.exit).toHaveBeenCalledWith(1);
  });

  it("a crash during crash handling exits immediately", () => {
    const { handlers, exit, proc } = fakeProcess();
    installCrashCapture({ surface: "cli", proc: proc as never, stderr: () => {}, version: "1", report: () => new Promise(() => {}) });
    handlers.get("uncaughtException")!(new Error("one"));
    handlers.get("uncaughtException")!(new Error("two"));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("real process", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const cliRoot = resolve(here, "..");
  for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
    it(`${kind}: exit 1, error on stderr, nothing on stdout, nothing stored without a destination`, () => {
      const dir = mkdtempSync(join(tmpdir(), "zero-crash-proc-"));
      try {
        const script = join(dir, "crash.mts");
        writeFileSync(script, `import { installCrashCapture } from ${JSON.stringify(pathToFileURL(join(here, "crash-capture.ts")).href)};
installCrashCapture({ surface: "cli" });
${kind === "uncaughtException" ? 'setTimeout(() => { throw new TypeError("boom FAKE-SECRET"); }, 1);' : 'Promise.reject(new TypeError("boom FAKE-SECRET"));'}
setTimeout(() => {}, 5000);
`);
        const home = join(dir, "home");
        const result = spawnSync(process.execPath, ["--import", "tsx", script], {
          cwd: cliRoot, encoding: "utf8", timeout: 30_000,
          env: { PATH: process.env.PATH ?? "", HOME: home, ZERO_SENTRY_DSN: "" },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("TypeError: boom FAKE-SECRET");
        expect(result.stdout).toBe("");
        expect(existsSync(join(home, ".0", "diagnostics"))).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
