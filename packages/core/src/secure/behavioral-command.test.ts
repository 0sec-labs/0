import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSecureCommand } from "./behavioral-command.js";

const dirs: string[] = [];
async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "secure-command-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("runSecureCommand output cap", () => {
  it("lets a verbose successful command finish with truncated output", async () => {
    const cwd = await tempCwd();
    // Emit well beyond the 2 MiB capture cap, then exit cleanly. A
    // verbose-but-successful baseline test must not be killed for its
    // output volume.
    const result = await runSecureCommand(
      "/bin/sh",
      ["-c", "for i in $(seq 1 2200); do printf '%1024s' ''; done; echo DONE"],
      cwd,
      new AbortController().signal,
    );
    expect(result.interrupted).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 16);
    expect(result.stdout.length).toBeGreaterThan(2 * 1024 * 1024 - 2048);
  });

  it("still interrupts on abort and kills the process", async () => {
    const cwd = await tempCwd();
    const controller = new AbortController();
    // Aborting synchronously after the call exercises the immediate
    // `signal.aborted` check — no wall-clock timers needed.
    const pending = runSecureCommand("/bin/sh", ["-c", "sleep 30"], cwd, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.interrupted).toBe(true);
  });
});