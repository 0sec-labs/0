import { LineCounter, isMap, isPair, isScalar, isSeq, parseDocument, stringify, type Document } from "yaml";
import { z } from "zod";
import { SENTINEL_NOTIFY_CHANNELS, SENTINEL_NOTIFY_EVENTS, SENTINEL_PRESET_IDS, SENTINEL_ACCESS_LEVELS, SENTINEL_STATUSES, SENTINEL_MAX_FILE_BYTES } from "./sentinels.js";
import { MIN_GITHUB_POLL_MS, MIN_MINUTES_INTERVAL, SCHEDULE_FREQUENCIES, SentinelGithubPrConfigSchema, SentinelScheduleSchema } from "./sentinel-triggers.js";

/**
 * Agents as code: one Markdown file per Agent. The YAML frontmatter holds the portable fields; the Markdown body is
 * the charter (the Agent's AGENTS.md). Instance-local state (ids, runs, memory contents, connections, uploaded
 * avatars, secrets) never belongs in a file. This module is the single source of truth: the parser, the serializer
 * and the published JSON Schema all derive from {@link AgentFileSchema}.
 */
export const AGENT_FILE_API_VERSION = "0security/v1";
export const AGENT_FILE_MAX_BYTES = 131_072;
export const AGENT_FILE_MAX_FRONTMATTER_BYTES = 32_768;
export const AGENT_FILE_MAX_FILES = 200;
export const AGENT_FILE_SCHEMA_URL = "https://docs.0security.com/schemas/agent.v1.json";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use lowercase letters, digits and dashes (at most 63 characters).").describe("Stable identity of this Agent across applies. Renaming the Agent does not change it; changing it creates a different Agent.");
const text = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number) => z.array(text(4096)).max(max).refine(values => new Set(values).size === values.length, "Entries must be unique.");
/** Automation template ids a trigger may name. Kept here so this module stays free of Node-only imports (the browser bundle loads it); a test pins it to the template registry. */
export const AGENT_FILE_TEMPLATE_IDS = ["repository-review","dependency-review","api-security","web-configuration","scoped-penetration-test","package-behavior","contract-review","native-code-review","secrets-config-review","finding-verification","fix-candidate","security-research","deep-source-review"] as unknown as readonly [string, ...string[]];
const TEMPLATE_IDS = AGENT_FILE_TEMPLATE_IDS as [string, ...string[]];
const FILE_TRIGGER_KINDS = ["schedule", "manual", "github-pr"] as const;

