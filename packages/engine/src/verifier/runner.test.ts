import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gateDone, verificationLine } from "./gate.js";
import type { ContainerRunner, StepOutcome, StepRequest } from "./port.js";
import { plantCanary, runVerifier } from "./runner.js";
import { parseVerifySpec, type VerifySpec } from "./spec.js";

const IMAGE = `example/tool@sha256:${"a".repeat(64)}`;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tree = () => { const d = mkdtempSync(join(tmpdir(), "verifier-test-")); dirs.push(d); mkdirSync(join(d, ".github/workflows"), { recursive: true }); writeFileSync(join(d, "a.txt"), "x"); return d; };

class FakeRunner implements ContainerRunner {
  readonly isolation = "container" as const;
  calls: StepRequest[] = [];
  constructor(private readonly behave: (r: StepRequest, n: number) => Partial<StepOutcome>, private readonly available: string | true = true) {}
  async probe() { return this.available === true ? { ok: true as const, runtime: "fake" } : { ok: false as const, reason: this.available }; }
  async run(r: StepRequest): Promise<StepOutcome> {
    this.calls.push(r);
    return { exitCode: 0, output: "", timedOut: false, durationMs: 1000, ...this.behave(r, this.calls.length) };
  }
}

const spec = (extra: Record<string, unknown> = {}): VerifySpec => {
  const parsed = parseVerifySpec({ command: "tool check", image: IMAGE, ...extra });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
};

describe("runVerifier", () => {
  it("passes when the command exits 0", async () => {
    const runner = new FakeRunner(() => ({ output: "ok", durationMs: 14200 }));
    const r = await runVerifier({ spec: spec(), afterDir: tree(), runner });
    expect(r).toMatchObject({ status: "pass", reason: "criteria-met", canary: "n/a", isolation: "container", imageDigest: `sha256:${"a".repeat(64)}` });
    expect(verificationLine(r)).toBe("Verified by: tool check passed (14.2s)");
  });

  it("fails on a non-zero exit and never says Verified", async () => {
    const runner = new FakeRunner(() => ({ exitCode: 3, output: "boom" }));
    const r = await runVerifier({ spec: spec(), afterDir: tree(), runner });
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("step-failed:verify");
    expect(verificationLine(r)).toMatch(/^Not verified:/);
  });

  it("is not-run, with a reason, when there is no container runtime", async () => {
    const runner = new FakeRunner(() => ({}), "no container runtime responded");
    const r = await runVerifier({ spec: spec(), afterDir: tree(), runner });
    expect(r.status).toBe("not-run");
    expect(runner.calls).toHaveLength(0);
    expect(verificationLine(r)).toBe("Not verified: no container runtime is available");
  });

  it("reports error on an infrastructure failure and on timeout", async () => {
    const infra = await runVerifier({ spec: spec(), afterDir: tree(), runner: new FakeRunner(() => ({ infraError: "pull failed" })) });
    expect(infra).toMatchObject({ status: "error", reason: "infra-error" });
    const slow = await runVerifier({ spec: spec(), afterDir: tree(), runner: new FakeRunner(() => ({ timedOut: true, exitCode: null })) });
    expect(slow).toMatchObject({ status: "error", reason: "timeout" });
  });

  it("matches a regex success criterion", async () => {
    const s = spec({ success: { regex: "0 failed" } });
    expect((await runVerifier({ spec: s, afterDir: tree(), runner: new FakeRunner(() => ({ output: "5 passed, 0 failed" })) })).status).toBe("pass");
    expect((await runVerifier({ spec: s, afterDir: tree(), runner: new FakeRunner(() => ({ output: "5 passed, 2 failed" })) })).reason).toBe("output-did-not-match");
  });

  it("fails with 'detector did not run' when the canary is not flagged, and does not trust the clean run", async () => {
    const s = spec({ canary: { step: "verify", file: ".github/workflows/__canary.yml", content: "uses: a/b@v1", expect: "unpinned" } });
    const runner = new FakeRunner(() => ({ output: "No findings" }));
    const r = await runVerifier({ spec: s, afterDir: tree(), runner });
    expect(r).toMatchObject({ status: "fail", reason: "detector-did-not-run", canary: "missing" });
    expect(verificationLine(r)).toBe("Not verified: tool check failed (detector did not run)");
    expect(runner.calls).toHaveLength(1); // stopped before the real run
  });

  it("plants the canary only in a temp copy and passes when it is flagged", async () => {
    const after = tree();
    const s = spec({ canary: { step: "verify", file: ".github/workflows/__canary.yml", content: "uses: a/b@v1", expect: "unpinned" } });
    const runner = new FakeRunner((req, n) => (n === 1 ? { exitCode: 1, output: "unpinned-uses" } : { output: "clean" }));
    const r = await runVerifier({ spec: s, afterDir: after, runner });
    expect(r).toMatchObject({ status: "pass", canary: "ok" });
    expect(runner.calls[0]!.dir).not.toBe(after);
    expect(existsSync(join(after, ".github/workflows/__canary.yml"))).toBe(false);
  });

  it("compares against the baseline: no worse passes, worse fails", async () => {
    const s = spec({ success: { baseline: "no-worse", metric: "(\\d+) findings" } });
    const before = tree(); const after = tree();
    const run = (b: number, a: number) => new FakeRunner((req) => ({ exitCode: 1, output: `${req.dir === before ? b : a} findings` }));
    const better = await runVerifier({ spec: s, afterDir: after, beforeDir: before, runner: run(4, 1) });
    expect(better).toMatchObject({ status: "pass", baseline: { before: 4, after: 1 } });
    expect(verificationLine(better)).toContain("4 to 1 findings");
    const worse = await runVerifier({ spec: s, afterDir: after, beforeDir: before, runner: run(1, 2) });
    expect(worse).toMatchObject({ status: "fail", reason: "worse-than-baseline" });
  });

  it("is not-run when a baseline is required and no before-tree exists", async () => {
    const r = await runVerifier({ spec: spec({ success: { baseline: "no-worse" } }), afterDir: tree(), runner: new FakeRunner(() => ({})) });
    expect(r).toMatchObject({ status: "not-run", reason: "no-baseline" });
  });

  it("redacts secrets and keeps at most 2 KB of the log", async () => {
    const noisy = `${"x".repeat(5000)}\nGITHUB_TOKEN=ghp_${"A1b2C3d4E5".repeat(4)}\n`;
    const r = await runVerifier({ spec: spec(), afterDir: tree(), runner: new FakeRunner(() => ({ output: noisy })) });
    expect(r.logTail.length).toBeLessThanOrEqual(2048);
    expect(r.logTail).not.toContain("ghp_A1b2");
  });

  it("runs setup and passes the declared network mode to the runner", async () => {
    const runner = new FakeRunner(() => ({}));
    await runVerifier({ spec: spec({ setup: "npm ci --ignore-scripts", network: "none" }), afterDir: tree(), runner });
    expect(runner.calls[0]).toMatchObject({ setup: "npm ci --ignore-scripts", network: "none", image: IMAGE });
  });
});

