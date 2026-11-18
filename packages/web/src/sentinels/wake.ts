import type { AgentTurn, AgentTurnOrigin } from "./model";

/** The first line of every trigger turn the engine sends into a Sentinel's thread: `[Turn from <source> · turn <8 hex>]`. */
const HEADER = /^\s*\[Turn from (.+?) · turn ([0-9a-f]{8})\]/;
export interface WakeHeader { source: string; nonce: string; origin: Extract<AgentTurnOrigin, "schedule" | "github"> | undefined }

/** Reads the header of a trigger turn's message. Anything else (a person's message, a reply) is not a wake-up. */
export function parseWakeHeader(text: string): WakeHeader | null {
  const match = HEADER.exec(text);
  if (!match) return null;
  const source = match[1]!;
  return { source, nonce: match[2]!, origin: source.startsWith("schedule") ? "schedule" : source.startsWith("GitHub") ? "github" : undefined };
}

/** The cause chip shown on a wake-up line and in the activity list. */
export const CAUSE_LABEL: Record<AgentTurnOrigin, string> = { schedule: "Schedule", github: "GitHub", user: "You", promote: "Promoted", legacy: "Earlier" };

/** "54s", "1m 8s", "2h 5m". */
export function workedFor(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface WakeSummary { text: string; failed: boolean; working: boolean }
/** One quiet line: "Woke on schedule, worked for 54s". Without the turn row (an older thread or a page without the ledger) it only says what woke it. */
export function wakeSummary(header: WakeHeader, turn: AgentTurn | undefined, now = Date.now()): WakeSummary {
  const lead = header.origin === "schedule" ? "Woke on schedule" : header.origin === "github" ? "Woke on a pull request" : "Woke up";
  if (!turn) return { text: lead, failed: false, working: false };
  const started = turn.startedAt ? Date.parse(turn.startedAt) : undefined;
  if (turn.status === "queued") return { text: `${lead}, waiting its turn`, failed: false, working: false };
  if (turn.status === "running") return { text: `${lead}, working${started ? ` for ${workedFor(now - started)}` : ""}`, failed: false, working: true };
  const finished = turn.finishedAt ? Date.parse(turn.finishedAt) : undefined;
  const took = started !== undefined && finished !== undefined ? `, worked for ${workedFor(finished - started)}` : "";
  if (turn.status === "failed") return { text: `${lead}${took}, failed`, failed: true, working: false };
  if (turn.status === "cancelled") return { text: `${lead}${took}, stopped`, failed: false, working: false };
  if (turn.status === "skipped") return { text: `${lead}, skipped${turn.skippedReason ? `: ${turn.skippedReason}` : ""}`, failed: false, working: false };
  return { text: `${lead}${took}`, failed: false, working: false };
}

/** A short line for the activity list and the expanded log. */
export function turnLabel(turn: Pick<AgentTurn, "origin" | "detail">): string {
  if (turn.origin === "github") {
    const event = turn.detail.event;
    return event?.pr !== undefined ? `Pull request #${event.pr}${event.repo ? ` on ${event.repo}` : ""}` : "Pull request";
  }
  if (turn.origin === "schedule") return "Scheduled turn";
  if (turn.origin === "user") return "Your message";
  if (turn.origin === "promote") return "Promoted from a thread";
  return "Earlier activity";
}
