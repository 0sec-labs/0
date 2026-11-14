/**
 * Sentinel types and pure helpers for the web UI. These mirror the engine's `shared/sentinels.ts`,
 * `sentinel-presets.ts` and `sentinel-triggers.ts` wire shapes field for field.
 *
 * They are local rather than `import type` re-exports because the `@0/engine/shared` entry this package builds
 * against only gains those modules once the Sentinel engine work is merged; until then the import would not
 * type-check. When it lands, replace the interfaces below with `export type { Sentinel, ... } from "@0/engine/shared"`
 * (type-only, so nothing from the engine enters the bundle). Keep new fields in sync by hand until then.
 */
export type SentinelStatus = "active" | "paused" | "archived";
export type SentinelAutonomy = "observe" | "propose" | "act";
export type SentinelToolAccess = "read-only" | "read-web" | "exec";

export interface SentinelScope { repos: string[]; targets: string[]; domains: string[]; outOfScope: string[]; production: boolean }
export interface SentinelBudget { dailyUsd: number; maxRunsPerDay: number }
export interface SentinelNotifications { channels: Array<"in-app" | "github" | "slack">; on: Array<"finding-high" | "needs-you" | "run-failed" | "fix-ready">; quiet: boolean }
export interface SentinelModelChoice { providerId: string; model: string; reasoning?: string }
export interface SentinelPauseReason { kind: "budget"; message: string; at: string }
export interface SentinelAttention {
  needsYou: boolean;
  /** Review gate: scope, model, tools or autonomy changed since the last acknowledgement; autonomous runs are blocked. */
  needsReview: boolean;
  /** Set when the runner paused the Sentinel (for example a budget breach). */
  reason?: string;
  pendingDecisions: number;
}
export interface Sentinel {
  id: string;
  name: string;
  mission: string;
  avatar: { color: string; emoji?: string; initials?: string };
  role: string;
  skills: string[];
  scope: SentinelScope;
  autonomy: SentinelAutonomy;
  toolAccess: SentinelToolAccess;
  hostId?: string | null;
  model?: SentinelModelChoice | null;
  budget: SentinelBudget;
  notifications: SentinelNotifications;
  memory: { enabled: boolean; autoLearn: boolean };
  crew: { maxConcurrent: number; maxDepth: number; crewHost: string | null };
  status: SentinelStatus;
  automationIds: string[];
  homeMissionId: string | null;
  reviewedFingerprint?: string;
  pauseReason?: SentinelPauseReason;
  owner: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  attention?: SentinelAttention;
}

export interface SentinelPresetAutomation {
  name: string;
  templateId?: string;
  trigger: { kind: SentinelTriggerKind; cadence?: "hourly" | "daily" | "weekly" };
  runIn: "new-mission" | "sentinel-home";
}
export interface SentinelPreset {
  id: string;
  name: string;
  avatar: { color: string; emoji: string };
  job: string;
  autonomy: SentinelAutonomy;
  requiredInputs: string[];
  expectedOutputs: string[];
  sentinel: { skills: string[]; toolAccess: SentinelToolAccess; instructions: string };
  suggestedAutomations: SentinelPresetAutomation[];
}

