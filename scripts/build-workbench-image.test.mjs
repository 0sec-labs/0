import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { planWorkbenchBuild, assertWorkbenchBuildReady } from "./build-workbench-image.mjs";
import { manifest, resolveWorkbenchProfile, assertWorkbenchToolProbe, workbenchProbeFallback } from "./workbench-profile.mjs";

const revision = "a".repeat(40);
const input = { sourceRevision: revision, archive: "/tmp/0-profile.tar", availableBytes: 60 * 1024 ** 3 };

test("default profile plans current CLI on immutable ARM64 base without choosing Kali", () => {
  const plan = planWorkbenchBuild(input);
  assert.equal(plan.profile, "core-web"); assert.equal(plan.platform, "linux/arm64");
  assert.match(plan.baseImage, /@sha256:[a-f0-9]{64}$/);
  assert.equal(plan.qualification, "not-built");
  assert.equal(plan.commands[0].args.includes("KALI_IMAGE="), false);
  assert.equal(plan.maximumArchiveBytes, 6 * 1024 ** 3);
});
test("source inherits core tools and explicitly adds development probes", () => {
  const source = resolveWorkbenchProfile("source");
  assert.ok(source.packages.includes("nmap")); assert.ok(source.packages.includes("gdb"));
  assert.ok(source.probes.some(([tool]) => tool === "0")); assert.ok(source.probes.some(([tool]) => tool === "cc"));
});
test("Kali verifies every core tool without installing packages at startup", () => {
  const kali = resolveWorkbenchProfile("kali");
  assert.deepEqual(kali.packages, []);
  for (const [name, args] of resolveWorkbenchProfile("core-web").probes) {
    assert.ok(kali.probes.some(([tool, options]) => tool === name && JSON.stringify(options) === JSON.stringify(args)), `Kali must verify ${name}`);
  }
});
test("mutable or misrouted Kali references cannot form a build plan", () => {
  for (const kaliImage of [undefined, "kali:latest", "kali:local", `kali@sha256:${"G".repeat(64)}`])
    assert.throws(() => planWorkbenchBuild({ ...input, profile: "kali", kaliImage }), /immutable/);
  assert.throws(() => planWorkbenchBuild({ ...input, kaliImage: `registry.example/kali@sha256:${"b".repeat(64)}` }), /only valid/);
  const plan = planWorkbenchBuild({ ...input, profile: "kali", kaliImage: `registry.example/kali@sha256:${"b".repeat(64)}` });
  assert.equal(plan.aptSnapshot, null); assert.ok(plan.commands[0].args.includes("WORKBENCH_BASE=kali-base"));
});
test("budget plans reject insufficient headroom and unsupported inputs", () => {
  assert.equal(planWorkbenchBuild({ ...input, availableBytes: 21 * 1024 ** 3 }).diskReady, false);
  assert.throws(() => planWorkbenchBuild({ ...input, profile: "__proto__" }), /Unknown/);
  assert.throws(() => planWorkbenchBuild({ ...input, sourceRevision: "main" }), /exact/);
  assert.throws(() => planWorkbenchBuild({ ...input, archive: "relative.tar" }), /absolute/);
});
test("plan-only command succeeds with Docker absent and creates no archive", () => {
  const result = spawnSync(process.execPath, [new URL("./build-workbench-image.mjs", import.meta.url).pathname, "--profile", "core-web", "--archive", "/tmp/0-never-built-profile.tar"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).qualification, "not-built");
});
test("snapshot and receipt inputs stay consistent with Docker build", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile.workbench", import.meta.url), "utf8");
  assert.ok(dockerfile.includes(manifest.baseImage)); assert.ok(dockerfile.includes(manifest.aptSnapshot));
  assert.ok(dockerfile.includes("workbench-inventory.mjs"));
  assert.ok(dockerfile.includes("runuser -u zero"));
});

test("build admission refuses low disk, dirty sources and existing outputs before Docker", () => {
  const plan = planWorkbenchBuild(input);
  assert.throws(() => assertWorkbenchBuildReady({ ...plan, diskReady: false }, { dirty: false, archiveExists: false }), /No image build started/);
  assert.throws(() => assertWorkbenchBuildReady(plan, { dirty: true, archiveExists: false }), /Commit source/);
  assert.throws(() => assertWorkbenchBuildReady(plan, { dirty: false, archiveExists: true }), /already exists/);
  assert.doesNotThrow(() => assertWorkbenchBuildReady(plan, { dirty: false, archiveExists: false }));
});

test("tool receipt rejects permission and interpreter failures even with accepted exit codes", () => {
  for (const [status, stderr] of [[1, "mkdir: /home/zero/.john: Permission denied"], [0, "Critical failure reading project registry: EACCES"], [0, "Traceback (most recent call last):"]]) {
    assert.throws(() => assertWorkbenchToolProbe("fixture", { status, stdout: "version 1.0", stderr }, [0, 1]), /startup diagnostic/);
  }
  assert.deepEqual(assertWorkbenchToolProbe("hydra", { status: 255, stdout: "Hydra v9.7\nSyntax: hydra", stderr: "" }, [0, 255]), { exitCode: 255, versionOutput: "Hydra v9.7\nSyntax: hydra" });
  assert.throws(() => assertWorkbenchToolProbe("fixture", { status: 0, stdout: "", stderr: "" }), /no version output/);
});

test("Gobuster version compatibility retries only the known rejected subcommand", () => {
  assert.deepEqual(workbenchProbeFallback("gobuster", ["version"], { status: 3, stderr: "No help topic for 'version'" }), ["--version"]);
  assert.equal(workbenchProbeFallback("gobuster", ["version"], { status: 0, stdout: "3.5" }), null);
  assert.equal(workbenchProbeFallback("gobuster", ["version"], { status: 1, stderr: "Permission denied" }), null);
  assert.equal(workbenchProbeFallback("other", ["version"], { status: 3, stderr: "No help topic for 'version'" }), null);
});
