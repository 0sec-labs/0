import { z } from "zod";

/**
 * Sentinels: named, always-on security agents that sit alongside Automations (workflows).
 * Records are default-inert: created paused, production off, with
 * a finite daily budget. Instructions and memory live in virtual files (AGENTS.md, NOTES.md, ...).
 * Triggers belong to Automations (`ownerSentinelId` / `runIn` on the workflow), not here.
 */
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Reserved identifier.");
const skillId = z.string().min(1).max(384).regex(/^[A-Za-z0-9_.:/-]+$/).refine(value => !value.split("/").some(part => part === "." || part === ".."), "Invalid skill ID.");
const listOf = (item: z.ZodString, max: number) => z.array(item.trim().min(1).max(4096)).max(max).refine(values => new Set(values).size === values.length, "Entries must be unique.");

export const SENTINEL_STATUSES = ["active", "paused", "archived"] as const;
export type SentinelStatus = (typeof SENTINEL_STATUSES)[number];
export const SENTINEL_AUTONOMY = ["observe", "propose", "act", "run"] as const;
/**
 * Stored values, kept for compatibility. New Agents store only observe (Read-only) or act (Can make changes).
 * propose (every effectful action waits for approval) and run (runs commands, blocks mutating web requests) are
 * only read, for Agents saved before. Users see two choices (see {@link sentinelAccessLevel}).
 */
export type SentinelAutonomy = (typeof SENTINEL_AUTONOMY)[number];

/** What an Agent can do, in the words users see: two choices. Derived from the stored autonomy; nothing else is stored. */
export const SENTINEL_ACCESS_LEVELS = ["read-only", "changes"] as const;
export type SentinelAccessLevel = (typeof SENTINEL_ACCESS_LEVELS)[number];
/** Older spellings of "changes", accepted as input only. */
const ACCESS_LEVEL_ALIASES: Record<string, SentinelAccessLevel> = { commands: "changes", "pull-requests": "changes" };
/** Accepts a current or older access value and returns the current one, or undefined. */
export function normalizeSentinelAccessLevel(value: unknown): SentinelAccessLevel | undefined {
  return (SENTINEL_ACCESS_LEVELS as readonly unknown[]).includes(value) ? (value as SentinelAccessLevel) : typeof value === "string" ? ACCESS_LEVEL_ALIASES[value] : undefined;
}
/** observe -> read-only; every other stored value (propose, run, act) -> changes. */
export function sentinelAccessLevel(autonomy: SentinelAutonomy): SentinelAccessLevel {
  return autonomy === "observe" ? "read-only" : "changes";
}
type AccessFieldsCurrent = { autonomy: SentinelAutonomy; toolAccess: (typeof SENTINEL_TOOL_ACCESS)[number] };
/**
 * The stored fields for an access level. New writes store only observe or act; whether an Agent asks first is the
 * global "Ask before running commands" setting, not stored here. An Agent already saved as propose or run is read as
 * Can make changes and becomes act when it is saved, with its web access (toolAccess) unchanged.
 */
export function sentinelAccessFields(level: SentinelAccessLevel, current?: AccessFieldsCurrent): AccessFieldsCurrent {
  if (level === "read-only") return current?.autonomy === "observe" ? current : { autonomy: "observe", toolAccess: "read-only" };
  return { autonomy: "act", toolAccess: current && current.autonomy !== "observe" ? current.toolAccess : "exec" };
}
/** The value written for a stored autonomy: new writes only ever store observe or act. Older propose and run are read, never written. */
export function sentinelWrittenAutonomy(autonomy: SentinelAutonomy): "observe" | "act" {
  return autonomy === "observe" ? "observe" : "act";
}
/**
 * `access` (canonical) and `accessLevel` (older name) are input aliases for autonomy and toolAccess; an explicit
 * autonomy wins. Any save that names access, autonomy or toolAccess is normalised so only observe or act is written.
 */