describe("parseVerifySpec", () => {
  it("rejects tag-only images, unknown keys and a missing image", () => {
    expect(parseVerifySpec({ command: "x", image: "alpine:3" }).ok).toBe(false);
    expect(parseVerifySpec({ command: "x", image: IMAGE, extra: 1 }).ok).toBe(false);
    expect(parseVerifySpec({ command: "x" }).ok).toBe(false);
    expect(parseVerifySpec({ command: "x", image: IMAGE, network: "host" }).ok).toBe(false);
    expect(parseVerifySpec({ command: "x", image: IMAGE, timeout: "9999s" }).ok).toBe(false);
    expect(parseVerifySpec({ command: "x", image: IMAGE, canary: { step: "nope", file: "a", content: "b" } }).ok).toBe(false);
  });
  it("accepts steps with per-step images and a seconds string timeout", () => {
    const p = parseVerifySpec({ steps: [{ name: "a", run: "a", image: IMAGE }, { name: "b", run: "b", image: IMAGE }], timeout: "30s" });
    expect(p.ok && p.spec.timeoutSec).toBe(30);
  });
});

describe("gateDone", () => {
  const pass = { schemaVersion: 1 as const, status: "pass" as const, reason: "criteria-met", command: "zizmor", isolation: "container" as const, durationMs: 14200, logTail: "", canary: "ok" as const };
  it("passes claims through when no verifier is declared", () => {
    expect(gateDone({ declared: false, claim: "All fixed.", result: undefined })).toMatchObject({ allowed: true, message: "All fixed." });
  });
  it("blocks a fixed claim without a passing result", () => {
    const d = gateDone({ declared: true, claim: "All actions are pinned and fixed.", result: undefined });
    expect(d.allowed).toBe(false);
    expect(d.message).toContain("Not verified: the check was not run");
  });
  it("allows the claim with the recorded line when the verifier passed", () => {
    const d = gateDone({ declared: true, claim: "Fixed.", result: pass });
    expect(d.allowed).toBe(true);
    expect(d.message.endsWith("Verified by: zizmor passed (14.2s)")).toBe(true);
  });
  it("a host-run pass is never Verified", () => {
    const d = gateDone({ declared: true, claim: "Fixed.", result: { ...pass, isolation: "host" } });
    expect(d.allowed).toBe(false);
    expect(d.line).toMatch(/^Not verified:/);
  });
  it("does not block a plain report that claims nothing", () => {
    expect(gateDone({ declared: true, claim: "I could not fix this; needs a human.", result: { ...pass, status: "fail", reason: "step-failed:x" } }).allowed).toBe(true);
  });
});

