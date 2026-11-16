/** Cross-process lock for read-modify-write of state.json: an exclusive lock file, stale after 30 s or when its owner is gone. */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { err, ok, type Result } from "../core/result.js";

const STALE_MS = 30_000; const WAIT_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const ownerGone = (path: string): boolean => {
  try {
    const pid = Number(readFileSync(path, "utf8").split(" ")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return false; }
};

export function withLock<T>(path: string, fn: () => Result<T>, now: () => number = Date.now): Result<T> {
  const deadline = now() + WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeSync(fd, `${process.pid} ${now()}`); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return err("io", `Could not lock extensions state: ${(e as Error).message}`);
      let stale = false;
      try { stale = now() - statSync(path).mtimeMs > STALE_MS || ownerGone(path); } catch { stale = true; }
      if (stale) { rmSync(path, { force: true }); continue; }
      if (now() > deadline) return err("io", "Another 0 process is changing extension state; try again.");
      sleep(25);
    }
  }
  try { return fn(); } finally { rmSync(path, { force: true }); }
}
