/**
 * Real container run. Skipped unless a container runtime answers; never needs a model or an API key.
 * It may pull small pinned images the first time.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSkillRegistry } from "../agent/skills/index.js";
import { OciRunner } from "./docker-runner.js";
import { gateDone } from "./gate.js";
import { runVerifier } from "./runner.js";
import { parseVerifySpec } from "./spec.js";

const hasDocker = ["docker", "podman"].some((bin) => spawnSync(bin, ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0);
const ALPINE = "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "verifier-it-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!hasDocker)("OciRunner (real container)", () => {
  const runner = new OciRunner();

  it("runs a command on a copy of the tree, with the network off, and reports exit codes", async () => {
    const dir = temp();
    writeFileSync(join(dir, "marker.txt"), "hello");
    const parse = (command: string) => { const p = parseVerifySpec({ command, image: ALPINE, timeout: "60s" }); if (!p.ok) throw new Error(p.error); return p.spec; };

    const ok = await runVerifier({ spec: parse("cat marker.txt | grep -q hello"), afterDir: dir, runner });
    expect(ok).toMatchObject({ status: "pass", isolation: "container" });

    const bad = await runVerifier({ spec: parse("exit 7"), afterDir: dir, runner });
    expect(bad).toMatchObject({ status: "fail", reason: "step-failed:verify" });

    const offline = await runVerifier({ spec: parse("! wget -T 3 -q -O- http://1.1.1.1/"), afterDir: dir, runner });
    expect(offline.status).toBe("pass");

    const write = await runVerifier({ spec: parse("echo changed > marker.txt"), afterDir: dir, runner });
    expect(write.status).toBe("pass");
    expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("hello"); // host tree untouched
  }, 180_000);

  it("times out and cleans the container up", async () => {
    const dir = temp();
    const p = parseVerifySpec({ command: "sleep 30", image: ALPINE, timeout: 2 });
    if (!p.ok) throw new Error(p.error);
    const r = await runVerifier({ spec: p.spec, afterDir: dir, runner });
    expect(r).toMatchObject({ status: "error", reason: "timeout" });
    const left = spawnSync("docker", ["ps", "-aq", "--filter", "label=0.verify=1"], { encoding: "utf8" });
    expect(left.stdout.trim()).toBe("");
  }, 120_000);

  it("runs setup with network, then cuts it before the check", async () => {
    const dir = temp();
    const p = parseVerifySpec({ setup: "echo prepared > /work/setup.txt", command: "test -f setup.txt && ! wget -T 3 -q -O- http://1.1.1.1/", image: ALPINE, timeout: "60s" });
    if (!p.ok) throw new Error(p.error);
    expect((await runVerifier({ spec: p.spec, afterDir: dir, runner })).status).toBe("pass");
  }, 120_000);
});

describe.skipIf(!hasDocker)("workflow-hardening verifier (real zizmor and actionlint)", () => {
  const spec = loadSkillRegistry().get("workflow-hardening")!.verify!;
  const workflow = (action: string) => `name: ci\non:\n  pull_request:\npermissions: {}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${action}\n      - run: echo hi\n`;
  const repo = (action: string) => { const d = temp(); mkdirSync(join(d, ".github/workflows"), { recursive: true }); writeFileSync(join(d, ".github/workflows/ci.yml"), workflow(action)); return d; };
  const runner = new OciRunner();

  it("passes a hardened tree against an unpinned baseline, with the canary flagged", async () => {
    const before = repo("some-org/some-action@v1");
    const after = repo(`some-org/some-action@${"b".repeat(40)} # v1`);
    const result = await runVerifier({ spec, afterDir: after, beforeDir: before, runner, skillId: "workflow-hardening" });
    expect(result.canary).toBe("ok");
    expect(result.baseline!.after).toBeLessThanOrEqual(result.baseline!.before);
    expect(result.baseline!.before).toBeGreaterThan(0);
    expect(result.status).toBe("pass");
    expect(gateDone({ declared: true, claim: "Fixed.", result }).message).toContain("Verified by:");
  }, 600_000);

  it("fails a tree that is worse than before", async () => {
    const before = repo(`some-org/some-action@${"b".repeat(40)} # v1`);
    const after = repo("some-org/some-action@v1");
    const result = await runVerifier({ spec, afterDir: after, beforeDir: before, runner });
    expect(result).toMatchObject({ status: "fail", reason: "worse-than-baseline" });
  }, 600_000);

  it("refuses to trust a repo config that disables the detector (canary missing)", async () => {
    const after = repo(`some-org/some-action@${"b".repeat(40)} # v1`);
    writeFileSync(join(after, ".github/zizmor.yml"), "rules:\n  unpinned-uses:\n    disable: true\n");
    const result = await runVerifier({ spec, afterDir: after, beforeDir: after, runner });
    expect(result).toMatchObject({ status: "fail", reason: "detector-did-not-run", canary: "missing" });
    expect(existsSync(join(after, ".github/workflows/zz-0-canary.yml"))).toBe(false);
  }, 600_000);
});