export interface SentinelActivation {
  id: string;
  sentinelId: string;
  sentinelVersion: number;
  trigger: { kind: "manual" | "automation" | "schedule" | "github-pr"; automationId?: string; triggerId?: string; event?: Record<string, string | number> };
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
  missionId?: string;
  parentMissionId?: string;
  automationId?: string;
  executionId?: string;
  skills: string[];
  costUsd?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface SentinelFile { sentinelId: string; path: string; revision: number; content: string; authorKind: "human" | "agent"; author: string; updatedAt: string }
/** Directory entry: the list endpoint omits content. */
export type SentinelFileEntry = Omit<SentinelFile, "content"> & { bytes: number };
export interface SentinelFileRevision { revision: number; content: string; authorKind: "human" | "agent"; author: string; createdAt: string }
export interface SentinelAutomation { id: string; name: string; target?: string; template?: { id: string; revision: number } }

export const SENTINEL_TRIGGER_KINDS = ["schedule", "manual", "github-pr"] as const;
export type SentinelTriggerKind = (typeof SENTINEL_TRIGGER_KINDS)[number];
export interface SentinelSchedule { frequency: "minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "cron"; every?: number; time?: string; weekday?: number; cron?: string; timezone: string }
export interface SentinelTrigger {
  id: string;
  sentinelId: string;
  automationId: string;
  kind: SentinelTriggerKind;
  schedule?: SentinelSchedule;
  github?: { repo: string; baseBranch?: string; pollMs: number };
  enabled: boolean;
  version: number;
  nextFireAt: string | null;
  cursor?: Record<string, string>;
  lastStatus?: string;
  lastError?: string;
  lastActivationId?: string;
  createdAt: string;
  updatedAt: string;
  /** Human sentence for schedules, added by the API view. */
  summary?: string;
}
/** `GET sentinels/:id/budget`: the Sentinel's caps and a rolling 24-hour ledger. */
export interface SentinelBudgetReport {
  budget: SentinelBudget;
  usage: { runs: number; costUsd: number };
  windowMs: number;
  pauseReason: SentinelPauseReason | null;
}

export const SENTINEL_LIMITS = { name: 80, mission: 160, fileBytes: 65_536 } as const;
export const DEFAULT_FILES = ["AGENTS.md", "CREW.md", "NOTES.md"] as const;
export const SENTINEL_RUN_APPROVAL = "launch-authorized-run";
export const SENTINEL_TRIGGER_APPROVAL = "enable-reviewed-trigger";

export const AUTONOMY_OPTIONS: ReadonlyArray<{ value: SentinelAutonomy; label: string; hint: string }> = [
  { value: "observe", label: "Observe", hint: "Read-only. Drafts findings and reports; changes nothing." },
  { value: "propose", label: "Propose", hint: "Prepares changes and waits for your approval before acting." },
  { value: "act", label: "Act", hint: "May publish without per-item approval. Use only for trusted jobs." },
];
export const TOOL_ACCESS_OPTIONS: ReadonlyArray<{ value: SentinelToolAccess; label: string; hint: string }> = [
  { value: "read-only", label: "Read only", hint: "Reads files and records. No network requests beyond reads." },
  { value: "read-web", label: "Read and web", hint: "Adds web lookups and in-scope target requests." },
  { value: "exec", label: "Run commands", hint: "May run commands in its sandbox. Highest trust." },
];

/** Safe inert defaults for a new Sentinel: paused, nothing in scope, no production, finite daily budget. */
export const DEFAULT_BUDGET: SentinelBudget = { dailyUsd: 10, maxRunsPerDay: 20 };

export interface SentinelFormState {
  name: string;
  mission: string;
  repos: string;
  targets: string;
  outOfScope: string;
  production: boolean;
  autonomy: SentinelAutonomy;
  toolAccess: SentinelToolAccess;
  dailyUsd: string;
  maxRunsPerDay: string;
}

export const parseLines = (text: string): string[] => [...new Set(text.split(/[\n,]/).map(line => line.trim()).filter(Boolean))];
export const formatLines = (items: readonly string[]): string => items.join("\n");

export function formFromPreset(preset: SentinelPreset | undefined): SentinelFormState {
  return {
    name: preset?.name ?? "", mission: (preset?.job ?? "").slice(0, SENTINEL_LIMITS.mission),
    repos: "", targets: "", outOfScope: "", production: false,
    autonomy: preset?.autonomy ?? "propose", toolAccess: preset?.sentinel.toolAccess ?? "read-only",
    dailyUsd: String(DEFAULT_BUDGET.dailyUsd), maxRunsPerDay: String(DEFAULT_BUDGET.maxRunsPerDay),
  };
}
export function formFromSentinel(sentinel: Sentinel): SentinelFormState {
  return {
    name: sentinel.name, mission: sentinel.mission,
    repos: formatLines(sentinel.scope.repos), targets: formatLines([...sentinel.scope.targets, ...sentinel.scope.domains]), outOfScope: formatLines(sentinel.scope.outOfScope), production: sentinel.scope.production,
    autonomy: sentinel.autonomy, toolAccess: sentinel.toolAccess,
    dailyUsd: String(sentinel.budget.dailyUsd), maxRunsPerDay: String(sentinel.budget.maxRunsPerDay),
  };
}

export type FormFields = Pick<Sentinel, "name" | "mission" | "scope" | "autonomy" | "toolAccess" | "budget">;
/** Validate the form and shape it for the API. Returns an error string for the first problem. */
export function fieldsFromForm(form: SentinelFormState): { ok: true; fields: FormFields } | { ok: false; error: string } {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Give the Sentinel a name." };
  if (name.length > SENTINEL_LIMITS.name) return { ok: false, error: `Name must be at most ${SENTINEL_LIMITS.name} characters.` };
  if (form.mission.trim().length > SENTINEL_LIMITS.mission) return { ok: false, error: `Mission must be at most ${SENTINEL_LIMITS.mission} characters.` };
  const dailyUsd = Number(form.dailyUsd), maxRunsPerDay = Number(form.maxRunsPerDay);
  if (!(dailyUsd > 0) || dailyUsd > 10_000) return { ok: false, error: "The daily budget must be a positive amount." };
  if (!Number.isInteger(maxRunsPerDay) || maxRunsPerDay < 1 || maxRunsPerDay > 1000) return { ok: false, error: "Runs per day must be a whole number from 1 to 1000." };
  const lines = parseLines(form.targets);
  const isDomain = (value: string) => !/^[a-z]+:\/\//i.test(value) && !value.includes("/") && /^[*a-z0-9.-]+$/i.test(value) && value.includes(".");
  return {
    ok: true,
    fields: {
      name, mission: form.mission.trim(),
      scope: { repos: parseLines(form.repos), targets: lines.filter(item => !isDomain(item)), domains: lines.filter(isDomain), outOfScope: parseLines(form.outOfScope), production: form.production },
      autonomy: form.autonomy, toolAccess: form.toolAccess,
      budget: { dailyUsd, maxRunsPerDay },
    },
  };
}

export type StatusTone = "success" | "warning" | "neutral" | "info";
export interface StatusPresentation { label: string; tone: StatusTone; needsYou: boolean; needsReview: boolean }
export function presentStatus(sentinel: Pick<Sentinel, "status" | "attention">): StatusPresentation {
  const needsReview = sentinel.attention?.needsReview === true;
  if (sentinel.status === "archived") return { label: "Archived", tone: "neutral", needsYou: false, needsReview: false };
  if (needsReview) return { label: "Needs review", tone: "warning", needsYou: false, needsReview };
  if (sentinel.attention?.needsYou) return { label: "Needs you", tone: "warning", needsYou: true, needsReview };
  if (sentinel.status === "paused") return { label: "Paused", tone: "neutral", needsYou: false, needsReview };
  return { label: "Active", tone: "success", needsYou: false, needsReview };
}

const percent = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0);
export interface BudgetMeter { key: string; label: string; used: string; limit: string; percent: number }
/** Rolling-24h meters from the budget endpoint. Only what the ledger reports; nothing is estimated. */
export function budgetMeters(report: Pick<SentinelBudgetReport, "budget" | "usage">): BudgetMeter[] {
  const { budget, usage } = report;
  return [
    { key: "usd", label: "Spend today", used: `$${usage.costUsd.toFixed(2)}`, limit: `$${budget.dailyUsd}`, percent: percent(usage.costUsd, budget.dailyUsd) },
    { key: "runs", label: "Runs today", used: String(usage.runs), limit: String(budget.maxRunsPerDay), percent: percent(usage.runs, budget.maxRunsPerDay) },
  ];
}
export const dailyCaps = (budget: SentinelBudget): string => `$${budget.dailyUsd} and ${budget.maxRunsPerDay} runs a day`;

/** Review gate copy: why a Sentinel cannot run on its own and what acknowledging does. */
export const NEEDS_REVIEW_COPY = "Its scope, model, tools or autonomy changed. It will not run on its own until you review the change and acknowledge it.";
export const triggerKindLabel = (kind: SentinelTriggerKind): string => ({ schedule: "Schedule", manual: "Manual", "github-pr": "Pull requests" })[kind];
export function describeTrigger(trigger: Pick<SentinelTrigger, "kind" | "summary" | "github">): string {
  if (trigger.summary) return trigger.summary;
  if (trigger.kind === "github-pr" && trigger.github) return `Pull requests on ${trigger.github.repo}`;
  return triggerKindLabel(trigger.kind);
}

/** Sidebar order: needs you, then active, then paused; newest first within a group. Archived rows are hidden. */
export function orderSentinels(sentinels: readonly Sentinel[]): Sentinel[] {
  const rank = (sentinel: Sentinel) => (sentinel.attention?.needsYou || sentinel.attention?.needsReview ? 0 : sentinel.status === "active" ? 1 : 2);
  return sentinels.filter(sentinel => sentinel.status !== "archived")
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.name.localeCompare(b.name));
}

