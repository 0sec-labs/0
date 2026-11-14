import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as http from "../http.js";
import type { NativeRuntime } from "../runtime/types.js";
import { ScopePolicy } from "../scope/scope.js";
import { withLocalSourceBoundary } from "../scope/local-source-boundary.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
import type { ToolContext } from "./types.js";

it.each([
  { mode: "yolo", bounded: false, hasHttp: true },
  { mode: "copilot", bounded: false, hasHttp: true },
  { mode: "standard", bounded: false, hasHttp: false },
  { mode: "yolo", bounded: true, hasHttp: false },
] as const)("inherits only approved console tools in $mode (source boundary=$bounded)", async ({ mode, bounded, hasHttp }) => {
  const root = mkdtempSync(join(tmpdir(), "0-console-web-delegation-"));
  const fetch = vi.spyOn(http, "fetchScoped").mockResolvedValue(new Response("public metadata", { status: 200 }));
  let advertisedHttp = false;
  let turn = 0;
  const child: NativeRuntime = {
    type: "api", isAvailable: async () => true,
    executeNative: async (_system, _messages, tools) => {
      turn++;
      advertisedHttp = tools.some(tool => tool.name === "http_request");
      expect(tools.some(tool => tool.name === "bash")).toBe(false);
      if (turn === 1 && advertisedHttp) return {
        content: [{ type: "tool_use", id: "public-get", name: "http_request", input: { url: "https://allowed.test/status", method: "GET" } }],
        stopReason: "tool_use", durationMs: 0,
      };
      return {
        content: [{ type: "tool_use", id: "complete", name: "done", input: { summary: "Assigned public metadata check finished or unavailable." } }],
        stopReason: "tool_use", durationMs: 0,
      };
    },
  };
  const ctx: ToolContext = {
    target: "https://allowed.test", scanId: "console-web-delegation-test", role: "audit", consoleSession: true,
    scopePath: root, scope: ScopePolicy.fromJson({ in_scope: ["allowed.test"] }), autonomyMode: mode,
    delegationTools: [TOOL_DEFINITIONS.http_request!, TOOL_DEFINITIONS.done!],
    findings: [], attackResults: [], targetInfo: {},
  };
  try {
    await withLocalSourceBoundary(bounded ? root : undefined, async () => {
      const executor = new ToolExecutor(ctx, null, undefined, async () => child);
      const result = await executor.execute({ name: "spawn_agent", arguments: { task: "Inspect assigned public metadata only.", max_turns: 2, wait: true } });
      expect(result.success).toBe(true);
      expect(advertisedHttp).toBe(hasHttp);
      expect(fetch).toHaveBeenCalledTimes(hasHttp ? 1 : 0);
      if (hasHttp) expect(result.output).toMatchObject({ done: true });
    });
  } finally {
    fetch.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
