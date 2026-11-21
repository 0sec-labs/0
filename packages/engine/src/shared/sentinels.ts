import { z } from "zod";

/**
 * Sentinels: named, always-on security agents that sit alongside Automations (workflows).
 * Records are default-inert: created paused.
 * Instructions and memory live in virtual files (AGENTS.md, NOTES.md, ...).
 * Triggers belong to Automations (`ownerSentinelId` / `runIn` on the workflow), not here.
 */
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Reserved identifier.");
const skillId = z.string().min(1).max(384).regex(/^[A-Za-z0-9_.:/-]+$/).refine(value => !value.split("/").some(part => part === "." || part === ".."), "Invalid skill ID.");

export const SENTINEL_STATUSES = ["active", "paused", "archived"] as const;
export type SentinelStatus = (typeof SENTINEL_STATUSES)[number];
/**
 * There is one mode: a Sentinel has shell access, limited by the sandbox. Older records stored
 * `autonomy` (observe, propose, act, run) and `toolAccess` (read-only, read-web, exec); they still load, the fields are
 * dropped on read, and input that still names them (or `access` / `accessLevel`) is accepted and ignored.
 * `budget` and `pauseReason` belong to the removed daily caps, and `scope` to the removed scope; they are dropped the same way.
 */
const IGNORED_ACCESS_KEYS = ["autonomy", "toolAccess", "access", "accessLevel", "budget", "pauseReason", "scope", "memory"] as const;
/** Removes the retired access fields from stored or submitted data; never throws. */
export function dropAccessFields<T extends Record<string, unknown>>(value: T): Omit<T, (typeof IGNORED_ACCESS_KEYS)[number]> {
  const copy: Record<string, unknown> = { ...value };
  for (const key of IGNORED_ACCESS_KEYS) delete copy[key];
  return copy as Omit<T, (typeof IGNORED_ACCESS_KEYS)[number]>;
}
const stripAccess = (value: unknown): unknown => typeof value === "object" && value !== null && !Array.isArray(value) ? dropAccessFields(value as Record<string, unknown>) : value;

export const SENTINEL_NOTIFY_EVENTS = ["finding-high", "needs-you", "run-failed", "fix-ready"] as const;
export const SENTINEL_NOTIFY_CHANNELS = ["in-app", "github", "slack"] as const;
/** Built-in preset ids; "custom" is a blank Sentinel. Role ids are open strings so imported presets stay valid. */
export const SENTINEL_PRESET_IDS = ["pr-security-reviewer", "dependency-watcher", "fix-engineer", "secrets-hunter", "incident-triage", "release-gate"] as const;
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
const base = {
  name: z.string().trim().min(1).max(80),
  mission: z.string().trim().max(160).default(""),
  avatar: avatarSchema.default({ color: "#4f6bed" }),
  role: identifier.default(SENTINEL_CUSTOM_ROLE),
  skills: z.array(skillId).max(64).refine(values => new Set(values).size === values.length, "Skills must be unique.").default([]),
  /** The working directory its threads run in. */
  folder: z.string().trim().min(1).max(4096).nullable().default(null),
  hostId: z.string().trim().min(1).max(256).nullable().default(null),
  model: modelSchema.nullable().default(null),
  notifications: notificationsSchema.prefault({}),
  status: z.enum(SENTINEL_STATUSES).default("paused"),
  /** Automations (workflow definition ids) this Sentinel owns; they share its notes files. */
  automationIds: z.array(identifier).max(50).refine(values => new Set(values).size === values.length).default([]),
};
/** Full editable body. Strict: unknown keys are rejected rather than silently dropped. */
const SentinelInputBody = z.strictObject(base);
export const SentinelInputSchema = z.preprocess(stripAccess, SentinelInputBody) as unknown as typeof SentinelInputBody;
/** Create request: the minimal inputs plus an optional seed for AGENTS.md. */
const SentinelCreateBody = z.strictObject({ ...base, instructions: z.string().max(SENTINEL_MAX_FILE_BYTES).optional() });
export const SentinelCreateSchema = z.preprocess(stripAccess, SentinelCreateBody) as unknown as typeof SentinelCreateBody;
/**
 * Patch envelope only: unknown keys are rejected and `version` is required. Field values are validated by
 * applySentinelPatch against the merged record, so omitted fields keep their stored value (an `.optional()` over a
 * defaulted field would silently reset it to the default).
 */
export const SentinelPatchSchema = z.object({ version: z.number().int().positive() }).catchall(z.unknown()).superRefine((patch, context) => {
  for (const key of Object.keys(patch)) if (key !== "version" && !(IGNORED_ACCESS_KEYS as readonly string[]).includes(key) && !(key in base)) context.addIssue({ code: "custom", message: `Unknown field "${key}".`, path: [key] });
});

