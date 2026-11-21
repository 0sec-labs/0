/**
 * Safety of the shell-first core toolset. With `bash` as the main action tool the
 * access boundary must not depend on parsing shell text, so these tests drive the
 * real console dispatch and assert on side effects, not on the classifier.
 *
 * There is one mode (shell access). What limits it: "ask before running commands"
 * puts every command to the operator. See docs/design/core-toolset.md for the known gaps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleSession } from "./turn-engine.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult, NativeToolDef } from "../runtime/types.js";

class ScriptedRuntime implements NativeRuntime {
  readonly type = "api" as const;
  constructor(private readonly script: NativeRuntimeResult[]) {}
  async isAvailable(): Promise<boolean> { return true; }
  async executeNative(_s: string, _m: NativeMessage[], _t: NativeToolDef[]): Promise<NativeRuntimeResult> {
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}
const end = (text: string): NativeRuntimeResult => ({ content: [{ type: "text", text }], stopReason: "end_turn", durationMs: 1 });
const use = (name: string, input: Record<string, unknown>): NativeRuntimeResult => ({ content: [{ type: "tool_use", id: "c1", name, input }], stopReason: "tool_use", durationMs: 1 });

let dir: string;
let mark: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "core-safety-")); mark = join(dir, "MARK"); writeFileSync(join(dir, "victim.txt"), "keep\n"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("There is one mode: the shell runs, and an older access value changes nothing", () => {
  for (const legacy of ["standard", "yolo"] as const) {
    it(`bash runs with the stored value ${legacy}${legacy === "standard" ? " (still asks first, as before)" : ""}`, async () => {
      const asks = legacy === "standard";
      const approveTool = vi.fn(async () => true);
      const session = createConsoleSession({
        runtime: new ScriptedRuntime([use("bash", { command: `touch ${mark}` }), end("done")]),
        autonomyMode: legacy, ...(asks ? { approveTool } : {}), refineObjective: false,
      });
      try {
        const result = (await session.send("create the marker")).toolCalls[0]!.result;
        expect(result.error ?? "").not.toMatch(/read-only/i);
        expect(existsSync(mark)).toBe(true);
        expect(approveTool).toHaveBeenCalledTimes(asks ? 1 : 0);
      } finally { await session.cleanup(); }
    });
  }
  it("the session no longer exposes an access state", async () => {
    const session = createConsoleSession({ runtime: new ScriptedRuntime([]), autonomyMode: "read-only", refineObjective: false });
    try { expect(session).not.toHaveProperty("autonomyMode"); } finally { await session.cleanup(); }
  });
});

describe("Ask before running commands puts every shell command to the operator", () => {
  it("does not run a command the operator declines, and runs it only after approval", async () => {
    const approveTool = vi.fn(async () => false);
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([use("bash", { command: `touch ${mark}` }), end("declined")]),
      approvals: "ask", approveTool, refineObjective: false,
    });
    try {
      const result = (await session.send("create the marker")).toolCalls[0]!.result;
      expect(approveTool).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(existsSync(mark)).toBe(false);
    } finally { await session.cleanup(); }

    const approve = vi.fn(async () => true);
    const approved = createConsoleSession({
      runtime: new ScriptedRuntime([use("bash", { command: `touch ${mark}` }), end("done")]),
      approvals: "ask", approveTool: approve, refineObjective: false,
    });
    try {
      await approved.send("create the marker");
      expect(approve).toHaveBeenCalledTimes(1);
      expect(existsSync(mark)).toBe(true);
    } finally { await approved.cleanup(); }
  });
});
