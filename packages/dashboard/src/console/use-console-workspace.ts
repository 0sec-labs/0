import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsoleCreateSessionInput, ConsoleMessageInput, ConsoleSavedSession, ConsoleSessionSnapshot, DesktopConsoleEvent, DesktopConsoleSession } from "@0/shared";
import { createConsoleSession, getConsoleEvents, getConsoleSnapshot, listConsoleSessions, listSavedConsoleSessions, sendConsoleMessage } from "@/api";
import { usePersistentState } from "@/lib/use-persistent-state";

export interface ConsoleWorkspace {
  snapshot: ConsoleSessionSnapshot | null;
  sessions: DesktopConsoleSession[];
  sessionsLoaded: boolean;
  saved: ConsoleSavedSession[];
  loading: boolean;
  error: string | undefined;
  busy: boolean;
  draft: string;
  dismissError(): void;
  setDraft(value: string): void;
  setRootDraft(value: string): void;
  forgetDrafts(id: string): void;
  refresh(): void;
  perform<T>(action: () => Promise<T>, owner?: string): Promise<T | undefined>;
  send(input: ConsoleMessageInput): Promise<boolean>;
  create(input: ConsoleCreateSessionInput): Promise<DesktopConsoleSession | undefined>;
}

function applyEvents(snapshot: ConsoleSessionSnapshot, events: DesktopConsoleEvent[], cursor: number): ConsoleSessionSnapshot {
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
      next = { ...next, messages: [], pendingDecisions: [], lastOutcome: null, objective: "", todos: null };
    }
    retained.set(event.sequence, event);
    switch (event.type) {
      case "user": next = { ...next, lastOutcome: null, stagedPrompt: undefined }; break;
      case "session": next = { ...next, session: event.session, title: event.session.title ?? next.title }; break;
      case "decision": next = { ...next, pendingDecisions: [...next.pendingDecisions.filter((item) => item.id !== event.decision.id), event.decision] }; break;
      case "decision-resolved": next = { ...next, pendingDecisions: next.pendingDecisions.filter((item) => item.id !== event.decisionId) }; break;
      case "worker": {
        const previous = next.workers.find((item) => item.id === event.worker.id);
        let worker = event.worker;
        if (previous && "incremental" in event && event.incremental === true) {
          const turns = new Map(previous.transcript.map((turn) => [turn.turn, turn]));
          for (const turn of event.worker.transcript) turns.set(turn.turn, turn);
          const messages = new Map((previous.operatorMessages ?? []).map((message) => [message.id, message]));
          for (const message of event.worker.operatorMessages ?? []) messages.set(message.id, message);
          worker = { ...previous, ...event.worker, transcript: Array.from(turns.values()).sort((left, right) => left.turn - right.turn), operatorMessages: Array.from(messages.values()) };
        }
        next = { ...next, workers: [...next.workers.filter((item) => item.id !== worker.id), worker] };
        break;
      }
      case "queued": next = { ...next, queuedMessages: event.messages }; break;
      case "state": next = { ...next, objective: event.objective, todos: event.todos }; break;
      case "harness": next = { ...next, harness: event.harness }; break;
      case "compaction": next = { ...next, compaction: event.compaction }; break;
      case "turn-complete": next = { ...next, lastOutcome: event }; break;
    }
  }
  return { ...next, cursor, events: Array.from(retained.values()).sort((left, right) => left.sequence - right.sequence) };
}