const triggerBase = { id: slug.optional().describe("Name of this trigger within the file; defaults to its kind and position."), template: z.enum(TEMPLATE_IDS).optional().describe("Automation template the trigger starts; defaults to the preset's suggestion or repository-review."), enabled: z.boolean().default(true).describe("Only takes effect while the Agent is active.") };
const scheduleTrigger = z.strictObject({
  on: z.literal("schedule"), ...triggerBase,
  frequency: z.enum(SCHEDULE_FREQUENCIES), every: z.number().int().min(MIN_MINUTES_INTERVAL).max(1440).optional(),
  time: z.string().optional().describe("HH:MM, 24-hour."), weekday: z.number().int().min(0).max(6).optional().describe("0 is Sunday."),
  cron: z.string().max(120).optional(), timezone: z.string().default("UTC").describe("IANA timezone."),
});
const githubTrigger = z.strictObject({
  on: z.literal("github-pr"), ...triggerBase,
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "Use owner/name."), baseBranch: text(200).optional(),
  pollMs: z.number().int().min(MIN_GITHUB_POLL_MS).max(3_600_000).default(120_000), commentOnPr: z.boolean().default(false),
  includeForks: z.boolean().default(false).describe("Also review pull requests from forks, read-only and marked untrusted."),
});
const manualTrigger = z.strictObject({ on: z.literal("manual"), ...triggerBase });
const triggerSchema = z.discriminatedUnion("on", [scheduleTrigger, githubTrigger, manualTrigger]).superRefine((trigger, context) => {
  if (trigger.on === "schedule") {
    const { on: _on, id: _id, template: _template, enabled: _enabled, ...schedule } = trigger;
    const parsed = SentinelScheduleSchema.safeParse(schedule);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
  if (trigger.on === "github-pr") {
    const { on: _on, id: _id, template: _template, enabled: _enabled, ...github } = trigger;
    const parsed = SentinelGithubPrConfigSchema.safeParse(github);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
});

export const AgentFileSchema = z.strictObject({
  apiVersion: z.literal(AGENT_FILE_API_VERSION).describe("Schema version of this file."),
  kind: z.literal("Agent").default("Agent"),
  id: slug,
  name: text(80),
  description: z.string().trim().max(160).default("").describe("One-line job of the Agent."),
  preset: z.enum(SENTINEL_PRESET_IDS).optional().describe("Built-in preset this Agent started from."),
  access: z.enum(SENTINEL_ACCESS_LEVELS).default("read-only").describe("read-only, or changes (Can make changes). Applying a file that asks for changes needs the operator to allow it."),
  web: z.boolean().default(false).describe("A Read-only Agent may browse the web."),
  status: z.enum(SENTINEL_STATUSES.filter(status => status !== "archived") as ["active", "paused"]).default("paused").describe("Agents from files start paused unless the file says active."),
  skills: z.array(z.string().min(1).max(384).regex(/^[A-Za-z0-9_.:/-]+$/)).max(64).refine(values => new Set(values).size === values.length, "Skills must be unique.").default([]),
  instructions: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._/-]{0,198}\.md$/, "Use a relative .md path without '..'.").optional().describe("Charter file next to this file, instead of the Markdown body."),
  scope: z.strictObject({ repos: list(100).default([]), targets: list(200).default([]), domains: list(200).default([]), outOfScope: list(500).default([]) }).default({ repos: [], targets: [], domains: [], outOfScope: [] }),
  budget: z.strictObject({ dailyUsd: z.number().finite().positive().max(10_000).default(10), maxRunsPerDay: z.number().int().positive().max(1000).default(20) }).default({ dailyUsd: 10, maxRunsPerDay: 20 }),
  memory: z.union([z.boolean(), z.strictObject({ enabled: z.boolean().default(true), autoLearn: z.boolean().default(false) })]).default(true),
  model: z.strictObject({ provider: text(128), model: text(256), reasoning: text(32).optional() }).optional().describe("A hint. Used only when this Computer has that provider connected."),
  notifications: z.strictObject({ channels: z.array(z.enum(SENTINEL_NOTIFY_CHANNELS)).max(3).default(["in-app"]), on: z.array(z.enum(SENTINEL_NOTIFY_EVENTS)).max(4).default(["finding-high", "needs-you", "run-failed"]), quiet: z.boolean().default(false) }).optional(),
  avatar: z.strictObject({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), icon: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).optional() }).optional(),
  triggers: z.array(triggerSchema).max(20).default([]),
}).superRefine((file, context) => {
  const seen = new Set<string>();
  file.triggers.forEach((trigger, index) => {
    const key = triggerKey(trigger, index);
    if (seen.has(key)) context.addIssue({ code: "custom", message: `Duplicate trigger id "${key}".`, path: ["triggers", index, "id"] });
    seen.add(key);
  });
  if (file.access === "changes" && file.web) context.addIssue({ code: "custom", message: "web applies to Read-only Agents; Can make changes already includes it.", path: ["web"] });
});
export type AgentFile = z.output<typeof AgentFileSchema>;
export type AgentFileTrigger = AgentFile["triggers"][number];
export const triggerKey = (trigger: { id?: string | undefined; on: string }, index: number): string => trigger.id ?? `${trigger.on}-${index + 1}`;

export interface AgentFileIssue { message: string; line?: number; path: string }
export type ParsedAgentFile =
  | { ok: true; file: AgentFile; charter: string; warnings: AgentFileIssue[] }
  | { ok: false; errors: AgentFileIssue[] };

const KEY_LOOKS_SECRET = /(?:^|[-_.])(?:api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|authorization|bearer|cookie)s?(?:$|[-_.])/i;
const TOKEN_VALUE = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const SECRET_HINT = "Files never hold secrets. Add the credential as a connection in the app and refer to nothing here.";
const KEY_HINTS: Record<string, string> = { production: "Production targets can only be turned on in the app, never from a file.", autonomy: "Use access: read-only or access: changes.", toolAccess: "Use access, and web: true for a Read-only Agent that may browse.", mission: "Use description.", automationIds: "Use triggers; each trigger creates and owns its automation.", hostId: "Where an Agent runs is chosen on each Computer, not in the file." };

