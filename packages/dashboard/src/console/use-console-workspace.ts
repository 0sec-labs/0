import { isRequestCancellation } from "@/lib/request-cancellation";
import { chatHostScopeKey } from "./chat-host";
import { remapSessionDrafts } from "./session-recovery";
import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsoleCreateSessionInput, ConsoleMessageInput, ConsoleSavedSession, ConsoleSessionSnapshot, DesktopConsoleEvent, DesktopConsoleSession } from "@0/shared";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import type { ModelsResponse } from "@/components/console-control/contracts";
import { needsModelSourceReconnect } from "./provider-error";
import { configureChatRuntime, usesLocalModels, localModelSourceHealthy } from "./model-source";
import { connectionVerified, errorProvider, type ConnectionRecovery } from "./connection-recovery";
import type { ComposerAttachment } from "./composer-attachments";
import { usePersistentState } from "@/lib/use-persistent-state";

/** Host/account-scoped snapshots can be prefetched by history before navigation. */
export function consoleSnapshotKey(backendId: string, sessionId: string, workspaceId?: string, userId?: string) {
  return ["console-snapshot", chatHostScopeKey(backendId, workspaceId, userId), sessionId] as const;
}
const SNAPSHOT_CACHE_MS = 5 * 60_000;
const SNAPSHOT_RESYNC_MS = 15_000;

export interface ConsoleWorkspace {
  snapshot: ConsoleSessionSnapshot | null;
  sessions: DesktopConsoleSession[];
  sessionsLoaded: boolean;
  savedLoaded: boolean;
  remapDrafts(from: string, to: string): void;
  saved: ConsoleSavedSession[];
  loading: boolean;
  error: string | undefined;
  connectionRecovery?: ConnectionRecovery;
  modelSourceRecovery?: { healthy: boolean; checking: boolean };
  reconnectModelSource?(): Promise<boolean>;
  busy: boolean;
  queuedSendingId: string | null;
  queuedShortcutId: string | null;
  dismissQueuedShortcut(): void;
  sendQueuedNow(id: string): Promise<boolean>;
  draft: string;
  rootDraft: string;
  attachments: ComposerAttachment[];
  rootAttachments: ComposerAttachment[];
  setRootAttachments(update: (previous: ComposerAttachment[]) => ComposerAttachment[]): void;
  setAttachments(update: (previous: ComposerAttachment[]) => ComposerAttachment[]): void;
  dismissError(): void;
  setDraft(value: string): void;
  setRootDraft(value: string): void;
  forgetDrafts(id: string): void;
  refresh(): void;
  perform<T>(action: () => Promise<T>, owner?: string): Promise<T | undefined>;
  send(input: ConsoleMessageInput): Promise<boolean>;
  create(input: ConsoleCreateSessionInput): Promise<DesktopConsoleSession | undefined>;
}