function resolveAccessAlias<T extends Record<string, unknown>>(value: T, current?: AccessFieldsCurrent): Omit<T, "accessLevel" | "access"> {
  const hasAlias = "accessLevel" in value || "access" in value;
  if (!hasAlias && !("autonomy" in value)) return value as Omit<T, "accessLevel" | "access">;
  const { accessLevel, access, ...rest } = value as Record<string, unknown>;
  let fields: Partial<AccessFieldsCurrent> = {};
  if (hasAlias) {
    const level = normalizeSentinelAccessLevel(access ?? accessLevel);
    if (!level) throw new Error("access must be read-only or changes.");
    fields = sentinelAccessFields(level, current);
  }
  const merged = { ...fields, ...rest } as Record<string, unknown>;
  if (typeof merged["autonomy"] === "string" && (SENTINEL_AUTONOMY as readonly string[]).includes(merged["autonomy"])) merged["autonomy"] = sentinelWrittenAutonomy(merged["autonomy"] as SentinelAutonomy);
  return merged as Omit<T, "accessLevel" | "access">;
}

export const SENTINEL_TOOL_ACCESS = ["read-only", "read-web", "exec"] as const;
export const SENTINEL_NOTIFY_EVENTS = ["finding-high", "needs-you", "run-failed", "fix-ready"] as const;
export const SENTINEL_NOTIFY_CHANNELS = ["in-app", "github", "slack"] as const;
/** Built-in preset ids; "custom" is a blank Sentinel. Role ids are open strings so imported presets stay valid. */
export const SENTINEL_PRESET_IDS = ["pen-tester", "pr-security-reviewer", "dependency-watcher", "fix-engineer", "secrets-hunter", "attack-surface-monitor", "cloud-posture-auditor", "incident-triage", "regression-tester", "release-gate"] as const;
export const SENTINEL_CUSTOM_ROLE = "custom";

export const SENTINEL_FILE_DEFAULTS = ["AGENTS.md", "NOTES.md"] as const;
export const SENTINEL_FILE_FOLDERS = ["handoffs/", "reports/"] as const;
export const SENTINEL_MAX_FILES = 64;
export const SENTINEL_MAX_FILE_BYTES = 65_536;
export const SENTINEL_MAX_SENTINELS = 200;

export const SentinelFilePathSchema = z.string().min(1).max(200).superRefine((path, context) => {
  const parts = path.split("/");
  const bad = path.startsWith("/") || path.includes("\\") || parts.length > 4
    || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) || part === "." || part === ".." || ["__proto__", "constructor", "prototype"].includes(part))
    || !/\.(md|txt|json)$/i.test(path);
  if (bad) context.addIssue({ code: "custom", message: "Use a relative .md, .txt or .json path of at most four safe segments." });
});

const avatarSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Icon id (a key into the web icon map). */
  icon: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).optional(),
  /** Legacy: older Sentinels stored an emoji. Never rendered; readers fall back to the icon or initials. */
  emoji: z.string().trim().min(1).max(16).optional(),
  initials: z.string().trim().min(1).max(3).optional(),
}).strict();
const scopeSchema = z.object({
  repos: listOf(z.string(), 100).default([]),
  targets: listOf(z.string(), 200).default([]),
  domains: listOf(z.string(), 200).default([]),
  outOfScope: listOf(z.string(), 500).default([]),
  /** Production targets are off unless an operator explicitly turns this on. */
  production: z.boolean().default(false),
}).strict();
/** One daily USD cap plus a run-count cap. Older records also stored per-run and time caps; see normalizeSentinelBudget. */
const budgetSchema = z.object({
  dailyUsd: z.number().finite().positive().max(10_000).default(10),
  maxRunsPerDay: z.number().int().positive().max(1000).default(20),
}).strict();
/** Reduces a stored budget of any earlier shape (per-run and time caps) to the current one; never throws. */
export function normalizeSentinelBudget(value: unknown): { dailyUsd: number; maxRunsPerDay: number } {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const parsed = budgetSchema.safeParse({
    ...(typeof source.dailyUsd === "number" ? { dailyUsd: source.dailyUsd } : {}),
    ...(typeof source.maxRunsPerDay === "number" ? { maxRunsPerDay: source.maxRunsPerDay } : {}),
  });
  return parsed.success ? parsed.data : budgetSchema.parse({});
}
const modelSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  reasoning: z.string().trim().min(1).max(32).optional(),
}).strict();
const notificationsSchema = z.object({
  channels: z.array(z.enum(SENTINEL_NOTIFY_CHANNELS)).max(3).default(["in-app"]),
  on: z.array(z.enum(SENTINEL_NOTIFY_EVENTS)).max(4).default(["finding-high", "needs-you", "run-failed"]),
  quiet: z.boolean().default(false),
}).strict();
const memorySchema = z.object({
  enabled: z.boolean().default(true),
  /** Learning events from runs become reviewable notes only after approval. */
  autoLearn: z.boolean().default(false),
}).strict();

