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
  avatar: { color: string; icon?: string; emoji?: string; initials?: string };
  role: string;
  skills: string[];
  scope: SentinelScope;
  hostId?: string | null;
  model?: SentinelModelChoice | null;
  budget: SentinelBudget;
  notifications: SentinelNotifications;
  memory: { enabled: boolean; autoLearn: boolean };
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
/** The disabled schedule a "Set up" suggestion starts with: 09:00 local time, Mondays for weekly. The operator reviews it before enabling. */
export function suggestedSchedule(cadence: "hourly" | "daily" | "weekly" | undefined, timezone: string): SentinelSchedule | undefined {
  if (cadence === "hourly") return { frequency: "hourly", timezone };
  if (cadence === "daily") return { frequency: "daily", time: "09:00", timezone };
  if (cadence === "weekly") return { frequency: "weekly", weekday: 1, time: "09:00", timezone };
  return undefined;
}

/** Which suggestions already have an automation. Suggestions can share a template, so each owned automation covers one suggestion. */
export function addedSuggestions(items: readonly SentinelPresetAutomation[], ownedTemplateIds: readonly string[]): boolean[] {
  const remaining = new Map<string, number>();
  for (const id of ownedTemplateIds) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  return items.map(item => { const left = item.templateId ? remaining.get(item.templateId) ?? 0 : 0; if (item.templateId && left > 0) remaining.set(item.templateId, left - 1); return left > 0; });
}

export interface SentinelPreset {
  id: string;
  name: string;
  avatar: { color: string; icon: string };
  /** One-line card description. */
  description: string;
  job: string;
  requiredInputs: string[];
  expectedOutputs: string[];
  sentinel: { skills: string[]; instructions: string };
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
  /** One line on how a pull request run executes (sandbox or host, and its scope). */
  note?: string;
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
  github?: { repo: string; baseBranch?: string; pollMs: number; commentOnPr?: boolean; includeForks?: boolean };
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
export const DEFAULT_FILES = ["AGENTS.md", "NOTES.md"] as const;
export const SENTINEL_RUN_APPROVAL = "launch-authorized-run";
export const SENTINEL_TRIGGER_APPROVAL = "enable-reviewed-trigger";

/** Safe inert defaults for a new Sentinel: paused, nothing in scope, no production, finite daily budget. */
export const DEFAULT_BUDGET: SentinelBudget = { dailyUsd: 10, maxRunsPerDay: 20 };

export interface SentinelFormState {
  name: string;
  mission: string;
  repos: string;
  targets: string;
  outOfScope: string;
  production: boolean;
  dailyUsd: string;
  maxRunsPerDay: string;
}

export const parseLines = (text: string): string[] => [...new Set(text.split(/[\n,]/).map(line => line.trim()).filter(Boolean))];
export const formatLines = (items: readonly string[]): string => items.join("\n");

export function formFromPreset(preset: SentinelPreset | undefined): SentinelFormState {
  return {
    name: preset?.name ?? "", mission: (preset?.job ?? "").slice(0, SENTINEL_LIMITS.mission),
    repos: "", targets: "", outOfScope: "", production: false,
    dailyUsd: String(DEFAULT_BUDGET.dailyUsd), maxRunsPerDay: String(DEFAULT_BUDGET.maxRunsPerDay),
  };
}
export function formFromSentinel(sentinel: Sentinel): SentinelFormState {
  return {
    name: sentinel.name, mission: sentinel.mission,
    repos: formatLines(sentinel.scope.repos), targets: formatLines([...sentinel.scope.targets, ...sentinel.scope.domains]), outOfScope: formatLines(sentinel.scope.outOfScope), production: sentinel.scope.production,
    dailyUsd: String(sentinel.budget.dailyUsd), maxRunsPerDay: String(sentinel.budget.maxRunsPerDay),
  };
}

export type FormFields = Pick<Sentinel, "name" | "mission" | "scope" | "budget">;
/** Validate the form and shape it for the API. Returns an error string for the first problem. */
export function fieldsFromForm(form: SentinelFormState): { ok: true; fields: FormFields } | { ok: false; error: string } {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Give it a name." };
  if (name.length > SENTINEL_LIMITS.name) return { ok: false, error: `Name must be at most ${SENTINEL_LIMITS.name} characters.` };
  if (form.mission.trim().length > SENTINEL_LIMITS.mission) return { ok: false, error: `Job must be at most ${SENTINEL_LIMITS.mission} characters.` };
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
export const NEEDS_REVIEW_COPY = "Its scope, model, tools or access changed. It will not run on its own until you review the change and acknowledge it.";
export const triggerKindLabel = (kind: SentinelTriggerKind): string => ({ schedule: "Schedule", manual: "Manual", "github-pr": "Pull requests" })[kind];
export function describeTrigger(trigger: Pick<SentinelTrigger, "kind" | "summary" | "github">): string {
  if (trigger.summary) return trigger.summary;
  if (trigger.kind === "github-pr" && trigger.github) return `Pull requests on ${trigger.github.repo}${trigger.github.commentOnPr ? ", comments on" : ""}${trigger.github.includeForks ? ", forks included" : ""}`;
  return triggerKindLabel(trigger.kind);
}

/** Sidebar order: needs you, then active, then paused; newest first within a group. Archived rows are hidden. */
export function orderSentinels(sentinels: readonly Sentinel[]): Sentinel[] {
  const rank = (sentinel: Sentinel) => (sentinel.attention?.needsYou || sentinel.attention?.needsReview ? 0 : sentinel.status === "active" ? 1 : 2);
  return sentinels.filter(sentinel => sentinel.status !== "archived")
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.name.localeCompare(b.name));
}

/** Icon id for each built-in preset role; also what a legacy emoji avatar renders as. */
export const PRESET_ICON_IDS: Readonly<Record<string, string>> = {
  "pen-tester": "target", "pr-security-reviewer": "shield", "dependency-watcher": "package", "fix-engineer": "wrench", "secrets-hunter": "key",
  "attack-surface-monitor": "radar", "cloud-posture-auditor": "cloud", "incident-triage": "lifebuoy", "regression-tester": "flask", "release-gate": "rocket",
};
/** The icon id a Sentinel shows: its own, else its preset role's when it only has a legacy emoji. Undefined means an initials tile. Emoji are never rendered. */
export function avatarIconId(sentinel: Pick<Sentinel, "avatar" | "role">): string | undefined {
  return sentinel.avatar.icon ?? (sentinel.avatar.emoji ? PRESET_ICON_IDS[sentinel.role] : undefined);
}

export function avatarInitials(sentinel: Pick<Sentinel, "name" | "avatar">): string {
  if (sentinel.avatar.initials) return sentinel.avatar.initials;
  const words = sentinel.name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "S") + (words.length > 1 ? words[words.length - 1]![0]! : "")).toUpperCase();
}

