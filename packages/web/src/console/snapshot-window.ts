import type { ConsolePublicMessage, ConsoleSessionSnapshot, ConsoleWorker, DesktopConsoleEvent } from "@0/engine/shared";

/**
 * Client side of the opt-in windowed console snapshot (see the engine's console-snapshot-window contract).
 * A server that predates it ignores the query and answers with the legacy full snapshot, which carries no
 * `window` field: that absence is the feature-detect, and every helper here passes such snapshots through.
 */
export interface SnapshotWindowMeta {
  messages: number;
  messagesTotal: number;
  /** Pass as `before` to page older messages; null when the session has no messages. */
  firstMessageIndex: number | null;
  events: number;
  eventsTotal: number;
  workers: "full" | "summary";
}

/** A worker whose transcript was not sent. `summaryOnly` clears once the full worker is merged in. */
export type ClientWorker = ConsoleWorker & { summaryOnly?: true; turnCount?: number; toolCallCount?: number; operatorMessageCount?: number };
export type WindowedSnapshot = ConsoleSessionSnapshot & { window?: SnapshotWindowMeta; toolsOmitted?: true };

/** Wire shape of `workers=summary` entries. */
export interface WireWorker extends Omit<ConsoleWorker, "transcript" | "operatorMessages" | "telemetry"> {
  transcript?: ConsoleWorker["transcript"];
  telemetry?: ConsoleWorker["telemetry"];
  turnCount?: number; toolCallCount?: number; operatorMessageCount?: number;
}

export interface ConsoleMessagesPage { messages: ConsolePublicMessage[]; total: number; firstIndex: number; hasMore: boolean }

export const OPEN_WINDOW = 60;
/** A running turn streams hundreds of delta events; keep enough of them that the live turn is complete on open. */
export const ACTIVE_OPEN_WINDOW = 400;
export const MESSAGE_PAGE = 50;
const MAX_EVENTS = 2_000;

/** Give summary workers the full-worker shape (empty transcript) so every consumer keeps working. */
export function expandSummaryWorkers(snapshot: WindowedSnapshot): WindowedSnapshot {
  if (snapshot.window?.workers !== "summary") return snapshot;
  const workers = (snapshot.workers as unknown as WireWorker[]).map((worker): ClientWorker => Array.isArray(worker.transcript)
    ? worker as ClientWorker
    : { ...worker, transcript: [], operatorMessages: [], telemetry: worker.telemetry ?? {}, summaryOnly: true });
  return { ...snapshot, workers };
}

export function hasOlderMessages(snapshot: WindowedSnapshot | null | undefined): boolean {
  const first = snapshot?.window?.firstMessageIndex;
  return typeof first === "number" && first > 0;
}

/** Windowed snapshots can be refetched freely: keep what earlier pages and earlier windows already loaded. */
export function mergeWindowedSnapshot(previous: WindowedSnapshot | null | undefined, next: WindowedSnapshot): WindowedSnapshot {
  const incoming = expandSummaryWorkers(next);
  if (!previous || !incoming.window || !previous.window || previous.session.id !== incoming.session.id) return carryDetail(previous, incoming);
  const prevWindow = previous.window; const nextWindow = incoming.window;
  let merged = incoming;
  const prevFirst = prevWindow.firstMessageIndex ?? 0; const nextFirst = nextWindow.firstMessageIndex ?? 0;
  // Index-contiguous and not shrunk (clear/compaction rewrite history): the old prefix is still valid.
  if (nextWindow.messagesTotal >= prevWindow.messagesTotal && nextFirst >= prevFirst && nextFirst <= prevFirst + previous.messages.length) {
    const prefix = previous.messages.slice(0, nextFirst - prevFirst);
    if (prefix.length) merged = { ...merged, messages: [...prefix, ...incoming.messages], window: { ...nextWindow, messages: prefix.length + incoming.messages.length, firstMessageIndex: prevFirst } };
  }
  const events = mergeEvents(previous.events, incoming.events);
  if (events !== incoming.events) merged = { ...merged, events };
  return carryDetail(previous, merged);
}