const CORE_TAGS: ReadonlySet<string> = new Set(["tag:yaml.org,2002:str", "tag:yaml.org,2002:int", "tag:yaml.org,2002:float", "tag:yaml.org,2002:bool", "tag:yaml.org,2002:null", "tag:yaml.org,2002:seq", "tag:yaml.org,2002:map"]);
/** The text a hash is taken over: no BOM, LF line endings. */
export const normalizeAgentFileText = (content: string): string => content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

/** Splits `---` frontmatter from the body. Returns undefined when the file has no frontmatter block. */
function split(source: string): { front: string; body: string } | undefined {
  if (!source.startsWith("---\n")) return undefined;
  const rest = source.slice(4);
  const match = /^---[ \t]*(?:\n|$)/m.exec(rest);
  if (!match) return undefined;
  return { front: rest.slice(0, match.index), body: rest.slice(match.index + match[0].length) };
}

function nodeLine(document: Document.Parsed, counter: LineCounter, path: ReadonlyArray<string | number>, asKey: boolean): number | undefined {
  let node: unknown = document.contents;
  let keyNode: unknown;
  for (const step of path) {
    if (isMap(node)) { const pair = node.items.find(item => isPair(item) && isScalar(item.key) && String(item.key.value) === String(step)); if (!pair) break; keyNode = pair.key; node = pair.value; }
    else if (isSeq(node)) { const item = node.items[Number(step)]; if (item === undefined) break; keyNode = undefined; node = item; }
    else break;
  }
  const target = asKey && keyNode ? keyNode : node;
  const offset = target && typeof target === "object" && "range" in target && Array.isArray((target as { range: unknown }).range) ? (target as { range: number[] }).range[0] : undefined;
  return offset === undefined ? undefined : counter.linePos(offset).line;
}

function scanKeys(value: unknown, path: Array<string | number>, found: Array<Array<string | number>>): void {
  if (Array.isArray(value)) value.forEach((item, index) => scanKeys(item, [...path, index], found));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { if (KEY_LOOKS_SECRET.test(key)) found.push([...path, key]); scanKeys(child, [...path, key], found); }
}

/**
 * Strict parser: YAML 1.2 core schema only (no custom tags, anchors, aliases or merge keys), unique keys, unknown keys
 * are errors with line numbers, size limits, no secrets. `line` is 1-based within the file.
 */