describe("baseline improves", () => {
  it("fails when nothing improved and passes when the count drops or was already zero", async () => {
    const s = spec({ success: { baseline: "improves", metric: "(\\d+) findings" } });
    const before = tree(); const after = tree();
    const run = (b: number, a: number) => new FakeRunner((req) => ({ exitCode: 1, output: `${req.dir === before ? b : a} findings` }));
    expect(await runVerifier({ spec: s, afterDir: after, beforeDir: before, runner: run(2, 2) })).toMatchObject({ status: "fail", reason: "no-improvement" });
    expect((await runVerifier({ spec: s, afterDir: after, beforeDir: before, runner: run(2, 1) })).status).toBe("pass");
    expect((await runVerifier({ spec: s, afterDir: after, beforeDir: before, runner: run(0, 0) })).status).toBe("pass");
  });
});

describe("canary path & symlink safety", () => {
  it("rejects backslashes, drive prefixes, dot segments, and NUL in canary.file", () => {
    for (const bad of ["../escape.yml", "..\\escape.yml", "sub\\file.yml", "./file.yml", "/abs.yml", "C:drive.yml", "a\0b.yml", "a//b.yml"]) {
      expect(parseVerifySpec({ command: "x", image: IMAGE, canary: { step: "verify", file: bad, content: "m" } }).ok, bad).toBe(false);
    }
  });

  it("refuses to plant a canary through a directory symlink or junction pointing outside the snapshot", async () => {
    const outside = mkdtempSync(join(tmpdir(), "verifier-outside-"));
    dirs.push(outside);
    const victimFile = join(outside, "__canary.yml");
    writeFileSync(victimFile, "original-host-content");

    const scratch = mkdtempSync(join(tmpdir(), "verifier-scratch-"));
    dirs.push(scratch);
    mkdirSync(join(scratch, ".github"), { recursive: true });
    symlinkSync(outside, join(scratch, ".github", "workflows"), process.platform === "win32" ? "junction" : "dir");

    expect(plantCanary(scratch, ".github/workflows/__canary.yml", "OVERWRITTEN")).toBe(false);
    expect(readFileSync(victimFile, "utf8")).toBe("original-host-content");

    // End-to-end through runVerifier when the OS permits copying symlinks in cpSync.
    let canCopySymlink = true;
    const after = mkdtempSync(join(tmpdir(), "verifier-symlink-repo-"));
    dirs.push(after);
    try {
      mkdirSync(join(after, ".github"), { recursive: true });
      symlinkSync(outside, join(after, ".github", "workflows"), "dir");
    } catch {
      canCopySymlink = false;
    }
    if (canCopySymlink) {
      const s = spec({ canary: { step: "verify", file: ".github/workflows/__canary.yml", content: "OVERWRITTEN" } });
      const runner = new FakeRunner(() => ({ exitCode: 1, output: "flagged" }));
      const res = await runVerifier({ spec: s, afterDir: after, runner });
      expect(res).toMatchObject({ status: "error", reason: "unsafe-canary-path" });
      expect(readFileSync(victimFile, "utf8")).toBe("original-host-content");
      expect(runner.calls).toHaveLength(0);
      expect(gateDone({ declared: true, claim: "Fixed.", result: res }).allowed).toBe(false);
    }
  });

  it("refuses to plant a canary when a parent segment in the snapshot is a regular file", async () => {
    const after = mkdtempSync(join(tmpdir(), "verifier-file-parent-"));
    dirs.push(after);
    writeFileSync(join(after, ".github"), "not a directory");

    const s = spec({ canary: { step: "verify", file: ".github/workflows/__canary.yml", content: "marker" } });
    const runner = new FakeRunner(() => ({ exitCode: 1, output: "flagged" }));
    const res = await runVerifier({ spec: s, afterDir: after, runner });

    expect(res).toMatchObject({ status: "error", reason: "unsafe-canary-path" });
    expect(runner.calls).toHaveLength(0);
  });
});