const base = {
  name: z.string().trim().min(1).max(80),
  mission: z.string().trim().max(160).default(""),
  avatar: avatarSchema.default({ color: "#4f6bed" }),
  role: identifier.default(SENTINEL_CUSTOM_ROLE),
  skills: z.array(skillId).max(64).refine(values => new Set(values).size === values.length, "Skills must be unique.").default([]),
  scope: scopeSchema.prefault({}),
  autonomy: z.enum(SENTINEL_AUTONOMY).default("observe"),
  toolAccess: z.enum(SENTINEL_TOOL_ACCESS).default("read-only"),
  hostId: z.string().trim().min(1).max(256).nullable().default(null),
  model: modelSchema.nullable().default(null),
  budget: budgetSchema.prefault({}),
  notifications: notificationsSchema.prefault({}),
  memory: memorySchema.prefault({}),
  status: z.enum(SENTINEL_STATUSES).default("paused"),
  /** Automations (workflow definition ids) this Sentinel owns; they share its budget cap and memory. */
  automationIds: z.array(identifier).max(50).refine(values => new Set(values).size === values.length).default([]),
};
/** Full editable body. Strict: unknown keys are rejected rather than silently dropped. */
export const SentinelInputSchema = z.strictObject(base);
/** Create request: the minimal inputs plus an optional seed for AGENTS.md. */
export const SentinelCreateSchema = z.strictObject({ ...base, instructions: z.string().max(SENTINEL_MAX_FILE_BYTES).optional() });
/**
 * Patch envelope only: unknown keys are rejected and `version` is required. Field values are validated by
 * applySentinelPatch against the merged record, so omitted fields keep their stored value (an `.optional()` over a
 * defaulted field would silently reset it to the default).
 */
export const SentinelPatchSchema = z.object({ version: z.number().int().positive() }).catchall(z.unknown()).superRefine((patch, context) => {
  for (const key of Object.keys(patch)) if (key !== "version" && key !== "accessLevel" && key !== "access" && !(key in base)) context.addIssue({ code: "custom", message: `Unknown field "${key}".`, path: [key] });
});

export type SentinelInput = z.output<typeof SentinelInputSchema>;
export interface Sentinel extends SentinelInput {
  id: string;
  /** Standing mission (chat/session) created on first run or at creation; activations are child missions. */
  homeMissionId: string | null;
  /** Fingerprint of the authority-bearing fields (scope, model, skills, autonomy, tools) the operator last acknowledged. */
  reviewedFingerprint?: string;
  /** Why the runner paused this Sentinel (budget breach); cleared by resume. Surfaces as "needs you". */
  pauseReason?: SentinelPauseReason;
  owner: string;
  /** Set when an Agent file defines this Agent (agents as code). Never writable through the API; see SentinelStore.setManagedBy. */
  managedBy?: SentinelManagedBy;
  version: number;
  createdAt: string;
  updatedAt: string;
}
/** Marker of a file-managed Agent: the file's stable id, the file path (relative to the applied root), the applied root and the content hash of the last applied file. */
export interface SentinelManagedBy {
  id: string; path: string; root: string; hash: string; appliedAt: string;
  /** Digest of the Agent's portable state right after the last apply; a different digest later means it was edited in the app. */
  stateHash?: string;
  /** File trigger id -> the trigger it owns; `created` is true when apply made the automation (so apply may also remove it). */
  triggers?: Record<string, { trigger: string; created: boolean }>;
}
export type SentinelCreateInput = z.output<typeof SentinelCreateSchema>;

