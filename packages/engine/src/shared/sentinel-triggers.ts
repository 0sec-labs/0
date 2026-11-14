import { z } from "zod";
import { DAY_MS } from "./units.js";

/**
 * Triggers for Sentinel-owned automations. A trigger starts a run of one automation (workflow definition)
 * on behalf of its owner Sentinel. Schedules use wall-clock time in an IANA timezone.
 */
export const SENTINEL_TRIGGER_KINDS = ["schedule", "manual", "github-pr"] as const;
export type SentinelTriggerKind = (typeof SENTINEL_TRIGGER_KINDS)[number];
/** Older records may hold kinds that were removed (push, webhook, finding events); they are kept disabled and hidden. */
export const isSentinelTriggerKind = (kind: string): kind is SentinelTriggerKind => (SENTINEL_TRIGGER_KINDS as readonly string[]).includes(kind);

export const SCHEDULE_FREQUENCIES = ["minutes", "hourly", "daily", "weekdays", "weekly", "cron"] as const;
export const MIN_MINUTES_INTERVAL = 5;
export const MIN_GITHUB_POLL_MS = 60_000;

const timezone = z.string().trim().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid IANA timezone.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");
export const SentinelScheduleSchema = z.strictObject({
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  /** minutes: interval in minutes (>= 5). */
  every: z.number().int().min(MIN_MINUTES_INTERVAL).max(1440).optional(),
  /** daily/weekdays/weekly: local time. hourly: only the minute part is used. */
  time: time.optional(),
  /** weekly: 0 (Sunday) to 6. */
  weekday: z.number().int().min(0).max(6).optional(),
  /** cron: five fields (minute hour day-of-month month day-of-week). */
  cron: z.string().trim().max(120).optional(),
  timezone: timezone.default("UTC"),
}).superRefine((schedule, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (schedule.frequency === "minutes" && schedule.every === undefined) issue("Minutes schedules need an interval.");
  if (schedule.frequency === "cron") {
    if (!schedule.cron) issue("Cron schedules need an expression.");
    else { try { parseCron(schedule.cron); } catch (error) { issue(error instanceof Error ? error.message : "Invalid cron expression."); } }
  }
  if (["daily", "weekdays", "weekly"].includes(schedule.frequency) && !schedule.time) issue("This schedule needs a local time.");
  if (schedule.frequency === "weekly" && schedule.weekday === undefined) issue("Weekly schedules need a weekday.");
});
export type SentinelSchedule = z.output<typeof SentinelScheduleSchema>;

export const SentinelGithubPrConfigSchema = z.strictObject({
  repo: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "Use owner/name."),
  baseBranch: z.string().trim().min(1).max(200).optional(),
  pollMs: z.number().int().min(MIN_GITHUB_POLL_MS).max(3_600_000).default(120_000),
});
export type SentinelGithubPrConfig = z.output<typeof SentinelGithubPrConfigSchema>;

export const SentinelTriggerCreateSchema = z.strictObject({
  automationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  kind: z.enum(SENTINEL_TRIGGER_KINDS),
  schedule: SentinelScheduleSchema.optional(),
  github: SentinelGithubPrConfigSchema.optional(),
  enabled: z.boolean().default(false),
});
export type SentinelTriggerCreate = z.output<typeof SentinelTriggerCreateSchema>;