export type SentinelInput = z.output<typeof SentinelInputSchema>;
export interface Sentinel extends SentinelInput {
  id: string;
  /** Standing mission (chat/session) created on first run or at creation; activations are child missions. */
  homeMissionId: string | null;
  /** Review fingerprint (model, skills, folder) the standing thread was configured with. The gateway pins those at creation, so a changed fingerprint means a fresh thread. Absent on threads made before it was recorded. */
  homeFingerprint?: string;
  /** Fingerprint of the authority-bearing fields (model, skills) the operator last acknowledged. */
  reviewedFingerprint?: string;
  owner: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export type SentinelCreateInput = z.output<typeof SentinelCreateSchema>;

/**
 * Stable digest of what a scheduled run is allowed to do. Any change (model, skills) makes the
 * Sentinel "needs review" until an operator acknowledges it. The retired access fields stay in the digest as the constant
 * they now mean, so Sentinels already reviewed with shell access keep their acknowledgement, while a Sentinel that was
 * read-only needs one review because its authority widened.
 */
export function sentinelReviewFingerprint(sentinel: Pick<Sentinel, "model" | "skills" | "hostId" | "folder">): string {
  const sorted = (items: string[]) => [...items].sort();
  return JSON.stringify({
    model: sentinel.model ? { p: sentinel.model.providerId, m: sentinel.model.model, r: sentinel.model.reasoning ?? null } : null,
    toolAccess: "exec", autonomy: "act", skills: sorted(sentinel.skills), hostId: sentinel.hostId,
    ...(sentinel.folder ? { folder: sentinel.folder } : {}),
  });
}
/** A stored Sentinel's folder was kept as the first absolute path in `scope.repos`; read it from there when no folder is recorded. */
export function folderFromRetiredScope(stored: { folder?: unknown; scope?: unknown }): string | null {
  if (typeof stored.folder === "string" && stored.folder) return stored.folder;
  const repos = (stored.scope as { repos?: unknown } | undefined)?.repos;
  return Array.isArray(repos) ? repos.find((repo): repo is string => typeof repo === "string" && repo.startsWith("/")) ?? null : null;
}
/** A fingerprint stored before scope was removed carries a `scope` entry; read it as the fingerprint of the same Sentinel without it, so earlier reviews still hold. */
export function dropScopeFromFingerprint(fingerprint: string): string {
  try {
    const parsed = JSON.parse(fingerprint) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && "scope" in parsed) {
      const folder = folderFromRetiredScope({ scope: parsed["scope"] });
      delete parsed["scope"];
      if (folder) parsed["folder"] = folder;
      return JSON.stringify(parsed);
    }
  } catch { /* not JSON: keep as stored */ }
  return fingerprint;
}
export const sentinelNeedsReview = (sentinel: Sentinel): boolean => sentinel.reviewedFingerprint !== sentinelReviewFingerprint(sentinel);

export interface SentinelAttention {
  needsYou: boolean;
  /** Review gate: model/tools changed since the last acknowledgement; autonomous runs are blocked. */
  needsReview: boolean;
  /** Why it needs you, when known. */
  reason?: string;
  /** Derived from the home mission's pending approvals and unanswered questions. */
  pendingDecisions: number;
}

export function parseSentinelCreate(value: unknown): SentinelCreateInput {
  return SentinelCreateSchema.parse(value);
}
/** Patches replace whole top-level fields (nested objects included); fields not named stay as they are. */
export function applySentinelPatch(current: Sentinel, patch: Record<string, unknown>): SentinelInput {
  const { version: _version, ...rawFields } = patch;
  const { id: _id, homeMissionId: _home, homeFingerprint: _homeFp, reviewedFingerprint: _fp, owner: _owner, version: _v, createdAt: _c, updatedAt: _u, ...editable } = current;
  return SentinelInputSchema.parse({ ...editable, ...dropAccessFields(rawFields) });
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
  /** Why a run was skipped, failed or stopped (review gate, ...). */
  error?: string;
  /** One-line fact about how the run executes (for example, that it runs on the host without a sandbox). Shown in the Sentinel detail. */
  note?: string;
  startedAt: string;
  finishedAt?: string;
}

/** What started a turn in a Sentinel's thread. A manual "Run now" is `user`; `legacy` marks an activation projected from before the turn ledger existed. */
export const AGENT_TURN_ORIGINS = ["schedule", "github", "user", "promote", "legacy"] as const;
export type AgentTurnOrigin = (typeof AGENT_TURN_ORIGINS)[number];
/** Provenance detail of a turn. `via` says how it arrived (for example `poll` or `webhook` for GitHub, or the old trigger kind for a legacy row). */
export interface AgentTurnOriginDetail { via?: string; triggerId?: string; automationId?: string; userId?: string; event?: Record<string, string | number> }
export interface AgentTurn {
  id: string;
  agentId: string;
  /** The thread the turn ran in; for a legacy row the child thread the activation started. */
  sessionId?: string;
  /** Monotonic per Sentinel; absent on a projected legacy row. */
  seq?: number;
  origin: AgentTurnOrigin;
  detail: AgentTurnOriginDetail;
  triggerId?: string;
  status: SentinelActivationStatus;
  /** Unique per Sentinel: a replayed delivery or a second engine tick is a no-op. */
  idempotencyKey?: string;
  costUsd?: number;
  error?: string;
  note?: string;
  /** Why a turn was skipped (for example "Waiting on you"); shown instead of an error. */
  skippedReason?: string;
  ownerPid?: number;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  legacyActivationId?: string;
}

export type SentinelFileAuthorKind = "human" | "agent";
export interface SentinelFile { sentinelId: string; path: string; revision: number; content: string; authorKind: SentinelFileAuthorKind; author: string; updatedAt: string }
export interface SentinelFileRevision { sentinelId: string; path: string; revision: number; content: string; digest: string; authorKind: SentinelFileAuthorKind; author: string; createdAt: string }
