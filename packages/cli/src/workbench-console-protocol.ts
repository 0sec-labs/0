import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ConsoleSessionConfig, ConsoleSessionCheckpoint } from "@0/core";

export const WORKBENCH_FRAME_BYTES = 8 * 1024 * 1024;
export const WORKBENCH_MAX_PENDING = 64;
export interface WorkbenchFrame { type: string; id?: string; [key: string]: unknown; }
export function encodeWorkbenchFrame(frame: WorkbenchFrame): string {
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded) > WORKBENCH_FRAME_BYTES) throw new Error("Workbench protocol frame exceeds its byte limit");
  return encoded + "\n";
}
export class WorkbenchFrameReader {
  #pending = "";
  push(data: string, receive: (frame: WorkbenchFrame) => void): void {
    this.#pending += data;
    let newline: number;
    while ((newline = this.#pending.indexOf("\n")) !== -1) {
      const line = this.#pending.slice(0, newline); this.#pending = this.#pending.slice(newline + 1);
      if (!line || Buffer.byteLength(line) > WORKBENCH_FRAME_BYTES) throw new Error("Invalid workbench protocol frame size");
      const frame: unknown = JSON.parse(line);
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof (frame as WorkbenchFrame).type !== "string") throw new Error("Invalid workbench protocol frame");
      const parsed = frame as WorkbenchFrame;
      if (parsed.id !== undefined && (typeof parsed.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(parsed.id))) throw new Error("Invalid workbench protocol request id");
      receive(parsed);
    }
    if (Buffer.byteLength(this.#pending) > WORKBENCH_FRAME_BYTES) throw new Error("Workbench protocol input exceeds its byte limit");
  }
}
export function guestWorkspacePath(path: string, workspace: string): string {
  if (path === "/workspace" || path.startsWith("/workspace/")) {
    const normalized = resolve(path);
    if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) throw new Error("Invalid guest workspace path");
    return normalized;
  }
  if (!isAbsolute(path)) throw new Error("Workbench scope requires an absolute host path");
  const suffix = relative(workspace, path);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("Requested host path is outside the granted workbench workspace");
  return suffix ? `/workspace/${suffix.split(sep).join("/")}` : "/workspace";
}
export function hostWorkspacePath(path: string, workspace: string): string {
  if (path === "/workspace" || path.startsWith("/workspace/")) {
    const normalized = resolve(path);
    if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) throw new Error("Invalid guest workspace path");
    return resolve(workspace, relative("/workspace", normalized));
  }
  throw new Error("Guest local scope is outside the granted workspace");
}
export function mapWorkbenchTarget(target: string, workspace: string, host = false): string {
  const map = host ? hostWorkspacePath : guestWorkspacePath;
  if (isAbsolute(target)) return map(target, workspace);
  if (target.startsWith("source:") && isAbsolute(target.slice(7))) return `source:${map(target.slice(7), workspace)}`;
  return target;
}
export function mapWorkbenchCheckpoint(checkpoint: ConsoleSessionCheckpoint, workspace: string, host: boolean): ConsoleSessionCheckpoint {
  const result = structuredClone(checkpoint);
  const map = host ? hostWorkspacePath : guestWorkspacePath;
  result.workspaceRoot = map(result.workspaceRoot, workspace);
  result.target = mapWorkbenchTarget(result.target, workspace, host);
  if (result.localScopePath) result.localScopePath = map(result.localScopePath, workspace);
  result.deniedLocalPaths = result.deniedLocalPaths.map(path => {
    try { return map(path, workspace); } catch { return path; } // Denials never create authority.
  });
  if (result.harnessRoot) {
    // Live executable resources cannot be restored merely by copying a host path.
    throw new Error("Workbench checkpoint handoff with live executable resources is not supported");
  }
  return result;
}

/** Serialize only engine values, never runtime/auth/live host resources. */
export function serializeWorkbenchConfig(config: Omit<ConsoleSessionConfig, "runtime" | "db">, workspace: string): Record<string, unknown> {
  for (const key of ["pluginHost", "mcpHost", "jevRuntime", "contribution", "developmentSourceRoot", "executablePlugins", "executableEvolutionProfiles"] as const) {
    if (config[key] !== undefined) throw new Error(`Host ${key} cannot execute through the workbench controller`);
  }
  const result: Record<string, unknown> = { workspaceRoot: "/workspace", target: mapWorkbenchTarget(config.target ?? "", workspace) };
  for (const key of ["role", "tools", "scanId", "maxToolIterations", "allowScanners", "systemPrompt", "autonomyMode", "refineObjective", "allowModelSelfExtension", "costModel", "contextWindowTokens", "compaction", "initialMessages"] as const) {
    if (config[key] !== undefined) result[key] = structuredClone(config[key]);
  }
  if (config.maxTurnTokens !== undefined && Number.isFinite(config.maxTurnTokens)) result.maxTurnTokens = config.maxTurnTokens;
  if (config.scope) result.scope = config.scope.raw;
  if (config.initialCheckpoint) result.initialCheckpoint = mapWorkbenchCheckpoint(config.initialCheckpoint, workspace, false);
  if (config.agentMessaging && typeof config.agentMessaging === "object") {
    const messaging = config.agentMessaging as Record<string, unknown>;
    result.agentMessaging = { selfId: messaging.selfId, selfRole: messaging.selfRole, parentId: messaging.parentId, operatorId: messaging.operatorId,
      siblingPrefix: messaging.siblingPrefix, siblingChannelEnabled: messaging.siblingChannelEnabled, operatorChannelEnabled: messaging.operatorChannelEnabled,
      projectPath: "/workspace", homeDir: "/home/zero" };
  }
  return result;
}

/** Interpret only known path-valued CLI options; operator prose is never rewritten. */
export function mapWorkbenchCliArguments(args: readonly string[], workspace: string): string[] {
  const targetFlags = new Set(["--target", "-t", "--repo"]);
  const pathFlags = new Set(["--scope", "--db-path", "--workspace", "--workspace-root", "--cwd", "--output", "-o", "--config"]);
  const result = [...args];
  for (let index = 0; index < result.length; index++) {
    const argument = result[index]!; const equal = argument.indexOf("=");
    const flag = equal < 0 ? argument : argument.slice(0, equal);
    if (!targetFlags.has(flag) && !pathFlags.has(flag)) continue;
    const valueIndex = equal < 0 ? index + 1 : index;
    const value = equal < 0 ? result[valueIndex] : argument.slice(equal + 1);
    if (value === undefined) throw new Error(`Missing workbench argument for ${flag}`);
    const mapped = targetFlags.has(flag) ? mapWorkbenchTarget(value, workspace) : isAbsolute(value) ? guestWorkspacePath(value, workspace) : value;
    result[valueIndex] = equal < 0 ? mapped : `${flag}=${mapped}`;
    if (equal < 0) index++;
  }
  return result;
}
