import type { ConsoleSessionSnapshot, DesktopConsoleEvent } from "@0/engine/shared";

export const SNAPSHOT_CACHE_MS = 5 * 60_000;
export const SNAPSHOT_RESYNC_MS = 15_000;
/** Delay between event polls: unchanged for running turns, relaxed when nothing is happening. */
export const POLL_ACTIVE_MS = 350;
export const POLL_IDLE_MS = 1000;
export const POLL_RECOVER_MS = 1500;
/** A docked chat that is not on screen (inactive tab) still catches up, but never at the running-turn rate. */
export const POLL_OFFSCREEN_MS = 5000;
/** Server-side hold of an events long-poll (the server caps it at 25 s). */
export const LONG_POLL_WAIT_S = 25;
/** A long-poll that answers emptier and faster than this was not held (closed session, proxy): back off like a short poll. */
export const LONG_POLL_MIN_HOLD_MS = 1000;
/** Lists change slowly relative to the per-chat event feed; the feed patches the active row in between. */
export const LIST_STALE_MS = 15_000;

/** A snapshot is "active" while a turn, worker or queued message can still change it without user input. */
export function snapshotActive(snapshot: ConsoleSessionSnapshot | null | undefined): boolean {
  if (!snapshot) return true;
  if (["working", "waiting", "cancelling"].includes(snapshot.session.status)) return true;
  return (
    snapshot.queuedMessages.length > 0 ||
    snapshot.workers.some((worker) => worker.status === "running" || worker.status === "queued")
  );
}
export function pollDelay({
  recovering,
  active,
  visible = true,
}: {
  recovering: boolean;
  active: boolean;
  visible?: boolean;
}): number {
  if (!visible) return Math.max(POLL_OFFSCREEN_MS, recovering ? POLL_RECOVER_MS : 0);
  return recovering ? POLL_RECOVER_MS : active ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}
/** A periodic full resync is a safety net: skip it while idle and the event cursor has not moved since the last full snapshot. */
export function shouldResyncSnapshot({
  missing,
  invalidated,
  age,
  active,
  cursorMoved,
}: {
  missing: boolean;
  invalidated: boolean;
  age: number;
  active: boolean;
  cursorMoved: boolean;
}): boolean {
  if (missing || invalidated) return true;
  if (age <= SNAPSHOT_RESYNC_MS) return false;
  return active || cursorMoved;
}

/** Events after which the shared dashboard (Findings count) is worth refetching. */
export function findingSignal(event: DesktopConsoleEvent): boolean {
  return (
    event.type === "turn-complete" ||
    (event.type === "tool-result" && /finding/i.test(String((event.call as { name?: unknown }).name ?? "")))
  );
}

/** Resolves when the tab becomes visible again (or the poll is aborted). */
export function waitForVisible(signal: AbortSignal): Promise<void> {
  if (!document.hidden || signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    document.removeEventListener("visibilitychange", check);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const check = () => {
    if (!document.hidden) done();
  };
  document.addEventListener("visibilitychange", check);
  signal.addEventListener("abort", done, { once: true });
  return promise;
}

export function applyEvents(
  snapshot: ConsoleSessionSnapshot,
  events: DesktopConsoleEvent[],
  cursor: number,
): ConsoleSessionSnapshot {
  if (events.length === 0 && cursor === snapshot.cursor) return snapshot;
  let next = snapshot;
  const retained = new Map(snapshot.events.map((event) => [event.sequence, event]));
  for (const event of events) {
    if (event.sequence <= snapshot.cursor) continue;
    if (event.type === "snapshot") {
      next = event.snapshot;
      retained.clear();
      for (const item of next.events) retained.set(item.sequence, item);
      continue;
    }
    if (event.type === "clear") {
      retained.clear();
      next = {
        ...next,
        messages: [],
        queuedMessages: [],
        pendingDecisions: [],
        lastOutcome: null,
        objective: "",
        todos: null,
      };
    }
    retained.set(event.sequence, event);
    switch (event.type) {
      case "user":
        next = { ...next, lastOutcome: null, stagedPrompt: undefined };
        break;
      case "session":
        next = {
          ...next,
          session: event.session,
          execution: event.session.execution ?? next.execution,
          title: event.session.title ?? next.title,
        };
        break;
      case "decision":
        next = {
          ...next,
          pendingDecisions: [...next.pendingDecisions.filter((item) => item.id !== event.decision.id), event.decision],
        };
        break;
      case "decision-resolved":
        next = { ...next, pendingDecisions: next.pendingDecisions.filter((item) => item.id !== event.decisionId) };
        break;
      case "worker": {
        const previous = next.workers.find((item) => item.id === event.worker.id);
        let worker = event.worker;
        if (previous && "incremental" in event && event.incremental === true) {
          const turns = new Map(previous.transcript.map((turn) => [turn.turn, turn]));
          for (const turn of event.worker.transcript) turns.set(turn.turn, turn);
          const messages = new Map((previous.operatorMessages ?? []).map((message) => [message.id, message]));
          for (const message of event.worker.operatorMessages ?? []) messages.set(message.id, message);
          worker = {
            ...previous,
            ...event.worker,
            transcript: Array.from(turns.values()).sort((left, right) => left.turn - right.turn),
            operatorMessages: Array.from(messages.values()),
          };
        }
        next = { ...next, workers: [...next.workers.filter((item) => item.id !== worker.id), worker] };
        break;
      }
      case "queued":
        next = { ...next, queuedMessages: event.messages };
        break;
      case "state":
        next = { ...next, objective: event.objective, todos: event.todos };
        break;
      case "harness":
        next = { ...next, harness: event.harness };
        break;
      case "compaction":
        next = { ...next, compaction: event.compaction };
        break;
      case "turn-complete":
        next = { ...next, lastOutcome: event };
        break;
    }
  }
  return {
    ...next,
    cursor,
    events: Array.from(retained.values()).sort((left, right) => left.sequence - right.sequence),
  };
}