export function avatarInitials(sentinel: Pick<Sentinel, "name" | "avatar">): string {
  if (sentinel.avatar.emoji) return sentinel.avatar.emoji;
  if (sentinel.avatar.initials) return sentinel.avatar.initials;
  const words = sentinel.name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "S") + (words.length > 1 ? words[words.length - 1]![0]! : "")).toUpperCase();
}

export const sentinelHref = (id: string, view?: SentinelView) => `/sentinels/${encodeURIComponent(id)}${view && view !== "overview" ? `?view=${view}` : ""}`;

export const SENTINEL_VIEWS = ["overview", "files", "automations", "activations", "settings"] as const;
export type SentinelView = (typeof SENTINEL_VIEWS)[number];
export const parseView = (value: string | null): SentinelView => (SENTINEL_VIEWS as readonly string[]).includes(value ?? "") ? value as SentinelView : "overview";

/** Whether the viewer must treat a save as a revision conflict (HTTP 409 from the files endpoint). */
export class SentinelApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "SentinelApiError"; }
  get conflict() { return this.status === 409; }
}
export const isConflict = (error: unknown): boolean => error instanceof SentinelApiError && error.conflict;

export function activationLabel(activation: Pick<SentinelActivation, "status" | "trigger">): string {
  return activation.trigger.kind === "manual" ? "Manual run" : activation.trigger.kind === "automation" ? "Automation" : activation.trigger.kind === "schedule" ? "Schedule" : "Pull request";
}

