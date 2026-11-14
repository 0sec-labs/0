/**
 * Opt-in windowed console snapshots (additive; the default snapshot is unchanged).
 *
 * The full snapshot of a large chat is ~5 MB: sub-worker transcripts and
 * telemetry (~3.6 MB), the whole message list, the whole retained event buffer
 * and a ~90 KB tool catalog that never changes within a session. These shapes
 * let a client open a chat from a few hundred KB and fetch the rest on demand.
 *
 * HTTP contract (all under /api/console/sessions/:id):
 *
 *   GET  ?window=<n>[&workers=summary]
 *        -> { snapshot: WindowedConsoleSnapshot }
 *        `window` (1..1000) keeps only the last n messages and last n events.
 *        `workers=summary` replaces ConsoleWorker[] with ConsoleWorkerSummary[].
 *        Either parameter alone is allowed. When `window` or `workers=summary`
 *        is present the `tools` catalog is omitted (`tools: []`,
 *        `toolsOmitted: true`) and served from GET .../tools instead.
 *        Without these parameters the response is byte-for-byte the old shape.
 *
 *   GET  /tools                           -> { tools }   (ETag + 304, cacheable)
 *   GET  /workers/:workerId               -> { worker }  (full transcript + telemetry)
 *   GET  /messages?before=<index>&limit=  -> MessagesPage (older messages, newest-last)
 *   GET  /events?after=<cursor>&wait=<s>[&window=1]
 *        long-poll (wait <= 25 s); with `window=1` a stale cursor yields
 *        { events: [], cursor, gap: true, resync: true } instead of a snapshot.
 *
 *   GET  /api/console/saved/:id/transcript[?window=<n>|before=<index>&limit=]
 *        read-only saved transcript, same MessagesPage shape plus `meta`.
 *
 * Message cursors are zero-based indices into the public message list. A
 * snapshot's `window.firstMessageIndex` is the `before` value that fetches the
 * page immediately older than what it contains.
 */
import type { ConsolePublicMessage, ConsoleSessionSnapshot, ConsoleWorker } from "@0/engine/shared";

export const MAX_SNAPSHOT_WINDOW = 1_000;
const MAX_MESSAGE_PAGE = 500;
const DEFAULT_MESSAGE_PAGE = 50;
/** Longest the server will hold an events long-poll. */
export const MAX_EVENTS_WAIT_SECONDS = 25;

export interface SnapshotWindowOptions {
  /** Keep only the last n messages and events. */
  window?: number;
  /** `summary` replaces worker transcripts/telemetry with counts. */
  workers: "full" | "summary";
}

export interface ConsoleWorkerSummary {
  id: string;
  parentId: string;
  name: string;
  status: ConsoleWorker["status"];
  task: string;
  model?: string;
  role?: string;
  summary?: string;
  error?: string;
  /** Scalar top-level telemetry values only (cost, token counts, ...). */
  telemetry: Record<string, string | number | boolean>;
  turnCount: number;
  toolCallCount: number;
  operatorMessageCount: number;
}

export interface SnapshotWindowMeta {
  messages: number;
  messagesTotal: number;
  /** Pass as `before` to GET .../messages to page older history; null when nothing is older. */
  firstMessageIndex: number | null;
  events: number;
  eventsTotal: number;
  workers: "full" | "summary";
}

export type WindowedConsoleSnapshot =
  Omit<ConsoleSessionSnapshot, "workers"> & {
    workers: ConsoleWorker[] | ConsoleWorkerSummary[];
    toolsOmitted?: true;
    window: SnapshotWindowMeta;
  };

export interface MessagesPage {
  messages: ConsolePublicMessage[];
  total: number;
  /** Index of the first returned message; use as the next `before`. */
  firstIndex: number;
  hasMore: boolean;
}

/** Parse the opt-in query parameters; undefined means "serve the legacy full snapshot". */
export function parseSnapshotWindow(params: URLSearchParams): SnapshotWindowOptions | undefined {
  const rawWindow = params.get("window");
  const workers = params.get("workers");
  if (rawWindow === null && workers === null) return undefined;
  if (workers !== null && workers !== "summary" && workers !== "full") throw new RangeError("workers must be summary or full.");
  let window: number | undefined;
  if (rawWindow !== null) {
    window = Number(rawWindow);
    if (!Number.isSafeInteger(window) || window < 1 || window > MAX_SNAPSHOT_WINDOW) throw new RangeError(`window must be an integer from 1 to ${MAX_SNAPSHOT_WINDOW}.`);
  }
  return { ...(window !== undefined ? { window } : {}), workers: workers === "summary" ? "summary" : "full" };
}

export function parseMessagePage(params: URLSearchParams): { before?: number; limit: number } {
  const rawBefore = params.get("before");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_MESSAGE_PAGE : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE) throw new RangeError(`limit must be an integer from 1 to ${MAX_MESSAGE_PAGE}.`);
  if (rawBefore === null) return { limit };
  const before = Number(rawBefore);
  if (!Number.isSafeInteger(before) || before < 0) throw new RangeError("before must be a non-negative integer.");
  return { before, limit };
}

export function pageMessages(all: readonly ConsolePublicMessage[], options: { before?: number; limit: number }): MessagesPage {
  const end = Math.min(options.before ?? all.length, all.length);
  const start = Math.max(0, end - options.limit);
  return { messages: all.slice(start, end), total: all.length, firstIndex: start, hasMore: start > 0 };
}

export function summarizeConsoleWorker(worker: ConsoleWorker): ConsoleWorkerSummary {
  const telemetry: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(worker.telemetry ?? {})) {
    if (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 200)) telemetry[key] = value;
  }
  return {
    id: worker.id, parentId: worker.parentId, name: worker.name, status: worker.status,
    task: worker.task.length > 1_000 ? `${worker.task.slice(0, 1_000)}…` : worker.task,
    ...(worker.model !== undefined ? { model: worker.model } : {}),
    ...(worker.role !== undefined ? { role: worker.role } : {}),
    ...(worker.summary !== undefined ? { summary: worker.summary.length > 1_000 ? `${worker.summary.slice(0, 1_000)}…` : worker.summary } : {}),
    ...(worker.error !== undefined ? { error: worker.error } : {}),
    telemetry,
    turnCount: worker.transcript.length,
    toolCallCount: worker.transcript.reduce((sum, turn) => sum + (turn.tools?.length ?? 0), 0),
    operatorMessageCount: worker.operatorMessages?.length ?? 0,
  };
}
