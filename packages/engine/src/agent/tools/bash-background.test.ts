import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBashWithWallclock } from "./exec-helpers.js";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids: number[] = [];
afterEach(() => { for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });

describe("bash background processes", () => {
  it("returns at once for a nohup, redirected process that then survives the call and can be killed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "0-bg-"));
    const log = join(dir, "x.log");
    try {
      const started = Date.now();
      const outcome = await runBashWithWallclock(`nohup sh -c 'echo ready; sleep 30' > ${log} 2>&1 & echo $!`, { timeoutMs: 10_000, ceilingMs: 10_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      expect(outcome.kind).toBe("exit");
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number((outcome as { combined: string }).combined.trim().split(/\s+/).pop());
      expect(pid).toBeGreaterThan(1);
      pids.push(pid);
      expect(alive(pid)).toBe(true);
      for (let i = 0; i < 50 && !(existsSync(log) && readFileSync(log, "utf8").includes("ready")); i++) await new Promise(r => setTimeout(r, 100));
      expect(readFileSync(log, "utf8")).toContain("ready");
      const stopped = await runBashWithWallclock(`kill ${pid}`, { timeoutMs: 5_000, ceilingMs: 5_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      expect(stopped.kind).toBe("exit");
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
