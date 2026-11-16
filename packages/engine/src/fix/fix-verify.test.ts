import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verificationLine } from "../verifier/gate.js";
import type { ContainerRunner } from "../verifier/port.js";
import { runFixCheck } from "./fix-verify.js";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "fix-verify-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const IMAGE = `example/tests@sha256:${"d".repeat(64)}`;

describe("runFixCheck (scan fix --test-command as an inline verify)", () => {
  it("keeps the host behaviour but stamps it isolation host, never Verified", async () => {
    const test = await runFixCheck("echo ok", dir(), 10_000, undefined);
    expect(test).toMatchObject({ exitCode: 0, timedOut: false });
    expect(test.verification).toMatchObject({ status: "pass", isolation: "host", canary: "n/a" });
    expect(verificationLine(test.verification!)).toMatch(/^Not verified: .* passed on this machine without isolation$/);
  });

  it("reports a failing command with its exit code and output", async () => {
    const test = await runFixCheck("echo nope >&2; exit 3", dir(), 10_000, undefined);
    expect(test.exitCode).toBe(3);
    expect(test.stderr).toContain("nope");
    expect(test.verification?.status).toBe("fail");
  });

  it("goes through the container runner when an image is given and earns Verified", async () => {
    const calls: unknown[] = [];
    const runner: ContainerRunner = {
      isolation: "container", probe: async () => ({ ok: true, runtime: "fake" }),
      run: async (req) => { calls.push(req); return { exitCode: 0, output: "5 passed", timedOut: false, durationMs: 14200 }; },
    };
    const test = await runFixCheck("npm test", dir(), 60_000, undefined, { image: IMAGE, runner });
    expect(calls[0]).toMatchObject({ image: IMAGE, command: "npm test", network: "none" });
    expect(verificationLine(test.verification!)).toBe("Verified by: npm test passed (14.2s)");
  });

  it("is not-run, and the test counts as failed, without a container runtime", async () => {
    const runner: ContainerRunner = { isolation: "container", probe: async () => ({ ok: false, reason: "none" }), run: async () => { throw new Error("must not run"); } };
    const test = await runFixCheck("npm test", dir(), 60_000, undefined, { image: IMAGE, runner });
    expect(test.verification?.status).toBe("not-run");
    expect(test.exitCode).not.toBe(0);
  });
});