export interface SentinelTrigger {
  id: string;
  sentinelId: string;
  automationId: string;
  kind: SentinelTriggerKind;
  schedule?: SentinelSchedule;
  github?: SentinelGithubPrConfig;
  enabled: boolean;
  version: number;
  nextFireAt: string | null;
  /** github-pr: PR number -> last handled head SHA; bounded. Absent until the first (baseline) poll. */
  cursor?: Record<string, string>;
  lastStatus?: string;
  lastError?: string;
  lastActivationId?: string;
  activeClaim?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- cron / wall-clock arithmetic ----------

interface CronField { any: boolean; values: Set<number> }
interface CronSpec { minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField }
const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(source: string, [min, max]: [number, number]): CronField {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const [range, stepText, ...extra] = part.split("/");
    if (extra.length || !range) throw new Error("Invalid cron expression.");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error("Invalid cron step.");
    let from: number; let to: number;
    if (range === "*") { from = min; to = max; }
    else if (/^\d+$/.test(range)) { from = Number(range); to = stepText === undefined ? from : max; }
    else {
      const match = /^(\d+)-(\d+)$/.exec(range);
      if (!match) throw new Error("Invalid cron expression.");
      from = Number(match[1]); to = Number(match[2]);
    }
    if (from < min || to > max || from > to) throw new Error("Cron value out of range.");
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { any: source === "*" || source === "*/1", values };
}
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron needs five fields: minute hour day-of-month month day-of-week.");
  const [minute, hour, dom, month, dow] = fields.map((field, index) => parseField(field, RANGES[index]!)) as [CronField, CronField, CronField, CronField, CronField];
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dom, month, dow };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoned(ms: number, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { minute: Number(parts.minute), hour: Number(parts.hour) % 24, day: Number(parts.day), month: Number(parts.month), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!) };
}

function cronOf(schedule: SentinelSchedule): string {
  const [hour, minute] = (schedule.time ?? "00:00").split(":").map(Number) as [number, number];
  switch (schedule.frequency) {
    case "hourly": return `${minute} * * * *`;
    case "daily": return `${minute} ${hour} * * *`;
    case "weekdays": return `${minute} ${hour} * * 1-5`;
    case "weekly": return `${minute} ${hour} * * ${schedule.weekday}`;
    case "cron": return schedule.cron!;
    default: throw new Error("Not a cron-backed schedule.");
  }
}

/**
 * Next fire strictly after `afterMs`, as epoch ms. Wall-clock in the schedule's timezone (DST-safe: fields are
 * recomputed at every step). Searches at most one year ahead and throws if nothing matches.
 */
export function nextSentinelFire(schedule: SentinelSchedule, afterMs: number): number {
  if (!Number.isFinite(afterMs)) throw new Error("Invalid schedule.");
  if (schedule.frequency === "minutes") {
    const interval = (schedule.every ?? MIN_MINUTES_INTERVAL) * 60_000;
    return (Math.floor(afterMs / interval) + 1) * interval;
  }
  const spec = parseCron(cronOf(schedule));
  let t = (Math.floor(afterMs / 60_000) + 1) * 60_000;
  const limit = afterMs + 366 * DAY_MS;
  while (t <= limit) {
    const p = zoned(t, schedule.timezone);
    const domOk = spec.dom.values.has(p.day); const dowOk = spec.dow.values.has(p.weekday);
    const dayOk = spec.dom.any || spec.dow.any ? (spec.dom.any || domOk) && (spec.dow.any || dowOk) : domOk || dowOk;
    if (!spec.month.values.has(p.month) || !dayOk) { t += (1440 - (p.hour * 60 + p.minute)) * 60_000; continue; }
    if (!spec.hour.values.has(p.hour)) { t += (60 - p.minute) * 60_000; continue; }
    if (!spec.minute.values.has(p.minute)) { t += 60_000; continue; }
    return t;
  }
  throw new Error("Schedule never fires within a year.");
}

/** Short human summary, e.g. "Weekdays at 09:00 (Europe/Zurich)". */
export function describeSentinelSchedule(schedule: SentinelSchedule): string {
  const zone = schedule.timezone;
  switch (schedule.frequency) {
    case "minutes": return `Every ${schedule.every} minutes`;
    case "hourly": return `Hourly at :${(schedule.time ?? "00:00").split(":")[1]} (${zone})`;
    case "daily": return `Daily at ${schedule.time} (${zone})`;
    case "weekdays": return `Weekdays at ${schedule.time} (${zone})`;
    case "weekly": return `Weekly on ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][schedule.weekday ?? 0]} at ${schedule.time} (${zone})`;
    case "cron": return `Cron ${schedule.cron} (${zone})`;
  }
}
