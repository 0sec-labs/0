/** What an extension can do, derived from its manifest. The approval is bound to this, not to a version string. */
import { createHash } from "node:crypto";
import { isProviderKeyName } from "./env.js";
import type { ExtensionManifest } from "./manifest.js";

export interface Capabilities {
  skills: string[];
  /** Bundled files bash can run. Nothing runs except through bash, under the usual scope, approvals and sandbox. */
  runs: string[];
  mcp: Array<{ name: string; transport: string; command?: string; args: string[]; url?: string; env: string[]; headers: string[] }>;
  service: { service: string; auth: string; hosts: string[]; read: string[]; write: string[]; env: string[] } | null;
  scope: string | null;
  verify: string | null;
  /** Environment variable names its scripts may receive once approved. */
  env: string[];
  bins: string[];
  ignored: string[];
}

export function capabilitiesOf(m: ExtensionManifest): Capabilities {
  return {
    skills: m.skills.map(s => s.name).sort(),
    runs: [...new Set([...m.scripts, ...(m.verify ? [m.verify] : [])])].sort(),
    mcp: m.mcpServers.map(s => ({ name: s.name, transport: s.transport, ...(s.command ? { command: s.command } : {}), args: s.args, ...(s.url ? { url: s.url } : {}), env: s.env, headers: s.headers })).sort((a, b) => (a.name < b.name ? -1 : 1)),
    service: m.connector ? { service: m.connector.service, auth: m.connector.auth, hosts: m.connector.hosts, read: m.connector.read, write: m.connector.write, env: m.connector.env } : null,
    scope: m.scope, verify: m.verify,
    env: [...new Set([...m.requires.env, ...(m.connector?.env ?? [])])].sort(), bins: [...m.requires.bins].sort(), ignored: [...m.ignored].sort(),
  };
}

/** One stable line per capability: the unit of the approval diff. */
export function capabilityLines(c: Capabilities): string[] {
  const out: string[] = [];
  for (const s of c.skills) out.push(`skill: ${s}`);
  for (const f of c.runs) out.push(`runs commands: ${f}`);
  // Everything that decides where the server connects and what it receives is in the line, so any change re-prompts:
  // transport, command, EVERY arg, url, env NAMES and header NAMES (never values).
  for (const s of c.mcp) out.push(`connects to MCP server: ${s.name} ${s.transport}${s.command ? ` command ${JSON.stringify(s.command)}` : ""}${s.args.length ? ` args ${JSON.stringify(s.args)}` : ""}${s.url ? ` url ${JSON.stringify(s.url)}` : ""}${s.env.length ? ` env ${s.env.join(",")}` : ""}${s.headers.length ? ` headers ${s.headers.join(",")}` : ""}`);
  if (c.service) out.push(`calls a service: ${c.service.service} via ${c.service.auth}${c.service.hosts.length ? ` hosts ${c.service.hosts.join(",")}` : ""} read ${c.service.read.join(",") || "-"} write ${c.service.write.join(",") || "-"}`);
  if (c.scope) out.push(`defines a scope: ${c.scope}`);
  if (c.verify) out.push(`verifier: ${c.verify}`);
  for (const n of c.env) out.push(`receives environment variable: ${n}`);
  for (const b of c.bins) out.push(`needs program: ${b}`);
  for (const i of c.ignored) out.push(`ignored (never run): ${i}`);
  return out;
}

export const capabilityKey = (c: Capabilities): string => createHash("sha256").update(JSON.stringify(capabilityLines(c))).digest("hex");

export function capabilityDelta(previous: Capabilities | null, next: Capabilities): { added: string[]; removed: string[] } {
  const before = new Set(previous ? capabilityLines(previous) : []); const after = new Set(capabilityLines(next));
  return { added: [...after].filter(l => !before.has(l)), removed: [...before].filter(l => !after.has(l)) };
}

/** Plain-language list for the install prompt. */
export function canDoLines(c: Capabilities): string[] {
  const out: string[] = [];
  if (c.runs.length) out.push(`runs commands through bash (${c.runs.length}): ${c.runs.slice(0, 8).join(", ")}${c.runs.length > 8 ? ", ..." : ""}`);
  for (const s of c.mcp) out.push(`connects to MCP server ${s.name}: ${s.url ?? [s.command, ...s.args].join(" ")}${s.env.length ? ` (env ${s.env.join(", ")})` : ""}${s.headers.length ? ` (headers ${s.headers.join(", ")})` : ""}`);
  if (c.service) out.push(`calls a service: ${c.service.service}${c.service.hosts.length ? ` (${c.service.hosts.join(", ")})` : ""}; read: ${c.service.read.join(", ") || "none"}; write: ${c.service.write.join(", ") || "none"}`);
  if (c.scope) out.push(`defines a scope (${c.scope})`);
  if (c.verify) out.push(`provides a verifier (${c.verify})`);
  if (c.env.length) out.push(`receives environment variables: ${c.env.join(", ")} (model provider keys are never passed unless listed here)`);
  if (c.skills.length) out.push(`adds skills (text instructions): ${c.skills.join(", ")}`);
  if (c.ignored.length) out.push(`ignored, never run: ${c.ignored.join(", ")}`);
  return out;
}

export const providerEnvNames = (c: Capabilities): string[] => c.env.filter(isProviderKeyName);
