import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createConsoleSession, type NativeRuntime, type NativeRuntimeResult } from "@0/core";
import { consoleMcpConfig, connectConsoleMcp } from "./console-mcp.js";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "0-mcp-config-")); homes.push(home);
  const root = join(home, "0verse"); mkdirSync(join(root, "src/zeroverse"), { recursive: true }); mkdirSync(join(root, ".venv/bin"), { recursive: true });
  writeFileSync(join(root, "src/zeroverse/mcp.py"), ""); writeFileSync(join(root, ".venv/bin/python"), ""); return { home, root };
}
test("explicit MCP config takes precedence over local auto discovery", () => {
  const { home } = fixture(); expect(consoleMcpConfig(home, { ZERO_MCP: "[]" })).toEqual([]);
  expect(consoleMcpConfig(home, { ZERO_0VERSE_MCP: "0" })).toEqual([]);
});
test("discovers local MCP tools with workspace cwd and source interpreter", () => {
  const { home, root } = fixture(); const config = consoleMcpConfig(home, { PYTHONPATH: "/existing", ZERO_0VERSE_RUNTIME_CONFIG: join(home, "absent-runtime"), OPENAI_API_KEY: "must-not-inherit" });
  expect(config).toMatchObject([{ id: "zeroverse", command: join(root, ".venv/bin/python"), args: ["-m", "zeroverse.mcp"], cwd: home, env: { PYTHONUNBUFFERED: "1", PYTHONPATH: `${root}/src:/existing` } }]);
  expect("env" in config[0]! && config[0].env?.OPENAI_API_KEY).toBeUndefined();
  expect("env" in config[0]! && config[0].env?.ZEROVERSE_FLYWHEEL).toBe("1");
});
test("explicit broken source/environment is reported instead of silently losing tools", () => {
  const { home, root } = fixture(); rmSync(join(root, ".venv/bin/python"));
  expect(() => consoleMcpConfig(home, { ZERO_0VERSE_RUNTIME_CONFIG: join(home, "absent-runtime") })).toThrow(/local environment/);
  expect(() => consoleMcpConfig(home, { ZERO_0VERSE_ROOT: join(home, "missing") })).toThrow(/source not found/);
});

test.runIf(process.env.ZERO_TEST_LOCAL_0VERSE === "1")("real local MCP handshake discovers tools without a model request", async () => {
  const env = { ...process.env }; delete env.ZERO_MCP;
  const host = await connectConsoleMcp(process.cwd(), env);
  try {
    expect(host?.serverIds()).toContain("zeroverse");
    const tools = host!.registeredTools().map(tool => tool.name);
    expect(tools).toContain("mcp__zeroverse__scan_binary");
    expect(tools).toContain("mcp__zeroverse__get_report");
    expect(tools).toContain("mcp__zeroverse__triage_binary");
    expect(tools).toContain("mcp__zeroverse__preflight_binary");
    expect(tools).toContain("mcp__zeroverse__get_capabilities");
    expect(tools).toContain("mcp__zeroverse__list_bug_classes");
    expect(tools).toContain("mcp__zeroverse__recall_similar");
    const capabilities = await host!.callTool("mcp__zeroverse__get_capabilities", {});
    expect(capabilities.success).toBe(true);
    expect(JSON.stringify(capabilities.output)).toContain("scan_binary");
    expect(host!.toolGateFlags("mcp__zeroverse__scan_binary")).toEqual({ networkCapable: true, localScope: true, readOnly: false });
    const replies: NativeRuntimeResult[] = [
      { content: [
        { type: "tool_use", id: "discover", name: "mcp__zeroverse__get_capabilities", input: {} },
        { type: "tool_use", id: "classes", name: "mcp__zeroverse__list_bug_classes", input: {} },
        { type: "tool_use", id: "unknown", name: "mcp__zeroverse__unregistered", input: {} },
      ], stopReason: "tool_use", durationMs: 1 },
      { content: [{ type: "text", text: "Finished" }], stopReason: "end_turn", durationMs: 1 },
    ];
    const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async () => replies.shift()! };
    const session = createConsoleSession({ runtime, mcpHost: host, autonomyMode: "standard", workspaceRoot: process.cwd() });
    try {
      expect(session.tools.filter(tool => tool.name.startsWith("mcp__zeroverse__"))).toHaveLength(9);
      const result = await session.send("Discover the local binary analysis tools");
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls[0].result.success).toBe(true);
      expect(result.toolCalls[1].result.success).toBe(true);
      expect(result.toolCalls[2].result.success).toBe(false);
      expect(result.toolCalls[2].result.error).toContain("unresolved capability");
    } finally { await session.cleanup(); }
  } finally { await host?.closeAll(); }
}, 20_000);

test("runtime setup paths are injected while explicit runtime env wins", () => {
  const { home, root } = fixture(); const runtime = join(home, "runtime.json");
  writeFileSync(runtime, JSON.stringify({ version: 1, pythonPath: join(root, ".venv/bin/python"), ghidraInstallDir: home, javaHome: root }));
  const config = consoleMcpConfig(home, { ZERO_0VERSE_RUNTIME_CONFIG: runtime, JAVA_HOME: home, ZEROVERSE_FLYWHEEL: "0" })[0]!;
  expect("env" in config && config.env).toMatchObject({ GHIDRA_INSTALL_DIR: home, JAVA_HOME: home, ZEROVERSE_WORKSPACE_ROOT: home, ZEROVERSE_FLYWHEEL: "0" });
});
