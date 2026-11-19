import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A compiled `0` cannot run `process.execPath -e <script>`: it prints "unknown option '-e'" and exits 1 with no output.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding(): void }; exitCode: number | null; kill(): void };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.exitCode = null;
    child.kill = () => {};
    queueMicrotask(() => { child.exitCode = 1; child.emit("close", 1); });
    return child;
  }),
}));

import { childProcessProbe } from "./workspace-folder-check.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("childProcessProbe when the child cannot run the probe (a compiled build)", () => {
  it("reads a real folder in this process instead of calling it unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zero-probe-compiled-"));
    dirs.push(dir);
    expect(await childProcessProbe(dir).done).toEqual({ ok: true });
  });
  it("still reports a missing folder as missing", async () => {
    expect(await childProcessProbe(join(tmpdir(), "zero-probe-compiled-missing-xyz")).done).toEqual({ ok: false, code: "ENOENT" });
  });
});
