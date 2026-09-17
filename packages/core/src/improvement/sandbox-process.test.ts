import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEvolutionConfig } from "./config.js";
import { snapshotEvolutionSource } from "./registry.js";
import { createDockerEvolutionSandbox, resolveEvolutionImage } from "./sandbox.js";

const directories: string[] = [];
afterEach(() => {
  const unlock = (path: string): void => {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(path, entry.name));
  };
  for (const directory of directories.splice(0)) {
    const pidFile = join(directory, "processes.json");
    if (existsSync(pidFile)) {
      const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number };
      for (const pid of [-pids.parent, pids.child, pids.parent]) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    unlock(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

function supervisor(control = false) {
  const directory = mkdtempSync(join(tmpdir(), "0sec-docker-process-"));
  directories.push(directory);
  const binary = join(directory, "docker-fixture");
  const pidFile = join(directory, "processes.json");
  const removed = join(directory, "removed");
  writeFileSync(binary, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const op = process.argv[2];
if (op === 'rm') { writeFileSync(${JSON.stringify(removed)}, 'removed'); process.exit(0); }
if (op === 'create') { console.log('fixture-container'); process.exit(0); }
if (op === 'start' || ${JSON.stringify(control)}) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
  console.log('attached-ready');
  child.on('exit', () => process.exit(0));
} else { console.log('sha256:' + 'a'.repeat(64)); }
`, { mode: 0o700 });
  return { directory, binary, pidFile, removed };
}

function descendantRunning(pidFile: string): boolean {
  const { child } = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number };
  try {
    // Linux may briefly retain a dead orphan as a zombie; it is not executing.
    const status = readFileSync(`/proc/${child}/stat`, "utf8");
    return !status.slice(status.lastIndexOf(")") + 2).startsWith("Z");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// These integration cases exercise OS process groups and inherited pipes;
// fake JS clocks cannot advance or terminate real supervisor descendants.
describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("supervised Docker invocation lifecycle", () => {
  for (const cancellation of ["deadline", "operator"] as const) {
    it(`drains supervisor descendants and removes the container on ${cancellation}`, async () => {
      const fixture = supervisor();
      const sourceRoot = join(fixture.directory, "source");
      mkdirSync(sourceRoot);
      writeFileSync(join(sourceRoot, "main.cjs"), "module.exports = 1;\n");
      const config = parseEvolutionConfig({
        schemaVersion: 1, sourceRoot, storePath: join(fixture.directory, "store"),
        image: `sha256:${"a".repeat(64)}`, sourcePaths: ["main.cjs"], editablePaths: ["main.cjs"],
        command: ["node", "main.cjs"], objective: "exercise process lifecycle", computeUsdPerSecond: 0.001,
        timeoutMs: cancellation === "deadline" ? 1500 : 10000,
        cases: (["development", "held-out", "negative-control"] as const).flatMap(lane =>
          Array.from({ length: 10 }, (_, index) => ({
            id: `${lane}-${index}`, lane, input: { lane, index }, expected: null,
          }))),
      });
      const snapshot = await snapshotEvolutionSource(config);
      const abort = new AbortController();
      const outcome = await createDockerEvolutionSandbox(fixture.binary)({
        config, snapshot, input: null, signal: abort.signal,
        channel: { onReady() {}, onData(data) { if (cancellation === "operator" && data.includes("attached-ready")) abort.abort(); } },
      });
      expect(outcome.timedOut).toBe(cancellation === "deadline");
      expect(existsSync(fixture.removed)).toBe(true);
      await expect.poll(() => descendantRunning(fixture.pidFile)).toBe(false);
    });
  }

  it("bounds image-control timeout even when descendants hold its pipes open", async () => {
    const fixture = supervisor(true);
    await expect(resolveEvolutionImage("fixture:local", fixture.binary)).rejects.toThrow();
    await expect.poll(() => descendantRunning(fixture.pidFile)).toBe(false);
  }, 10000);

  it("marks cleanupFailed when container removal fails after guest creation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "0sec-docker-cleanup-"));
    directories.push(directory);
    const removed = join(directory, "removed");
    const pidFile = join(directory, "processes.json");
    const binary = join(directory, "docker-fixture");
    writeFileSync(binary, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const op = process.argv[2];
if (op === 'rm') { writeFileSync(${JSON.stringify(removed)}, 'removed'); process.exit(1); }
if (op === 'create') { console.log('fixture-container'); process.exit(0); }
if (op === 'start') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
  console.log('attached-ready');
  child.on('exit', () => process.exit(0));
} else { console.log('sha256:' + 'a'.repeat(64)); }
`, { mode: 0o700 });
    const sourceRoot = join(directory, "source");
    mkdirSync(sourceRoot);
    writeFileSync(join(sourceRoot, "main.cjs"), "module.exports = 1;\n");
    const config = parseEvolutionConfig({
      schemaVersion: 1, sourceRoot, storePath: join(directory, "store"),
      image: `sha256:${"a".repeat(64)}`, sourcePaths: ["main.cjs"], editablePaths: ["main.cjs"],
      command: ["node", "main.cjs"], objective: "exercise cleanup uncertainty", computeUsdPerSecond: 0.001,
      timeoutMs: 10000,
      cases: (["development", "held-out", "negative-control"] as const).flatMap(lane =>
        Array.from({ length: 10 }, (_, index) => ({
          id: `${lane}-${index}`, lane, input: { lane, index }, expected: null,
        }))),
    });
    const snapshot = await snapshotEvolutionSource(config);
    const abort = new AbortController();
    const outcome = await createDockerEvolutionSandbox(binary)({
      config, snapshot, input: null, signal: abort.signal,
      channel: {
        onReady() {},
        onData(data) { if (data.includes("attached-ready")) abort.abort(); },
      },
    });
    expect(outcome.cleanupFailed).toBe(true);
    expect(outcome.error).toMatch(/cleanup/);
    expect(existsSync(removed)).toBe(true);
    await expect.poll(() => descendantRunning(pidFile)).toBe(false);
  });
});