export const fileBytes = (text: string) => new TextEncoder().encode(text).byteLength;

export const TRIGGER_FREQUENCIES = [["minutes", "Every few minutes"], ["hourly", "Hourly"], ["daily", "Daily"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["cron", "Cron"]] as const;
export interface TriggerDraft { automationId: string; kind: "schedule" | "github-pr"; frequency: SentinelSchedule["frequency"]; every: string; time: string; weekday: string; cron: string; timezone: string; repo: string; baseBranch: string }
export const blankTriggerDraft = (automationId = ""): TriggerDraft => ({ automationId, kind: "schedule", frequency: "daily", every: "15", time: "09:00", weekday: "1", cron: "", timezone: "UTC", repo: "", baseBranch: "" });

/** Validate the add-trigger form. New triggers always start off; enabling stays behind the approval dialog. */
export function triggerRequestFromDraft(draft: TriggerDraft): { ok: true; request: { automationId: string; kind: "schedule" | "github-pr"; schedule?: SentinelSchedule; github?: { repo: string; baseBranch?: string } } } | { ok: false; error: string } {
  if (!draft.automationId) return { ok: false, error: "Choose which automation this trigger starts." };
  if (draft.kind === "github-pr") {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(draft.repo.trim())) return { ok: false, error: "Enter the repository as owner/name." };
    return { ok: true, request: { automationId: draft.automationId, kind: "github-pr", github: { repo: draft.repo.trim(), ...(draft.baseBranch.trim() ? { baseBranch: draft.baseBranch.trim() } : {}) } } };
  }
  const schedule: SentinelSchedule = { frequency: draft.frequency, timezone: draft.timezone.trim() || "UTC" };
  if (draft.frequency === "minutes") {
    const every = Number(draft.every);
    if (!Number.isInteger(every) || every < 5 || every > 1440) return { ok: false, error: "Choose an interval of 5 to 1440 minutes." };
    schedule.every = every;
  }
  if (["daily", "weekdays", "weekly"].includes(draft.frequency)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return { ok: false, error: "Choose a time of day." };
    schedule.time = draft.time;
  }
  if (draft.frequency === "weekly") schedule.weekday = Number(draft.weekday);
  if (draft.frequency === "cron") {
    if (draft.cron.trim().split(/\s+/).filter(Boolean).length !== 5) return { ok: false, error: "Enter a five-field cron expression, such as 0 9 * * 1." };
    schedule.cron = draft.cron.trim();
  }
  return { ok: true, request: { automationId: draft.automationId, kind: "schedule", schedule } };
}