/** Keep already-loaded worker transcripts when a later summary snapshot lists the same worker. */
function carryDetail(previous: WindowedSnapshot | null | undefined, next: WindowedSnapshot): WindowedSnapshot {
  if (!previous || previous.session.id !== next.session.id || !next.workers.some((worker: ClientWorker) => worker.summaryOnly)) return next;
  const loaded = new Map((previous.workers as ClientWorker[]).filter(worker => !worker.summaryOnly).map(worker => [worker.id, worker]));
  if (!loaded.size) return next;
  return { ...next, workers: next.workers.map((worker: ClientWorker) => {
    const detail = worker.summaryOnly ? loaded.get(worker.id) : undefined;
    return detail ? { ...detail, ...worker, summaryOnly: undefined, transcript: detail.transcript, operatorMessages: detail.operatorMessages } as ClientWorker : worker;
  }) };
}

function mergeEvents(previous: DesktopConsoleEvent[], next: DesktopConsoleEvent[]): DesktopConsoleEvent[] {
  const lastPrev = previous.at(-1)?.sequence; const firstNext = next[0]?.sequence;
  if (lastPrev === undefined || firstNext === undefined || firstNext > lastPrev + 1 || next.at(-1)!.sequence < lastPrev) return next;
  const merged = [...previous.filter(event => event.sequence < firstNext), ...next];
  const clear = merged.findLastIndex(event => event.type === "clear");
  const kept = (clear > 0 ? merged.slice(clear) : merged).slice(-MAX_EVENTS);
  return kept.length === next.length ? next : kept;
}

/** Prepend an older page fetched from GET .../messages. */
export function prependMessages(snapshot: WindowedSnapshot, page: { messages: ConsolePublicMessage[]; firstIndex: number }): WindowedSnapshot {
  const window = snapshot.window; if (!window) return snapshot;
  const first = window.firstMessageIndex ?? 0;
  const take = page.messages.slice(0, Math.max(0, first - page.firstIndex));
  if (!take.length) return snapshot;
  return { ...snapshot, messages: [...take, ...snapshot.messages], window: { ...window, messages: window.messages + take.length, firstMessageIndex: page.firstIndex } };
}

/** Replace a summary worker by its full detail, keeping turns that arrived by event after the fetch began. */
export function withWorkerDetail(snapshot: WindowedSnapshot, detail: ConsoleWorker): WindowedSnapshot {
  if (!snapshot.workers.some(worker => worker.id === detail.id)) return snapshot;
  return { ...snapshot, workers: snapshot.workers.map((worker: ClientWorker) => {
    if (worker.id !== detail.id) return worker;
    const newest = Math.max(-1, ...detail.transcript.map(turn => turn.turn));
    const turns = [...detail.transcript, ...worker.transcript.filter(turn => turn.turn > newest)];
    const messages = new Map([...(detail.operatorMessages ?? []), ...(worker.operatorMessages ?? [])].map(message => [message.id, message]));
    // Live status/telemetry on the snapshot is at least as new as the fetched detail only when it was not a summary.
    const base = worker.summaryOnly ? { ...detail, status: worker.status, telemetry: { ...detail.telemetry, ...worker.telemetry } } : { ...detail, ...worker };
    const { summaryOnly: _s, turnCount: _t, toolCallCount: _c, operatorMessageCount: _o, ...rest } = base as ClientWorker;
    return { ...rest, transcript: turns, operatorMessages: [...messages.values()] };
  }) };
}

export function needsWorkerDetail(snapshot: WindowedSnapshot | null | undefined, workerId: string | null | undefined): boolean {
  return Boolean(workerId && (snapshot?.workers as ClientWorker[] | undefined)?.some(worker => worker.id === workerId && worker.summaryOnly));
}
