/**
 * Core toolset: the small default tool list the model sees, and the tool packs
 * that skills can add on demand. See docs/design/core-toolset.md and
 * docs/design/tool-philosophy.md.
 *
 * This module only decides what is ADVERTISED. It never grants authority: the
 * set it is applied to has already passed role, scope, feature-flag and access
 * gating (`getToolsForRole`), and every call still passes the same dispatch
 * gates (Read-only refusal, scope, approvals) whichever list the model saw.
 */
import type { ToolDefinition } from "./types.js";

export type Toolset = "core" | "full";

/**
 * The model-visible default. One shell, file read/search/edit, findings, a way
 * to ask the operator, skills (which carry know-how and may load packs), done.
 * `list_files` and `search_files` stay because they are the Read-only
 * exploration path: Read-only refuses the shell, so without them it could not
 * look around a repository.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  "bash",
  "read_file",
  "list_files",
  "search_files",
  "str_replace",
  "apply_patch",
  "save_finding",
  "update_finding",
  "ask_operator",
  "memory",
  "load_skill",
  "done",
];

/**
 * Packs: named groups of existing tool definitions that load only when a loaded
 * skill declares them (`tools: [pack]` in skill frontmatter). A pack holds the
 * canonical name for each capability; the aliases below stay dispatchable.
 */
export const TOOL_PACKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "web-probe": ["http_request", "crawl", "submit_form", "send_prompt", "discover_api_surface", "surface_sweep", "js_recon", "wp_fingerprint", "mongo_objectid", "payload_lookup", "update_target"],
  browser: ["browser"],
  "access-control": ["access_control_probe", "access_control_workflow", "access_control_cleanup", "auth_boundary_probe"],
  probes: ["structural_sqli_probe", "prompt_layer_probe"],
  scanners: ["run_scanner"],
  cloud: ["cloud_s3_probe", "cloud_validate_credentials"],
  oast: ["oast_register", "oast_poll"],
  proxy: ["proxy"],
  binary: ["analyze_binary"],
  kernel: ["weaponize_kernel", "cve_adapt"],
  fuzz: ["memsafety_fuzz", "npm_dynamic_discovery"],
  identity: ["ad_attack_paths", "entra_attack_paths", "entra_posture"],
  intel: ["intel", "web_search", "cve_lookup", "assemble_advisory"],
  "source-audit": ["variant_hunt", "assumption_hunt", "generate_fix", "verify_finding", "protocol_conformance", "spec_drift", "safety_eval"],
  delegation: ["spawn_agent", "spawn_persistent_agent", "monitor"],
  ledger: ["query_findings", "use_loot", "plan"],
  planning: ["update_todos", "visualize"],
  "skill-authoring": ["read_skill", "create_skill", "save_skill", "copy_skill"],
});

/**
 * Old name -> canonical name. Aliases stay registered and dispatchable so stored
 * sessions, saved workflows and skills keep working, but they are never
 * advertised by a pack or by the core list.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  run_command: "bash",
  pty_session: "bash",
  python_exec: "bash",
  python_eval: "bash",
  js_eval: "bash",
  spawn_agents: "spawn_agent",
  write_todos: "update_todos",
  list_skills: "load_skill",
});

export function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/** `core` and `pack:<name>` are accepted spellings (docs/design/skills-as-the-unit.md) next to the bare pack name. */
export function normalizePackRef(raw: string): string {
  const ref = raw.trim();
  return ref.startsWith("pack:") ? ref.slice("pack:".length) : ref;
}

/** Whether a skill `tools:` entry names `core` or a known pack. */
export function isKnownPackRef(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const ref = normalizePackRef(raw);
  return ref === "core" || Object.hasOwn(TOOL_PACKS, ref);
}

/** Tool names a pack list resolves to; unknown packs are returned separately. */
export function resolvePacks(packs: readonly string[] | undefined): { tools: string[]; unknown: string[] } {
  const tools = new Set<string>();
  const unknown: string[] = [];
  for (const raw of packs ?? []) {
    const pack = typeof raw === "string" ? normalizePackRef(raw) : "";
    if (!pack || pack === "core") continue;
    const members = TOOL_PACKS[pack];
    if (!members) { unknown.push(pack); continue; }
    for (const name of members) tools.add(name);
  }
  return { tools: [...tools], unknown };
}

/** Every tool a pack can provide. */
export function packToolNames(): Set<string> {
  return new Set(Object.values(TOOL_PACKS).flat());
}

/** The resolved toolset: explicit choice, then ZERO_TOOLSET, then the surface default. */
export function resolveToolset(options: { explicit?: string; surfaceDefault: Toolset; env?: NodeJS.ProcessEnv }): Toolset {
  for (const value of [options.explicit, (options.env ?? process.env).ZERO_TOOLSET]) {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (v === "core" || v === "full") return v;
  }
  return options.surfaceDefault;
}

/** Split an already-authorized tool list into what stays advertised and what only packs can add. */
export function partitionForToolset(defs: readonly ToolDefinition[], toolset: Toolset): { advertised: ToolDefinition[]; packOnly: ToolDefinition[] } {
  if (toolset === "full") return { advertised: [...defs], packOnly: [] };
  const core = new Set(CORE_TOOL_NAMES);
  const packed = packToolNames();
  const advertised: ToolDefinition[] = [];
  const packOnly: ToolDefinition[] = [];
  for (const def of defs) {
    if (core.has(def.name)) advertised.push(def);
    else if (packed.has(def.name)) packOnly.push(def);
    // Anything else (aliases, injected tools) is not part of the core list.
  }
  return { advertised, packOnly };
}
