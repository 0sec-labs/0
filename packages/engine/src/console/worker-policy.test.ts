import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NativeRuntime } from "../runtime/types.js";
import { createConsoleSession } from "./turn-engine.js";
import { snapshotWorkerPolicy } from "../workflow-execution-policy.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "0-worker-policy-"))); roots.push(root);
  vi.stubEnv("HOME", root); vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async () => ({ content: [{ type: "text", text: "Ready." }], stopReason: "end_turn", durationMs: 0 }) };
  return { root, runtime };
}

describe("operator worker policy", () => {
  it("updates an existing idle session, reads back an immutable copy, and retains its checkpoint ceiling", async () => {
    const { root, runtime } = setup();
    const session = createConsoleSession({ runtime, workspaceRoot: root, autonomyMode: "yolo" });
    let checkpoint: ReturnType<typeof session.exportCheckpoint>;
    try {
      await session.ready;
      const policy = { allowedTools: ["http_request", "done"], allowedHttpMethods: ["GET" as const], maxTurns: 6 };
      session.setWorkerPolicy!(policy);
      policy.allowedTools.push("save_finding");
      expect(session.workerPolicy).toEqual({ allowedTools: ["http_request", "done"], allowedHttpMethods: ["GET"], maxTurns: 6 });
      expect(Object.isFrozen(session.workerPolicy)).toBe(true); expect(Object.isFrozen(session.workerPolicy?.allowedTools)).toBe(true);
      await session.send("Return ready without performing any actions.");
      checkpoint = session.exportCheckpoint();
      expect(checkpoint.workerPolicy).toEqual(session.workerPolicy);
      expect(() => session.setWorkerPolicy!({ allowedTools: ["not_a_real_tool"] })).toThrow("unknown tool");
      expect(session.workerPolicy?.maxTurns).toBe(6);
    } finally { await session.cleanup(); }
    const resumed = createConsoleSession({ runtime, initialCheckpoint: checkpoint!, workerPolicy: { allowedTools: ["http_request", "done", "save_finding"], allowedHttpMethods: ["GET", "POST"], maxTurns: 100 } });
    try {
      await resumed.ready;
      expect(resumed.workerPolicy).toEqual({ allowedTools: ["http_request", "done"], allowedHttpMethods: ["GET"], maxTurns: 6 });
    } finally { await resumed.cleanup(); }
  });

  it("validates mandatory ceiling fields and preserves an explicit deny-all policy", () => {
    expect(snapshotWorkerPolicy({ allowedTools: [], allowedHttpMethods: [], maxTurns: 1 })).toEqual({ allowedTools: [], allowedHttpMethods: [], maxTurns: 1 });
    expect(snapshotWorkerPolicy(undefined)).toBeUndefined();
    for (const value of [{ maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: 10_001 }, { allowedTools: ["done", "done"] }, { allowedHttpMethods: ["TRACE"] }, { unexpected: true }]) {
      expect(() => snapshotWorkerPolicy(value as never)).toThrow();
    }
  });
});