export function parseAgentFile(source: string): ParsedAgentFile {
  const errors: AgentFileIssue[] = [];
  if (typeof source !== "string") return { ok: false, errors: [{ message: "The file is not text.", path: "" }] };
  if (new TextEncoder().encode(source).byteLength > AGENT_FILE_MAX_BYTES) return { ok: false, errors: [{ message: `The file is larger than ${AGENT_FILE_MAX_BYTES / 1024} KiB.`, path: "" }] };
  if (source.includes("\0")) return { ok: false, errors: [{ message: "The file contains a NUL byte.", path: "" }] };
  const normalized = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const parts = split(normalized);
  if (!parts) return { ok: false, errors: [{ message: "Start the file with a '---' frontmatter block and close it with another '---' line.", line: 1, path: "" }] };
  if (new TextEncoder().encode(parts.front).byteLength > AGENT_FILE_MAX_FRONTMATTER_BYTES) return { ok: false, errors: [{ message: "The frontmatter is larger than 32 KiB.", line: 1, path: "" }] };

  const counter = new LineCounter();
  const document = parseDocument(parts.front, { schema: "core", uniqueKeys: true, merge: false, lineCounter: counter, strict: true, version: "1.2" });
  const at = (line: number | undefined): number | undefined => (line === undefined ? undefined : line + 1);
  for (const error of document.errors) errors.push({ message: error.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, ""), line: at(error.linePos?.[0].line) ?? 2, path: "" });
  for (const warning of document.warnings) errors.push({ message: warning.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, ""), line: at(warning.linePos?.[0].line) ?? 2, path: "" });
  if (errors.length) return { ok: false, errors };
  let anchored = false;
  const scan = (node: unknown): void => { if (!node || typeof node !== "object") return; const n = node as { anchor?: string; tag?: string; items?: unknown[]; key?: unknown; value?: unknown; source?: string }; if (n.anchor || (n.tag && !CORE_TAGS.has(n.tag))) anchored = true; if (n.constructor?.name === "Alias") anchored = true; n.items?.forEach(scan); if ("key" in n) { scan(n.key); scan(n.value); } };
  scan(document.contents);
  if (anchored) return { ok: false, errors: [{ message: "Anchors, aliases and custom tags are not allowed.", line: 2, path: "" }] };

  const data = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, errors: [{ message: "The frontmatter must be a mapping of keys to values.", line: 2, path: "" }] };

  const secretKeys: Array<Array<string | number>> = [];
  scanKeys(data, [], secretKeys);
  for (const path of secretKeys) errors.push({ message: `"${String(path[path.length - 1])}" looks like a secret. ${SECRET_HINT}`, line: at(nodeLine(document, counter, path, true)), path: path.join(".") });
  if (TOKEN_VALUE.test(parts.front) || TOKEN_VALUE.test(parts.body)) errors.push({ message: `The file contains something that looks like a credential. ${SECRET_HINT}`, path: "" });
  if (errors.length) return { ok: false, errors };

  const result = AgentFileSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) errors.push({ message: `Unknown key "${key}".${KEY_HINTS[key] ? ` ${KEY_HINTS[key]}` : ""}`, line: at(nodeLine(document, counter, [...issue.path as Array<string | number>, key], true)), path: [...issue.path, key].join(".") });
      } else {
        const path = issue.path as Array<string | number>;
        errors.push({ message: `${path.length ? `${path.join(".")}: ` : ""}${issue.message}`, line: at(nodeLine(document, counter, path, false)) ?? 2, path: path.join(".") });
      }
    }
    return { ok: false, errors };
  }
  const file = result.data;
  const charter = parts.body.replace(/^\n+/, "");
  if (file.instructions !== undefined && charter.trim()) return { ok: false, errors: [{ message: "Use either 'instructions' or a Markdown body, not both.", line: at(nodeLine(document, counter, ["instructions"], true)), path: "instructions" }] };
  if (new TextEncoder().encode(charter).byteLength > SENTINEL_MAX_FILE_BYTES) return { ok: false, errors: [{ message: "The charter is larger than 64 KiB.", path: "" }] };
  const warnings: AgentFileIssue[] = [];
  if (file.instructions === undefined && !charter.trim()) warnings.push({ message: "The charter (Markdown body) is empty; the Agent will use the default charter.", path: "" });
  return { ok: true, file, charter, warnings };
}

/** Writes an Agent file. Round-trips through {@link parseAgentFile}. */
export function serializeAgentFile(file: Record<string, unknown>, charter: string): string {
  const front = stringify({ ...file }, { lineWidth: 0, indent: 2, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }).replace(/\n+$/, "");
  const header = `# yaml-language-server: $schema=${AGENT_FILE_SCHEMA_URL}\n`;
  return `---\n${header}${front}\n---\n\n${charter.replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
}

/** JSON Schema (draft 2020-12) for editor support, generated from {@link AgentFileSchema}. */
export function agentFileJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AgentFileSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  return { ...schema, $id: AGENT_FILE_SCHEMA_URL, title: "0security Agent file", description: "Frontmatter of an Agent file (Markdown). The Markdown body is the Agent's charter." };
}

/** The Sentinel create/patch body for a file. Access maps to the stored values: read-only -> observe, changes -> act. */
export function agentFileToSentinelFields(file: AgentFile): Record<string, unknown> {
  const memory = typeof file.memory === "boolean" ? { enabled: file.memory, autoLearn: false } : file.memory;
  return {
    name: file.name, mission: file.description, role: file.preset ?? "custom", skills: file.skills,
    scope: { ...file.scope, production: false },
    access: file.access, ...(file.access === "read-only" ? { toolAccess: file.web ? "read-web" : "read-only" } : {}),
    budget: file.budget, memory,
    model: file.model ? { providerId: file.model.provider, model: file.model.model, ...(file.model.reasoning ? { reasoning: file.model.reasoning } : {}) } : null,
    notifications: file.notifications ?? { channels: ["in-app"], on: ["finding-high", "needs-you", "run-failed"], quiet: false },
    avatar: file.avatar ?? { color: "#4f6bed" },
    status: file.status,
  };
}