export function applyEvents(snapshot: ConsoleSessionSnapshot, events: DesktopConsoleEvent[], cursor: number): ConsoleSessionSnapshot {
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
      next = { ...next, messages: [], queuedMessages: [], pendingDecisions: [], lastOutcome: null, objective: "", todos: null };
    }
    retained.set(event.sequence, event);
    switch (event.type) {
      case "user": next = { ...next, lastOutcome: null, stagedPrompt: undefined }; break;
      case "session": next = { ...next, session: event.session, execution: event.session.execution ?? next.execution, title: event.session.title ?? next.title }; break;
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
  const api = useBackendApi();
  const { client, createConsoleSession, getConsoleEvents, getConsoleSnapshot, listConsoleSessions, listSavedConsoleSessions, sendConsoleMessage, webFetchJson } = api;
  const queryClient = useQueryClient();
  const team = useTeamAccess();
  const canReloadConnection = client.backendId !== "local" || !team.enabled || Boolean(team.user && team.user.role !== "viewer");
  const sessionsQuery = useQuery({ queryKey: ["console-sessions"], queryFn: ({ signal }) => listConsoleSessions(signal), refetchInterval: 2000 });
  const savedQuery = useQuery({ queryKey: ["console-saved"], queryFn: ({ signal }) => listSavedConsoleSessions(signal), refetchInterval: 5000 });
  const [storedDrafts, setDrafts] = usePersistentState<Record<string, string>>("0-console-drafts", {});
  const drafts = storedDrafts && typeof storedDrafts === "object" && !Array.isArray(storedDrafts) ? storedDrafts : {};
  const [attachmentDrafts, setAttachmentDrafts] = usePersistentState<Record<string, ComposerAttachment[]>>("0-console-attachment-drafts", {}, { persist: false });
  const snapshotKey = useMemo(() => consoleSnapshotKey(client.backendId, sessionId ?? "", team.user?.workspaceId, team.user?.userId), [client.backendId, sessionId, team.user?.workspaceId, team.user?.userId]);
  const snapshotQuery = useQuery({
    queryKey: snapshotKey, queryFn: ({ signal }) => getConsoleSnapshot(sessionId!, signal),
    enabled: false, staleTime: 1000, gcTime: SNAPSHOT_CACHE_MS,
  });
  const [error, setError] = useState<{ sessionId?: string; message: string; source: "poll" | "action" } | null>(null);
  const [queuedShortcut, setQueuedShortcut] = useState<{ sessionId: string; id: string } | null>(null);
  const queuedDispatches = useRef(new Set<string>());
  const [queuedSendingId, setQueuedSendingId] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const draftKey = `${sessionId ?? "new"}:${workerId ?? "root"}`;
  const draft = typeof drafts[draftKey] === "string" ? drafts[draftKey] : "";
  const snapshot = snapshotQuery.data && snapshotQuery.data.session.id === sessionId ? snapshotQuery.data : null;
  const [relayRecovered, setRelayRecovered] = useState<string[]>([]);
  const [relayReconnecting, setRelayReconnecting] = useState(false);
  const relayHistoryFailure = useMemo(() => {
    const event = snapshot?.events.findLast(event => (event.type === "error" && needsModelSourceReconnect(event.message)) || (event.type === "turn-complete" && event.error && needsModelSourceReconnect(event.error)));
    if (event) return `${sessionId}:event:${event.sequence}`;
    return snapshot?.lastOutcome?.error && needsModelSourceReconnect(snapshot.lastOutcome.error) ? `${sessionId}:outcome:${snapshot.lastOutcome.error}` : null;
  }, [snapshot, sessionId]);
  const relayFailure = error?.source === "action" && needsModelSourceReconnect(error.message) ? `${sessionId}:action:${error.message}` : relayHistoryFailure;
  const reloadedFailure = useRef<string | null>(null);
  const providerFailure = useMemo(() => {
    const fallback = snapshot?.runtime?.providerId;
    const failures = (snapshot?.events ?? []).flatMap(event => {
      const message = event.type === "error" ? event.message : event.type === "turn-complete" ? event.error : undefined;
      const providerId = message ? errorProvider(message, fallback) : undefined;
      return providerId ? [{ providerId, sequence: event.sequence }] : [];
    });
    const localProvider = error?.source === "action" && (!error.sessionId || error.sessionId === sessionId) ? errorProvider(error.message, fallback) : undefined;
    const retainedProvider = snapshot?.lastOutcome?.error ? errorProvider(snapshot.lastOutcome.error, fallback) : undefined;
    return localProvider ? { providerId: localProvider, sequence: `action:${error!.message}` } : failures.at(-1) ?? (retainedProvider ? { providerId: retainedProvider, sequence: `retained:${snapshot!.lastOutcome!.error}` } : undefined);
  }, [snapshot, error, sessionId]);
  const failureKey = providerFailure ? `${client.backendId}:${sessionId}:${providerFailure.providerId}:${providerFailure.sequence}` : null;
  const idle = !["working", "waiting"].includes(snapshot?.session.status ?? "");
  const connectionCheck = useQuery({
    queryKey: ["console-connection-health", client.backendId, sessionId, providerFailure?.providerId, providerFailure?.sequence],
    enabled: Boolean(providerFailure && idle),
    queryFn: async ({ signal }) => {
      const result = await webFetchJson<ModelsResponse>(`/api/console/models?providerId=${encodeURIComponent(providerFailure!.providerId)}`, { signal });
      if (!connectionVerified(providerFailure!.providerId, result)) return false;
      // Reconnection is automatic at an idle boundary, never during a turn.
      if (sessionId && canReloadConnection && failureKey !== reloadedFailure.current) {
        await webFetchJson(`/api/console/sessions/${encodeURIComponent(sessionId)}/connection/reload`, { method: "POST", body: "{}", signal });
        reloadedFailure.current = failureKey;
      }
      return true;
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: query => query.state.data === true ? false : 10_000,
  });
  const relayCheck = useQuery({
    queryKey: ["console-model-source-health", client.backendId, sessionId, relayFailure],
    enabled: Boolean(relayFailure && sessionId && idle && client.backendId !== "local" && usesLocalModels(snapshot?.runtime)),
    queryFn: ({ signal }) => localModelSourceHealthy(client.backendId, sessionId!, signal),
    retry: false, staleTime: 0, refetchOnWindowFocus: "always",
    refetchInterval: query => query.state.data === true ? false : 10_000,
  });
  const healthy = connectionCheck.isSuccess && connectionCheck.data === true;
  useEffect(() => {
    if (!healthy || !providerFailure) return;
    setError(previous => previous?.source === "action" && errorProvider(previous.message, providerFailure.providerId) === providerFailure.providerId ? null : previous);
  }, [healthy, providerFailure?.providerId]);


  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let current = queryClient.getQueryData<ConsoleSessionSnapshot>(snapshotKey) ?? null;
    const poll = async () => {
      let lastSnapshot = current ? Date.now() : 0;
      let needsSnapshot = queryClient.getQueryState(snapshotKey)?.isInvalidated === true;
      while (!signal.aborted) {
        try {
          if (!current || needsSnapshot || Date.now() - lastSnapshot > SNAPSHOT_RESYNC_MS) {
            // fetchQuery also joins a history hover/focus prefetch already in flight.
            current = await queryClient.fetchQuery({ queryKey: snapshotKey, queryFn: ({ signal: querySignal }) => getConsoleSnapshot(sessionId, querySignal), staleTime: current ? 0 : 1000, gcTime: SNAPSHOT_CACHE_MS });
            needsSnapshot = false;
            lastSnapshot = Date.now();
          } else {
            const page = await getConsoleEvents(sessionId, current.cursor, signal);
            if (page.snapshot) { current = page.snapshot; lastSnapshot = Date.now(); }
            else if (page.gap) { current = await getConsoleSnapshot(sessionId, signal); lastSnapshot = Date.now(); }
            else current = applyEvents(current, page.events, page.cursor);
          }
          if (signal.aborted) break;
          queryClient.setQueryData(snapshotKey, current);
          setError((previous) => previous?.source === "poll" && previous.sessionId === sessionId ? null : previous);
        } catch (cause) {
          if (signal.aborted) break;
          setError({ sessionId, source: "poll", message: cause instanceof Error ? cause.message : String(cause) });
          needsSnapshot = true;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, needsSnapshot || !current ? 1500 : 350);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
        await promise;
      }
    };
    void poll();
    return () => controller.abort();
  }, [sessionId, revision, snapshotKey, queryClient]);

  const refresh = () => {
    if (sessionId) void queryClient.invalidateQueries({ queryKey: snapshotKey, exact: true, refetchType: "none" });
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
      if (isRequestCancellation(cause)) return undefined;
      setError({ sessionId: owner, source: "action", message: cause instanceof Error ? cause.message : String(cause) });
      return undefined;
    } finally {
      setPending((items) => { const index = items.indexOf(key); return index < 0 ? items : items.filter((_, position) => position !== index); });
    }
  };
  const send = async (input: ConsoleMessageInput): Promise<boolean> => {
    if (!sessionId) return false;
    const submittedKey = `${sessionId}:${input.workerId ?? "root"}`;
    const submittedDraft = typeof drafts[submittedKey] === "string" ? drafts[submittedKey] : "";
    const submittedAttachments = new Set((attachmentDrafts[submittedKey] ?? []).filter(item => input.attachments?.some(value => value.kind === item.kind && value.value === item.value)).map(item => item.id));
    const result = await perform(() => sendConsoleMessage(sessionId, input));
    if (!result) return false;
    const queuedMessageId = (result as { queuedMessageId?: string }).queuedMessageId;
    if (!input.workerId && input.mode === "queue" && queuedMessageId) setQueuedShortcut({ sessionId, id: queuedMessageId });
    setDrafts((previous) => previous[submittedKey] === submittedDraft ? { ...previous, [submittedKey]: "" } : previous);
    setAttachmentDrafts(previous => ({ ...previous, [submittedKey]: (previous[submittedKey] ?? []).filter(item => !submittedAttachments.has(item.id)) }));
    return true;
  };
  const sendQueuedNow = async (id: string): Promise<boolean> => {
    if (!sessionId || queuedDispatches.current.has(`${sessionId}:${id}`)) return false;
    const key = `${sessionId}:${id}`;
    queuedDispatches.current.add(key); setQueuedSendingId(id);
    setQueuedShortcut(null);
    const result = await perform(async () => {
      await webFetchJson(`/api/console/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}/send`, { method: "POST", body: "{}" });
      return true;
    });
    if (!result) queuedDispatches.current.delete(key);
    setQueuedSendingId(current => current === id ? null : current);
    return Boolean(result);
  };
  const reconnectModelSource = async (): Promise<boolean> => {
    if (!sessionId || !snapshot?.runtime || !usesLocalModels(snapshot.runtime) || client.backendId === "local" || team.enabled && team.user?.role === "viewer" || relayReconnecting) return false;
    setRelayReconnecting(true);
    const failure = relayFailure;
    try {
      const runtime = snapshot.runtime;
      const result = await perform(async () => {
        await configureChatRuntime(api, sessionId, { providerId: runtime.providerId, model: runtime.model, agentModels: runtime.agentModels, singleModel: runtime.singleModel, autoRoute: runtime.autoRoute, ...(runtime.reasoning?.effort ? { reasoningEffort: runtime.reasoning.effort } : {}) }, runtime);
        setRelayRecovered([failure, relayHistoryFailure].filter((value): value is string => Boolean(value)));
        return true;
      });
      return result === true;
    } finally { setRelayReconnecting(false); }
  };
  const create = (input: ConsoleCreateSessionInput) => perform(() => createConsoleSession(input), undefined);
  return {
    snapshot, sessionsLoaded: sessionsQuery.isSuccess, savedLoaded: savedQuery.isSuccess, sessions: sessionsQuery.data ?? [], saved: savedQuery.data ?? [],
    loading: Boolean(sessionId && !snapshot && !(error && (!error.sessionId || error.sessionId === sessionId))),
    error: error && (error.source === "action" || !error.sessionId || error.sessionId === sessionId) ? error.message : (sessionsQuery.error ?? savedQuery.error)?.message,
    modelSourceRecovery: relayFailure ? { healthy: relayRecovered.includes(relayFailure) || relayCheck.data === true, checking: relayReconnecting || relayCheck.isFetching } : undefined,
    reconnectModelSource,
    connectionRecovery: providerFailure ? { providerId: providerFailure.providerId, healthy, checking: connectionCheck.isFetching } : undefined,
    dismissError: () => setError(null),
    busy: pending.length > 0, draft, queuedSendingId, sendQueuedNow,
    queuedShortcutId: queuedShortcut && queuedShortcut.sessionId === sessionId ? queuedShortcut.id : null,
    dismissQueuedShortcut: () => setQueuedShortcut(null),
    attachments: attachmentDrafts[draftKey] ?? [],
    rootAttachments: attachmentDrafts[`${sessionId ?? "new"}:root`] ?? [],
    setRootAttachments: update => setAttachmentDrafts(previous => {
      const key = `${sessionId ?? "new"}:root`;
      return { ...previous, [key]: update(previous[key] ?? []) };
    }),
    setAttachments: update => setAttachmentDrafts(previous => ({ ...previous, [draftKey]: update(previous[draftKey] ?? []) })),
    rootDraft: typeof drafts[`${sessionId ?? "new"}:root`] === "string" ? drafts[`${sessionId ?? "new"}:root`]! : "",
    setDraft: (value: string) => setDrafts((previous) => ({ ...previous, [draftKey]: value })),
    setRootDraft: (value: string) => setDrafts((previous) => ({ ...previous, [`${sessionId ?? "new"}:root`]: value })),
    remapDrafts: (from, to) => {
      setDrafts(previous => remapSessionDrafts(previous, from, to));
      setAttachmentDrafts(previous => remapSessionDrafts(previous, from, to));
    },
    forgetDrafts: (id: string) => {
      setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${id}:`))));
      setAttachmentDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${id}:`))));
    },
    perform, send, create, refresh,
  };
}
