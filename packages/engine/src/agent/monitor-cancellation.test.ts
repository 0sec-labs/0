import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./process-manager.js", async original => ({
  ...await original<object>(),
  probePort: vi.fn(async () => false),
}));
import { ProcessManager, RingLog, probePort, type ManagedProc } from "./process-manager.js";
import { ToolExecutor } from "./tools.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const kill = vi.fn(() => true);
  const proc: ManagedProc = {
    name: "fixture", pid: 123456, status: "running", exitCode: null,
    startedAt: 0, log: new RingLog(), child: { kill } as unknown as ChildProcess,
  };
  const start = vi.spyOn(ProcessManager.prototype, "start").mockImplementation(() => proc);
  const get = vi.spyOn(ProcessManager.prototype, "get").mockReturnValue(proc);
  const cleanup = vi.spyOn(ProcessManager.prototype, "killAll").mockImplementation(() => { kill(); });
  const executor = new ToolExecutor({
    scanId: "monitor-cancellation", target: "https://target.test",
    findings: [], attackResults: [], targetInfo: {},
  }, null);
  return { executor, proc, start, get, kill, cleanup };
}

describe("monitor cancellation", () => {
  it.each(["ready-log", "ready-port", "wait"] as const)("interrupts %s polling without claiming to stop its process", async mode => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const args = mode === "wait"
      ? { op: "wait", name: "fixture", timeout_s: 300 }
      : { op: "start", name: "fixture", command: "synthetic-never-spawned", ready_timeout_s: 300,
        ...(mode === "ready-log" ? { ready_log: "never-ready" } : { ready_port: 1 }) };
    const pending = f.executor.execute({ name: "monitor", arguments: args }, { signal: controller.signal });
    try {
      await vi.waitFor(() => expect(mode === "wait" ? f.get : f.start).toHaveBeenCalled());
      const stoppedAt = Date.now();
      controller.abort();
      const result = await pending;
      expect(Date.now()).toBe(stoppedAt);
      expect(result).toMatchObject({ success: false, output: { reason: "cancelled", status: "running", name: "fixture" } });
      expect(result.error).toContain("only the wait");
      expect(f.kill).not.toHaveBeenCalled();
      expect(f.proc.status).toBe("running");
      expect(vi.getTimerCount()).toBe(0);
      await f.executor.cleanup();
      expect(f.cleanup).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await pending;
      await f.executor.cleanup();
    }
  }, 1000);

  it("retains cancellation when an in-flight port probe later reports readiness", async () => {
    const f = fixture();
    const controller = new AbortController();
    const probe = Promise.withResolvers<boolean>();
    vi.mocked(probePort).mockReturnValueOnce(probe.promise);
    const pending = f.executor.execute({ name: "monitor", arguments: {
      op: "start", name: "fixture", command: "synthetic-never-spawned", ready_port: 1,
    } }, { signal: controller.signal });
    try {
      await vi.waitFor(() => expect(f.start).toHaveBeenCalled());
      controller.abort();
      probe.resolve(true);
      expect(await pending).toMatchObject({ success: false, output: { reason: "cancelled", status: "running" } });
      expect(f.kill).not.toHaveBeenCalled();
    } finally { probe.resolve(false); await pending; await f.executor.cleanup(); }
  });

  it("does not start a process when the operation is already cancelled", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    try {
      expect((await f.executor.execute({ name: "monitor", arguments: {
        op: "start", name: "fixture", command: "synthetic-never-spawned", ready_log: "ready",
      } }, { signal: controller.signal })).success).toBe(false);
      expect(f.start).not.toHaveBeenCalled();
    } finally { await f.executor.cleanup(); }
  });
});
