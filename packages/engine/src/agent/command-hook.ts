/**
 * Which tools reach `beforeCommand`, and how a call becomes a hook input. Pure.
 *
 * Every tool in the registry is classified exactly once, so a new tool cannot silently skip the hook:
 *
 *   EXECUTING   runs code, starts a process, feeds one, writes or reads files: classified here, put through
 *               `runBeforeCommand` by `ToolExecutor.execute()` (engine) and the console turn engine.
 *   NETWORK     reaches a host through its own scope gate (host/path allowlist, rate limit); the console also puts
 *               these through the hook as kind `network`.
 *   DELEGATING  spawns an agent; the child's own tool calls reach `execute()` and so the hook.
 *   INERT       no process, no file and no network effect (bookkeeping, findings, lookups).
 *
 * `tools/command-hook.test.ts` enumerates the registry and fails for an unclassified tool.
 */
import { isAbsolute, resolve } from "node:path";
import type { BeforeCommandInput, BeforeCommandKind } from "../hooks/before-command.js";

export interface HookTarget { readonly kind: BeforeCommandKind; readonly command: string; readonly paths: readonly string[]; readonly cwd?: string }
type Args = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const pathArg = (a: Args): string[] => [str(a["path"])].filter(Boolean);

export const EXECUTING_TOOLS: Readonly<Record<string, (args: Args) => HookTarget>> = Object.freeze({
  bash: a => ({ kind: "bash", command: str(a["command"]), paths: [] }),
  str_replace: a => ({ kind: "file-write", command: "str_replace", paths: pathArg(a) }),
});

/** Tools whose reach is a host, gated by their own scope checks (and by the console as kind `network`). */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set(["web_search"]);

export const DELEGATING_TOOLS: ReadonlySet<string> = new Set(["spawn_agent"]);

/** No process, file or network effect of their own. Adding a tool here is a reviewed decision. */
export const INERT_TOOLS: ReadonlySet<string> = new Set([
  "finding", "load_skill",
  "ask_operator", "memory",
]);

export const classifyTool = (name: string): "executing" | "network" | "delegating" | "inert" | "unclassified" =>
  Object.hasOwn(EXECUTING_TOOLS, name) ? "executing" : NETWORK_TOOLS.has(name) ? "network" : DELEGATING_TOOLS.has(name) ? "delegating" : INERT_TOOLS.has(name) ? "inert" : "unclassified";

export interface HookBase { readonly cwd: string; readonly thread: BeforeCommandInput["thread"]; readonly hosts?: readonly string[]; readonly effectful?: boolean }

/** The hook input for an executing tool call, or null when the tool is not an executing one. */
export function hookInputForTool(name: string, args: Args, base: HookBase): BeforeCommandInput | null {
  if (!Object.hasOwn(EXECUTING_TOOLS, name)) return null;
  const target = EXECUTING_TOOLS[name]!(args);
  const cwd = target.cwd ? (isAbsolute(target.cwd) ? resolve(target.cwd) : resolve(base.cwd, target.cwd)) : base.cwd;
  return {
    kind: target.kind, command: target.command, argv: target.command.split(/\s+/).filter(Boolean), cwd,
    hosts: base.hosts ?? [], paths: target.paths, thread: base.thread,
    ...(base.effectful !== undefined ? { effectful: base.effectful } : target.kind === "file-read" ? { effectful: false } : {}),
  };
}