export interface SentinelPauseReason { kind: "budget"; message: string; at: string }

/**
 * Stable digest of what a scheduled run is allowed to do. Any change (scope, model, tools, autonomy, skills,
 * production flag) makes the Sentinel "needs review" until an operator acknowledges it.
 */
export function sentinelReviewFingerprint(sentinel: Pick<Sentinel, "scope" | "model" | "toolAccess" | "autonomy" | "skills" | "hostId">): string {
  const sorted = (items: string[]) => [...items].sort();
  return JSON.stringify({
    scope: { repos: sorted(sentinel.scope.repos), targets: sorted(sentinel.scope.targets), domains: sorted(sentinel.scope.domains), outOfScope: sorted(sentinel.scope.outOfScope), production: sentinel.scope.production },
    model: sentinel.model ? { p: sentinel.model.providerId, m: sentinel.model.model, r: sentinel.model.reasoning ?? null } : null,
    toolAccess: sentinel.toolAccess, autonomy: sentinel.autonomy, skills: sorted(sentinel.skills), hostId: sentinel.hostId,
  });
}
export const sentinelNeedsReview = (sentinel: Sentinel): boolean => sentinel.reviewedFingerprint !== sentinelReviewFingerprint(sentinel);

export interface SentinelAttention {
  needsYou: boolean;
  /** Review gate: scope/model/tools changed since the last acknowledgement; autonomous runs are blocked. */
  needsReview: boolean;
  /** Set when the runner paused the Sentinel (for example a budget breach). */
  reason?: string;
  /** Derived from the home mission's pending approvals and unanswered questions. */
  pendingDecisions: number;
}

export function parseSentinelCreate(value: unknown): SentinelCreateInput {
  return SentinelCreateSchema.parse(typeof value === "object" && value !== null && !Array.isArray(value) ? resolveAccessAlias(value as Record<string, unknown>) : value);
}
/** Patches replace whole top-level fields (nested objects included); fields not named stay as they are. */
export function applySentinelPatch(current: Sentinel, patch: Record<string, unknown>): SentinelInput {
  const { version: _version, ...rawFields } = patch;
  const { id: _id, homeMissionId: _home, reviewedFingerprint: _fp, pauseReason: _pause, managedBy: _managed, owner: _owner, version: _v, createdAt: _c, updatedAt: _u, ...editable } = current;
  const fields = resolveAccessAlias(rawFields, editable);
  return SentinelInputSchema.parse({ ...editable, ...fields });
}
export function parseSentinelPatch(value: unknown): Record<string, unknown> & { version: number } {
  return SentinelPatchSchema.parse(value) as Record<string, unknown> & { version: number };
}

export type SentinelActivationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
export interface SentinelActivation {
  id: string;
  sentinelId: string;
  sentinelVersion: number;
  trigger: { kind: "manual" | "automation" | "schedule" | "github-pr"; automationId?: string; triggerId?: string; /** Event context (for example PR number and head SHA). */ event?: Record<string, string | number> };
  status: SentinelActivationStatus;
  /** Mission (chat/session) for this activation; a child of the Sentinel's home mission. */
  missionId?: string;
  parentMissionId?: string;
  automationId?: string;
  executionId?: string;
  /** Per-run skill allow-list snapshot; also enforced as a hard filter on the mission (list_skills/load_skill). */
  skills: string[];
  /** Engine process that owns the live run; used to close out runs a stopped engine left behind. */
  ownerPid?: number;
  costUsd?: number;
  /** Why a run was skipped, failed or stopped (budget, review gate, ...). */
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type SentinelFileAuthorKind = "human" | "agent";
export interface SentinelFile { sentinelId: string; path: string; revision: number; content: string; authorKind: SentinelFileAuthorKind; author: string; updatedAt: string }
export interface SentinelFileRevision { sentinelId: string; path: string; revision: number; content: string; digest: string; authorKind: SentinelFileAuthorKind; author: string; createdAt: string }
