import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpHost, connectMcpServers, parseMcpConfig, sanitizedEnv, type McpServerConfig } from "@0/core";

function findZeroverse(start: string): string | undefined {
  let directory = resolve(start);
  for (;;) {
    const candidate = join(directory, "0verse");
    if (existsSync(join(candidate, "src/zeroverse/mcp.py"))) return candidate;
    const parent = dirname(directory); if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Each console connects these configs independently: engine caches never cross chats. */
export function consoleMcpConfig(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  // An explicit configuration (including [] or an empty string) is authoritative.
  if (env.ZERO_MCP !== undefined) return parseMcpConfig(env.ZERO_MCP);
  if (env.ZERO_0VERSE_MCP === "0") return [];
  const explicit = env.ZERO_0VERSE_ROOT;
  const root = explicit ? resolve(explicit) : findZeroverse(workspaceRoot) ?? findZeroverse(dirname(fileURLToPath(import.meta.url)));
  if (!root) return [];
  if (!existsSync(join(root, "src/zeroverse/mcp.py"))) throw new Error(`0verse MCP source not found at ${root}`);
  const runtimePath = env.ZERO_0VERSE_RUNTIME_CONFIG ?? join(homedir(), ".0/zeroverse-runtime.json");
  let runtime: Record<string, string> = {};
  if (existsSync(runtimePath)) {
    try {
      const value = JSON.parse(readFileSync(runtimePath, "utf8"));
      if (!value || value.version !== 1) throw new Error("Expected version 1");
      for (const key of ["pythonPath", "ghidraInstallDir", "javaHome"]) {
        if (value[key] !== undefined && (typeof value[key] !== "string" || !isAbsolute(value[key]) || !existsSync(value[key]))) throw new Error(`Invalid ${key}`);
      }
      runtime = value;
    } catch (error) { throw new Error(`Invalid 0verse runtime configuration ${runtimePath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const python = runtime.pythonPath ?? join(root, ".venv/bin/python");
  if (!existsSync(python)) throw new Error(`0verse MCP requires its local environment at ${python}. Install 0verse dependencies or set ZERO_0VERSE_MCP=0 to disable it.`);
  const childEnv = sanitizedEnv(env);
  childEnv.PYTHONPATH = [join(root, "src"), env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
  childEnv.PYTHONUNBUFFERED = "1";
  if (env.GHIDRA_INSTALL_DIR ?? runtime.ghidraInstallDir) childEnv.GHIDRA_INSTALL_DIR = (env.GHIDRA_INSTALL_DIR ?? runtime.ghidraInstallDir)!;
  if (env.JAVA_HOME ?? runtime.javaHome) childEnv.JAVA_HOME = (env.JAVA_HOME ?? runtime.javaHome)!;
  childEnv.ZEROVERSE_FLYWHEEL = env.ZEROVERSE_FLYWHEEL ?? "1";
  // Python's local path policy must follow this chat, not the installation tree.
  childEnv.ZEROVERSE_WORKSPACE_ROOT = resolve(workspaceRoot);
  return [{ id: "zeroverse", command: python, args: ["-m", "zeroverse.mcp"], cwd: resolve(workspaceRoot), env: childEnv }];
}

/** Local auto-setup fails visibly; a broken engine must not look like zero tools. */
export async function connectConsoleMcp(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<McpHost | undefined> {
  const configs = consoleMcpConfig(workspaceRoot, env);
  if (env.ZERO_MCP !== undefined || configs.length === 0) return connectMcpServers(configs);
  const host = new McpHost();
  try {
    for (const config of configs) {
      if ("url" in config) await host.connectHttp(config); else await host.connectStdio(config);
    }
    const known = new Set(["get_capabilities", "list_bug_classes", "triage_binary", "preflight_binary", "scan_binary", "list_findings", "get_pov", "get_report", "recall_similar"]);
    for (const tool of host.registeredTools()) {
      const name = tool.name.replace(/^mcp__zeroverse__/, "");
      if (!known.has(name)) continue;
      const discovery = name === "get_capabilities" || name === "list_bug_classes";
      host.setToolGateFlags(tool.name, { networkCapable: name === "scan_binary", localScope: !discovery, readOnly: name !== "scan_binary" });
    }
    return host;
  } catch (error) {
    await host.closeAll();
    throw new Error(`0verse MCP could not start: ${error instanceof Error ? error.message : String(error)}. Run the local 0verse setup or set ZERO_0VERSE_MCP=0 to disable it.`);
  }
}

/** Shared interpreter/environment for direct local CLI commands; MCP overrides do not affect it. */
export function localZeroverseRuntime(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): { pythonPath: string; cwd: string; env: Record<string, string> } | undefined {
  const config = consoleMcpConfig(workspaceRoot, { ...env, ZERO_MCP: undefined, ZERO_0VERSE_MCP: undefined })[0];
  if (!config || "url" in config) return undefined;
  return { pythonPath: config.command, cwd: config.cwd!, env: config.env! };
}
