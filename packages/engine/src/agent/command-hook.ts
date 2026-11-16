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
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const json = (args: Args): string => { try { return JSON.stringify(args); } catch { return ""; } };

/** Targets of an `apply_patch` envelope: every `*** Add|Replace|Update|Delete File: <path>` header. */
export function patchTargets(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Replace|Update|Delete) File:\s*(.+?)\s*$/gm)].map(m => m[1]!);
}

const code = (a: Args): HookTarget => ({ kind: "bash", command: str(a["code"]), paths: [] });
const pathArg = (a: Args): string[] => [str(a["path"])].filter(Boolean);

export const EXECUTING_TOOLS: Readonly<Record<string, (args: Args) => HookTarget>> = Object.freeze({
  bash: a => ({ kind: "bash", command: str(a["command"]), paths: [] }),
  js_eval: code, python_eval: code, python_exec: code,
  run_command: a => ({ kind: "process", command: str(a["command"]), paths: [], ...(str(a["cwd"]) ? { cwd: str(a["cwd"]) } : {}) }),
  monitor: a => {
    const op = str(a["op"]);
    if (op === "start") return { kind: "process", command: [str(a["command"]), ...strs(a["args"])].join(" "), paths: [], ...(str(a["cwd"]) ? { cwd: str(a["cwd"]) } : {}) };
    if (op === "send") return { kind: "process", command: str(a["text"]), paths: [] };
    return { kind: "process", command: `monitor ${op} ${str(a["name"])}`, paths: [] };
  },
  pty_session: a => ({ kind: "process", command: str(a["action"]) === "send" ? str(a["input"]) : `pty_session ${str(a["action"])} ${str(a["session_name"])}`, paths: [] }),
  run_scanner: a => ({ kind: "process", command: `${str(a["tool"])} ${json(a)}`, paths: [] }),
  analyze_binary: a => ({ kind: "process", command: json(a), paths: [str(a["binary_path"])].filter(Boolean) }),
  memsafety_fuzz: a => ({ kind: "process", command: json(a), paths: [] }),
  npm_dynamic_discovery: a => ({ kind: "process", command: json(a), paths: [] }),
  weaponize_kernel: a => ({ kind: "process", command: json(a), paths: [] }),
  cve_adapt: a => ({ kind: "process", command: json(a), paths: [] }),
  str_replace: a => ({ kind: "file-write", command: "str_replace", paths: pathArg(a) }),
  apply_patch: a => ({ kind: "file-write", command: "apply_patch", paths: patchTargets(str(a["patch"]) || str(a["input"]) || json(a)) }),
  create_skill: a => ({ kind: "file-write", command: "create_skill", paths: pathArg(a) }),
  save_skill: a => ({ kind: "file-write", command: "save_skill", paths: pathArg(a) }),
  copy_skill: a => ({ kind: "file-write", command: "copy_skill", paths: pathArg(a) }),
  read_file: a => ({ kind: "file-read", command: "read_file", paths: pathArg(a) }),
  list_files: a => ({ kind: "file-read", command: "list_files", paths: pathArg(a) }),
  search_files: a => ({ kind: "file-read", command: "search_files", paths: pathArg(a) }),
});

/** Tools whose reach is a host, gated by their own scope checks (and by the console as kind `network`). */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  "http_request", "send_prompt", "crawl", "submit_form", "access_control_probe", "access_control_workflow", "access_control_cleanup", "browser",
  "wp_fingerprint", "discover_api_surface", "surface_sweep", "js_recon", "structural_sqli_probe", "prompt_layer_probe", "auth_boundary_probe",
  "cloud_s3_probe", "cloud_validate_credentials", "oast_register", "oast_poll", "proxy", "web_search", "intel", "cve_lookup", "ad_attack_paths",
  "entra_attack_paths", "entra_posture",
]);

export const DELEGATING_TOOLS: ReadonlySet<string> = new Set(["spawn_agent", "spawn_agents", "spawn_persistent_agent"]);

/** No process, file or network effect of their own. Adding a tool here is a reviewed decision. */
export const INERT_TOOLS: ReadonlySet<string> = new Set([
  "save_finding", "query_findings", "use_loot", "plan", "update_finding", "update_target", "payload_lookup", "mongo_objectid", "list_skills", "load_skill",
  "read_skill", "done", "ask_operator", "update_todos", "write_todos", "visualize", "remember_codebase", "assemble_advisory", "variant_hunt",
  "assumption_hunt", "generate_fix", "verify_finding", "protocol_conformance", "spec_drift", "safety_eval",
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