export const sentinelHref = (id: string, view?: SentinelView) => `/agents/${encodeURIComponent(id)}${view && view !== "overview" ? `?view=${view}` : ""}`;

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
  if (activation.trigger.kind === "github-pr") {
    const event = activation.trigger.event;
    const number = event?.pr !== undefined ? ` #${event.pr}` : "";
    return event?.skipped ? `Pull request${number} skipped` : event?.fork === "yes" ? `Pull request${number} from a fork (untrusted)` : `Pull request${number}`;
  }
  return activation.trigger.kind === "manual" ? "Manual run" : activation.trigger.kind === "automation" ? "Automation" : "Schedule";
}

export const fileBytes = (text: string) => new TextEncoder().encode(text).byteLength;

export const TRIGGER_FREQUENCIES = [["minutes", "Every few minutes"], ["hourly", "Hourly"], ["daily", "Daily"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["cron", "Cron"]] as const;
export interface TriggerDraft { automationId: string; kind: "schedule" | "github-pr"; frequency: SentinelSchedule["frequency"]; every: string; time: string; weekday: string; cron: string; timezone: string; repo: string; baseBranch: string; commentOnPr: boolean; includeForks: boolean }
export const blankTriggerDraft = (automationId = ""): TriggerDraft => ({ automationId, kind: "schedule", frequency: "daily", every: "15", time: "09:00", weekday: "1", cron: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", repo: "", baseBranch: "", commentOnPr: false, includeForks: false });

/** Validate the add-trigger form. New triggers always start off; enabling stays behind the approval dialog. */
export function triggerRequestFromDraft(draft: TriggerDraft): { ok: true; request: { automationId: string; kind: "schedule" | "github-pr"; schedule?: SentinelSchedule; github?: { repo: string; baseBranch?: string; commentOnPr: boolean; includeForks: boolean } } } | { ok: false; error: string } {
  if (!draft.automationId) return { ok: false, error: "Choose which automation this trigger starts." };
  if (draft.kind === "github-pr") {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(draft.repo.trim())) return { ok: false, error: "Enter the repository as owner/name." };
    return { ok: true, request: { automationId: draft.automationId, kind: "github-pr", github: { repo: draft.repo.trim(), ...(draft.baseBranch.trim() ? { baseBranch: draft.baseBranch.trim() } : {}), commentOnPr: draft.commentOnPr, includeForks: draft.includeForks } } };
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