export function useConsoleWorkspace(sessionId: string | undefined, workerId: string | null): ConsoleWorkspace {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({ queryKey: ["console-sessions"], queryFn: ({ signal }) => listConsoleSessions(signal), refetchInterval: 2000 });
  const savedQuery = useQuery({ queryKey: ["console-saved"], queryFn: ({ signal }) => listSavedConsoleSessions(signal), refetchInterval: 5000 });
  const [storedDrafts, setDrafts] = usePersistentState<Record<string, string>>("0-console-drafts", {});
  const drafts = storedDrafts && typeof storedDrafts === "object" && !Array.isArray(storedDrafts) ? storedDrafts : {};
  const [storedSnapshot, setSnapshot] = useState<ConsoleSessionSnapshot | null>(null);
  const [error, setError] = useState<{ sessionId?: string; message: string; source: "poll" | "action" } | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const draftKey = `${sessionId ?? "new"}:${workerId ?? "root"}`;
  const draft = typeof drafts[draftKey] === "string" ? drafts[draftKey] : "";
  const snapshot = storedSnapshot?.session.id === sessionId ? storedSnapshot : null;

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let current: ConsoleSessionSnapshot | null = null;
    const poll = async () => {
      let lastSnapshot = 0;
      while (!signal.aborted) {
        try {
          if (!current || Date.now() - lastSnapshot > 1800) {
            current = await getConsoleSnapshot(sessionId, signal);
            lastSnapshot = Date.now();
          } else {
            const page = await getConsoleEvents(sessionId, current.cursor, signal);
            if (page.snapshot) current = page.snapshot;
            else if (page.gap) current = await getConsoleSnapshot(sessionId, signal);
            else current = applyEvents(current, page.events, page.cursor);
          }
          if (signal.aborted) break;
          setSnapshot(current);
          setError((previous) => previous?.source === "poll" && previous.sessionId === sessionId ? null : previous);
        } catch (cause) {
          if (signal.aborted) break;
          setError({ sessionId, source: "poll", message: cause instanceof Error ? cause.message : String(cause) });
          current = null;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, current ? 350 : 1500);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
        await promise;
      }
    };
    void poll();
    return () => controller.abort();
  }, [sessionId, revision]);

  const refresh = () => {
    setRevision((value) => value + 1);
    void queryClient.invalidateQueries({ queryKey: ["console-sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["console-saved"] });
  };
  const perform = async <T,>(action: () => Promise<T>, owner = sessionId): Promise<T | undefined> => {
    const key = owner ?? "global";
    setPending((items) => [...items, key]);
    setError(null);
    try {
      const result = await action();
      refresh();
      return result;
    } catch (cause) {
      setError({ sessionId: owner, source: "action", message: cause instanceof Error ? cause.message : String(cause) });
      return undefined;
    } finally {
      setPending((items) => { const index = items.indexOf(key); return index < 0 ? items : items.filter((_, position) => position !== index); });
    }
  };
  const send = async (input: ConsoleMessageInput): Promise<boolean> => {
    if (!sessionId) return false;
    const submittedDraft = draft;
    const submittedKey = draftKey;
    const result = await perform(() => sendConsoleMessage(sessionId, input));
    if (!result) return false;
    setDrafts((previous) => previous[submittedKey] === submittedDraft ? { ...previous, [submittedKey]: "" } : previous);
    return true;
  };
  const create = (input: ConsoleCreateSessionInput) => perform(() => createConsoleSession(input), undefined);
  return {
    snapshot, sessionsLoaded: sessionsQuery.isSuccess, sessions: sessionsQuery.data ?? [], saved: savedQuery.data ?? [],
    loading: Boolean(sessionId && !snapshot && !(error && (!error.sessionId || error.sessionId === sessionId))),
    error: error && (error.source === "action" || !error.sessionId || error.sessionId === sessionId) ? error.message : (sessionsQuery.error ?? savedQuery.error)?.message,
    dismissError: () => setError(null),
    busy: pending.length > 0, draft,
    setDraft: (value: string) => setDrafts((previous) => ({ ...previous, [draftKey]: value })),
    setRootDraft: (value: string) => setDrafts((previous) => ({ ...previous, [`${sessionId ?? "new"}:root`]: value })),
    forgetDrafts: (id: string) => setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${id}:`)))),
    perform, send, create, refresh,
  };
}

