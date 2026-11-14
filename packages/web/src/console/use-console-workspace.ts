import { queryKeys } from "@/queries";
import { isRequestCancellation } from "@/lib/request-cancellation";
import { chatHostScopeKey } from "./chat-host";
import { remapSessionDrafts } from "./session-recovery";
import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConsoleCreateSessionInput,
  ConsoleMessageInput,
  ConsoleSavedSession,
  ConsoleSessionSnapshot,
  DesktopConsoleEvent,
  DesktopConsoleSession,
} from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import type { ModelsResponse } from "@/components/console-control/contracts";
import { isTransientMessage, isTransientNetworkError } from "@/lib/network-resilience";
import { needsModelSourceReconnect } from "./provider-error";
import { configureChatRuntime, usesLocalModels, localModelSourceHealthy } from "./model-source";
import { connectionVerified, errorProvider, type ConnectionRecovery } from "./connection-recovery";
import type { ComposerAttachment } from "./composer-attachments";
import { usePersistentState } from "@/lib/use-persistent-state";
import {
  ACTIVE_OPEN_WINDOW,
  hasOlderMessages,
  mergeWindowedSnapshot,
  MESSAGE_PAGE,
  OPEN_WINDOW,
  prependMessages,
  type WindowedSnapshot,
} from "./snapshot-window";
import { errorText } from "@/lib/api-error";
import { STORAGE_KEYS } from "@/lib/storage";
import {
  SNAPSHOT_CACHE_MS,
  SNAPSHOT_RESYNC_MS,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  POLL_RECOVER_MS,
  POLL_OFFSCREEN_MS,
  LONG_POLL_WAIT_S,
  LONG_POLL_MIN_HOLD_MS,
  LIST_STALE_MS,
  applyEvents,
  findingSignal,
  pollDelay,
  shouldResyncSnapshot,
  snapshotActive,
  waitForVisible,
} from "./workspace-events";
export { applyEvents, findingSignal, pollDelay, shouldResyncSnapshot, snapshotActive } from "./workspace-events";
import { SAVED_POLL_MS, sessionsRefetchInterval } from "./session-polling";
import { SAVED_OPEN_WINDOW, savedTranscriptSnapshot } from "./saved-snapshot";
import { rememberSessionAlias } from "./session-recovery";
import { resumeSavedOnce } from "@/lib/lazy-resume";

/** Host/account-scoped snapshots can be prefetched by history before navigation. */
export function consoleSnapshotKey(backendId: string, sessionId: string, workspaceId?: string, userId?: string) {
  return ["console-snapshot", chatHostScopeKey(backendId, workspaceId, userId), sessionId] as const;
}

export interface ConsoleWorkspace {
  snapshot: ConsoleSessionSnapshot | null;
  /** Older messages exist on the server beyond the loaded window. */
  hasEarlierMessages: boolean;
  loadingEarlier: boolean;
  loadEarlierMessages(): Promise<void>;
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
  readDraft(root?: boolean): string;
  setRootDraft(value: string): void;
  forgetDrafts(id: string): void;
  refresh(): void;
  perform<T>(action: () => Promise<T>, owner?: string): Promise<T | undefined>;
  send(input: ConsoleMessageInput): Promise<boolean>;
  create(input: ConsoleCreateSessionInput): Promise<DesktopConsoleSession | undefined>;
}
const quietTransient = (message: string | undefined) => (isTransientMessage(message) ? undefined : message);

export function useConsoleWorkspace(
  sessionId: string | undefined,
  workerId: string | null,
  /** `savedId` set: `sessionId` is that saved record, shown read-only from its transcript; the first send resumes it. */
  options: { visible?: boolean; savedId?: string } = {},
): ConsoleWorkspace {
  const savedId = options.savedId;
  const api = useBackendApi();
  const {
    client,
    createConsoleSession,
    getConsoleEvents,
    getConsoleSnapshot,
    getConsoleTools,
    getConsoleMessagesPage,
    getSavedTranscript,
    resumeConsoleSession,
    listConsoleSessions,
    listSavedConsoleSessions,
    sendConsoleMessage,
    webFetchJson,
  } = api;
  const queryClient = useQueryClient();
  const team = useTeamAccess();
  const canReloadConnection =
    client.backendId !== "local" || !team.enabled || Boolean(team.user && team.user.role !== "viewer");
  const sessionsQuery = useQuery({
    queryKey: queryKeys.consoleSessions(),
    queryFn: ({ signal }) => listConsoleSessions(signal),
    staleTime: LIST_STALE_MS,
    refetchInterval: sessionsRefetchInterval,
  });
  const savedQuery = useQuery({
    queryKey: queryKeys.consoleSaved(),
    queryFn: ({ signal }) => listSavedConsoleSessions(signal),
    staleTime: LIST_STALE_MS,
    refetchInterval: SAVED_POLL_MS,
  });
  const [storedDrafts, setDrafts, readDrafts] = usePersistentState<Record<string, string>>(
    STORAGE_KEYS.drafts,
    {},
    { observe: false },
  );
  const drafts = storedDrafts && typeof storedDrafts === "object" && !Array.isArray(storedDrafts) ? storedDrafts : {};
  const [attachmentDrafts, setAttachmentDrafts] = usePersistentState<Record<string, ComposerAttachment[]>>(
    STORAGE_KEYS.attachmentDrafts,
    {},
    { persist: false },
  );
  const snapshotKey = useMemo(
    () => consoleSnapshotKey(client.backendId, sessionId ?? "", team.user?.workspaceId, team.user?.userId),
    [client.backendId, sessionId, team.user?.workspaceId, team.user?.userId],
  );
  /** Window for an open: a running turn needs more of its delta events than an idle chat needs messages. */
  const openWindow = (current?: ConsoleSessionSnapshot | null) => {
    const status =
      current?.session.status ??
      queryClient.getQueryData<DesktopConsoleSession[]>(["console-sessions"])?.find((item) => item.id === sessionId)
        ?.status;
    return status && ["working", "waiting", "cancelling"].includes(status) ? ACTIVE_OPEN_WINDOW : OPEN_WINDOW;
  };
  /** One loader for every snapshot read: windowed on new servers, and earlier pages/windows survive a refetch. */
  const loadSnapshot = (signal: AbortSignal) =>
    (savedId
      ? queryClient
          .fetchQuery({
            queryKey: queryKeys.savedTranscript(client.backendId, savedId),
            queryFn: ({ signal: querySignal }) => getSavedTranscript(savedId, { window: SAVED_OPEN_WINDOW }, querySignal),
            staleTime: 30_000,
          })
          .then((page) => savedTranscriptSnapshot(savedId, page))
      : getConsoleSnapshot(
      sessionId!,
      signal,
      openWindow(queryClient.getQueryData<ConsoleSessionSnapshot>(snapshotKey)),
    )).then((fresh) => mergeWindowedSnapshot(queryClient.getQueryData<WindowedSnapshot>(snapshotKey), fresh));
  const snapshotQuery = useQuery({
    queryKey: snapshotKey,
    queryFn: ({ signal }) => loadSnapshot(signal),
    enabled: false,
    staleTime: 1000,
    gcTime: SNAPSHOT_CACHE_MS,
  });
  const [error, setError] = useState<{ sessionId?: string; message: string; source: "poll" | "action" } | null>(null);
  const [queuedShortcut, setQueuedShortcut] = useState<{ sessionId: string; id: string } | null>(null);
  const queuedDispatches = useRef(new Set<string>());
  const [queuedSendingId, setQueuedSendingId] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const draftKey = `${sessionId ?? "new"}:${workerId ?? "root"}`;
  const draft = typeof drafts[draftKey] === "string" ? drafts[draftKey] : "";
  const rawSnapshot = (
    snapshotQuery.data && snapshotQuery.data.session.id === sessionId ? snapshotQuery.data : null
  ) as WindowedSnapshot | null;
  // The tool catalog never changes within a session and is large: it loads after the first paint, off the critical path.
  const toolsQuery = useQuery({
    queryKey: queryKeys.consoleSessionTools(client.backendId, sessionId),
    enabled: Boolean(sessionId && rawSnapshot?.toolsOmitted),
    staleTime: Infinity,
    gcTime: SNAPSHOT_CACHE_MS,
    queryFn: async ({ signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      signal.throwIfAborted();
      return getConsoleTools(sessionId!, signal);
    },
  });
  const snapshot = useMemo(
    () => (rawSnapshot?.toolsOmitted && toolsQuery.data ? { ...rawSnapshot, tools: toolsQuery.data } : rawSnapshot),
    [rawSnapshot, toolsQuery.data],
  );
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadEarlierMessages = async () => {
    const first = rawSnapshot?.window?.firstMessageIndex;
    if (!sessionId || loadingEarlier || typeof first !== "number" || first <= 0) return;
    setLoadingEarlier(true);
    try {
      const page = savedId
        ? await getSavedTranscript(savedId, { before: first, limit: MESSAGE_PAGE })
        : await getConsoleMessagesPage(sessionId, first, MESSAGE_PAGE);
      queryClient.setQueryData<WindowedSnapshot>(snapshotKey, (previous) =>
        previous && previous.session.id === sessionId ? prependMessages(previous, page) : previous,
      );
    } catch (cause) {
      if (!isRequestCancellation(cause)) setError({ sessionId, source: "action", message: errorText(cause) });
    } finally {
      setLoadingEarlier(false);
    }
  };
  const [relayRecovered, setRelayRecovered] = useState<string[]>([]);
  const [relayReconnecting, setRelayReconnecting] = useState(false);
  const relayHistoryFailure = useMemo(() => {
    const event = snapshot?.events.findLast(
      (event) =>
        (event.type === "error" && needsModelSourceReconnect(event.message)) ||
        (event.type === "turn-complete" && event.error && needsModelSourceReconnect(event.error)),
    );
    if (event) return `${sessionId}:event:${event.sequence}`;
    return snapshot?.lastOutcome?.error && needsModelSourceReconnect(snapshot.lastOutcome.error)
      ? `${sessionId}:outcome:${snapshot.lastOutcome.error}`
      : null;
  }, [snapshot, sessionId]);
  const relayFailure =
    error?.source === "action" && needsModelSourceReconnect(error.message)
      ? `${sessionId}:action:${error.message}`
      : relayHistoryFailure;
  const reloadedFailure = useRef<string | null>(null);
  const providerFailure = useMemo(() => {
    const fallback = snapshot?.runtime?.providerId;
    const failures = (snapshot?.events ?? []).flatMap((event) => {
      const message = event.type === "error" ? event.message : event.type === "turn-complete" ? event.error : undefined;
      const providerId = message ? errorProvider(message, fallback) : undefined;
      return providerId ? [{ providerId, sequence: event.sequence }] : [];
    });
    const localProvider =
      error?.source === "action" && (!error.sessionId || error.sessionId === sessionId)
        ? errorProvider(error.message, fallback)
        : undefined;
    const retainedProvider = snapshot?.lastOutcome?.error
      ? errorProvider(snapshot.lastOutcome.error, fallback)
      : undefined;
    return localProvider
      ? { providerId: localProvider, sequence: `action:${error!.message}` }
      : (failures.at(-1) ??
          (retainedProvider
            ? { providerId: retainedProvider, sequence: `retained:${snapshot!.lastOutcome!.error}` }
            : undefined));
  }, [snapshot, error, sessionId]);
  const failureKey = providerFailure
    ? `${client.backendId}:${sessionId}:${providerFailure.providerId}:${providerFailure.sequence}`
    : null;
  const idle = !["working", "waiting", "cancelling"].includes(snapshot?.session.status ?? "");
  const connectionCheck = useQuery({
    queryKey: queryKeys.consoleConnectionHealth(
      client.backendId,
      sessionId,
      providerFailure?.providerId,
      providerFailure?.sequence,
    ),
    enabled: Boolean(providerFailure && idle),
    queryFn: async ({ signal }) => {
      const result = await webFetchJson<ModelsResponse>(
        `/api/console/models?providerId=${encodeURIComponent(providerFailure!.providerId)}`,
        { signal },
      );
      if (!connectionVerified(providerFailure!.providerId, result)) return false;
      // Reconnection is automatic at an idle boundary, never during a turn.
      if (sessionId && canReloadConnection && failureKey !== reloadedFailure.current) {
        await webFetchJson(`/api/console/sessions/${encodeURIComponent(sessionId)}/connection/reload`, {
          method: "POST",
          body: "{}",
          signal,
        });
        reloadedFailure.current = failureKey;
      }
      return true;
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => (query.state.data === true ? false : 10_000),
  });
  const relayCheck = useQuery({
    queryKey: queryKeys.consoleModelSourceHealth(client.backendId, sessionId, relayFailure),
    enabled: Boolean(
      relayFailure && sessionId && idle && client.backendId !== "local" && usesLocalModels(snapshot?.runtime),
    ),
    queryFn: ({ signal }) => localModelSourceHealthy(client.backendId, sessionId!, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => (query.state.data === true ? false : 10_000),
  });
  const healthy = connectionCheck.isSuccess && connectionCheck.data === true;
  useEffect(() => {
    if (!healthy || !providerFailure) return;
    setError((previous) =>
      previous?.source === "action" &&
      errorProvider(previous.message, providerFailure.providerId) === providerFailure.providerId
        ? null
        : previous,
    );
  }, [healthy, providerFailure?.providerId]);

  const visible = options.visible !== false;
  const visibleRef = useRef(visible);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    visibleRef.current = visible;
    if (visible) wake.current?.();
  }, [visible]);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let current = queryClient.getQueryData<ConsoleSessionSnapshot>(snapshotKey) ?? null;
    if (savedId) {
      // A retained transcript has no journal to follow: read it once (the sidebar may have prefetched it).
      queryClient
        .fetchQuery({ queryKey: snapshotKey, queryFn: ({ signal: querySignal }) => loadSnapshot(querySignal), staleTime: 0, gcTime: SNAPSHOT_CACHE_MS })
        .then(() => setError((previous) => (previous?.source === "poll" ? null : previous)))
        .catch((cause) => {
          if (!signal.aborted && !isRequestCancellation(cause)) setError({ sessionId, source: "poll", message: errorText(cause) });
        });
      return () => controller.abort();
    }
    const poll = async () => {
      // A cache-hydrated snapshot can be hours old: its dataUpdatedAt makes the first pass a full resync, never an events delta.
      let lastSnapshot = current ? (queryClient.getQueryState(snapshotKey)?.dataUpdatedAt ?? 0) : 0;
      // Unknown until a full snapshot lands in this loop, so the first resync-time check is never skipped.
      let snapshotCursor = -1;
      let needsSnapshot = queryClient.getQueryState(snapshotKey)?.isInvalidated === true;
      let longPollBroken = false;
      let heldTooBriefly = false;
      while (!signal.aborted) {
        // Hidden tabs do not poll; the first visible tick catches up from the cursor (or a gap snapshot).
        if (document.hidden) await waitForVisible(signal);
        if (signal.aborted) break;
        try {
          if (
            shouldResyncSnapshot({
              missing: !current,
              invalidated: needsSnapshot,
              age: Date.now() - lastSnapshot,
              active: snapshotActive(current),
              cursorMoved: (current?.cursor ?? -1) !== snapshotCursor,
            })
          ) {
            // fetchQuery also joins a history hover/focus prefetch already in flight.
            const fetched = await queryClient.fetchQuery({
              queryKey: snapshotKey,
              queryFn: ({ signal: querySignal }) => loadSnapshot(querySignal),
              staleTime: current ? 0 : 1000,
              gcTime: SNAPSHOT_CACHE_MS,
            });
            needsSnapshot = false;
            current = fetched;
            lastSnapshot = Date.now();
            snapshotCursor = fetched.cursor;
          } else if (current && Date.now() - lastSnapshot > SNAPSHOT_RESYNC_MS) {
            // Idle with an unchanged cursor: nothing to reconcile, so skip the full payload and reset the window.
            lastSnapshot = Date.now();
          } else {
            // Long-poll only against a server that windows snapshots (it also serves held events) and only for a chat on screen.
            const longPoll =
              !longPollBroken && visibleRef.current && (current as WindowedSnapshot).window !== undefined;
            const started = Date.now();
            let page: Awaited<ReturnType<typeof getConsoleEvents>>;
            try {
              page = await getConsoleEvents(
                sessionId,
                current!.cursor,
                signal,
                longPoll ? { wait: LONG_POLL_WAIT_S, resync: true } : {},
              );
            } catch (cause) {
              if (longPoll && !signal.aborted && !isTransientNetworkError(cause)) {
                longPollBroken = true;
                continue;
              }
              throw cause;
            }
            if (longPoll && page.events.length === 0 && !page.gap && Date.now() - started < LONG_POLL_MIN_HOLD_MS)
              heldTooBriefly = true;
            if (page.snapshot) {
              current = mergeWindowedSnapshot(current as WindowedSnapshot, page.snapshot as WindowedSnapshot);
              lastSnapshot = Date.now();
              snapshotCursor = current.cursor;
            } else if (page.gap) {
              current = await loadSnapshot(signal);
              lastSnapshot = Date.now();
              snapshotCursor = current.cursor;
            } else {
              current = applyEvents(current!, page.events, page.cursor);
              // A finished turn or a finding-related tool result may have changed the Findings count; no dashboard poll runs, so ask for it.
              if (page.events.some(findingSignal))
                void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard() });
            }
          }
          if (signal.aborted) break;
          const previousSession = queryClient.getQueryData<ConsoleSessionSnapshot>(snapshotKey)?.session;
          queryClient.setQueryData(snapshotKey, current);
          // Session events carry status/title changes: keep this row of the shared list current between its slower polls.
          if (current && previousSession && previousSession !== current.session) {
            const updated = current.session;
            queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], (list) =>
              list?.some((item) => item.id === updated.id)
                ? list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
                : list,
            );
          }
          setError((previous) => (previous?.source === "poll" && previous.sessionId === sessionId ? null : previous));
        } catch (cause) {
          if (signal.aborted) break;
          // A restart or dropped request keeps the last snapshot and retries quietly; only the global "Reconnecting…" line may appear.
          if (isTransientNetworkError(cause)) {
            needsSnapshot = true;
          } else setError({ sessionId, source: "poll", message: errorText(cause) });
          needsSnapshot = true;
        }
        // A held long-poll already waited for news: go straight back to it (never when the answer came back unheld).
        const delay =
          !needsSnapshot &&
          current &&
          (current as WindowedSnapshot).window !== undefined &&
          visibleRef.current &&
          !longPollBroken &&
          !heldTooBriefly
            ? 0
            : pollDelay({
                recovering: needsSnapshot || !current,
                active: snapshotActive(current),
                visible: visibleRef.current,
              });
        heldTooBriefly = false;
        const { promise, resolve } = Promise.withResolvers<void>();
        const finish = () => {
          clearTimeout(timer);
          wake.current = null;
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        wake.current = finish;
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
    void queryClient.invalidateQueries({ queryKey: queryKeys.consoleSessions() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.consoleSaved() });
  };
  const perform = async <T>(action: () => Promise<T>, owner = sessionId): Promise<T | undefined> => {
    const key = owner ?? "global";
    setPending((items) => [...items, key]);
    setError(null);
    try {
      const result = await action();
      refresh();
      return result;
    } catch (cause) {
      if (isRequestCancellation(cause)) return undefined;
      setError({ sessionId: owner, source: "action", message: errorText(cause) });
      return undefined;
    } finally {
      setPending((items) => {
        const index = items.indexOf(key);
        return index < 0 ? items : items.filter((_, position) => position !== index);
      });
    }
  };
  /** Resume the saved mission (once) and deliver the message to its live session; the saved id then aliases to it. */
  const resumeAndSend = (input: ConsoleMessageInput) => async () => {
    const session = await resumeSavedOnce({
      backendId: client.backendId,
      savedId: savedId!,
      roster: queryClient.getQueryData<DesktopConsoleSession[]>(["console-sessions"]),
      resume: async () => {
        const resumed = await resumeConsoleSession(savedId!, {});
        queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], (previous) => [
          ...(previous ?? []).filter((item) => item.id !== resumed.id),
          resumed,
        ]);
        void queryClient.invalidateQueries({ queryKey: queryKeys.consoleSaved() });
        return resumed;
      },
    });
    const result = await sendConsoleMessage(session.id, input);
    rememberSessionAlias(savedId!, session.id);
    return result;
  };
  const send = async (input: ConsoleMessageInput): Promise<boolean> => {
    if (!sessionId) return false;
    const submittedKey = `${sessionId}:${input.workerId ?? "root"}`;
    const currentDrafts = readDrafts() ?? {};
    const submittedDraft = typeof currentDrafts[submittedKey] === "string" ? currentDrafts[submittedKey] : "";
    const submittedAttachments = new Set(
      (attachmentDrafts[submittedKey] ?? [])
        .filter((item) => input.attachments?.some((value) => value.kind === item.kind && value.value === item.value))
        .map((item) => item.id),
    );
    const result = await perform(savedId ? resumeAndSend(input) : () => sendConsoleMessage(sessionId, input));
    if (!result) return false;
    const queuedMessageId = (result as { queuedMessageId?: string }).queuedMessageId;
    if (!input.workerId && input.mode === "queue" && queuedMessageId)
      setQueuedShortcut({ sessionId, id: queuedMessageId });
    setDrafts((previous) =>
      previous[submittedKey] === submittedDraft ? { ...previous, [submittedKey]: "" } : previous,
    );
    setAttachmentDrafts((previous) => ({
      ...previous,
      [submittedKey]: (previous[submittedKey] ?? []).filter((item) => !submittedAttachments.has(item.id)),
    }));
    return true;
  };
  const sendQueuedNow = async (id: string): Promise<boolean> => {
    if (!sessionId || queuedDispatches.current.has(`${sessionId}:${id}`)) return false;
    const key = `${sessionId}:${id}`;
    queuedDispatches.current.add(key);
    setQueuedSendingId(id);
    setQueuedShortcut(null);
    const result = await perform(async () => {
      await webFetchJson(
        `/api/console/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}/send`,
        { method: "POST", body: "{}" },
      );
      return true;
    });
    if (!result) queuedDispatches.current.delete(key);
    setQueuedSendingId((current) => (current === id ? null : current));
    return Boolean(result);
  };
  const reconnectModelSource = async (): Promise<boolean> => {
    if (
      !sessionId ||
      !snapshot?.runtime ||
      !usesLocalModels(snapshot.runtime) ||
      client.backendId === "local" ||
      (team.enabled && team.user?.role === "viewer") ||
      relayReconnecting
    )
      return false;
    setRelayReconnecting(true);
    const failure = relayFailure;
    try {
      const runtime = snapshot.runtime;
      const result = await perform(async () => {
        await configureChatRuntime(
          api,
          sessionId,
          {
            providerId: runtime.providerId,
            model: runtime.model,
            agentModels: runtime.agentModels,
            singleModel: runtime.singleModel,
            autoRoute: runtime.autoRoute,
            ...(runtime.reasoning?.effort ? { reasoningEffort: runtime.reasoning.effort } : {}),
            ...(runtime.accessProgram ? { cyberAccessProgram: runtime.accessProgram.requested } : {}),
          },
          runtime,
        );
        setRelayRecovered([failure, relayHistoryFailure].filter((value): value is string => Boolean(value)));
        return true;
      });
      return result === true;
    } finally {
      setRelayReconnecting(false);
    }
  };
  const create = (input: ConsoleCreateSessionInput) => perform(() => createConsoleSession(input), undefined);
  return {
    snapshot,
    hasEarlierMessages: hasOlderMessages(rawSnapshot),
    loadingEarlier,
    loadEarlierMessages,
    sessionsLoaded: sessionsQuery.isSuccess,
    savedLoaded: savedQuery.isSuccess,
    sessions: sessionsQuery.data ?? [],
    saved: savedQuery.data ?? [],
    loading: Boolean(sessionId && !snapshot && !(error && (!error.sessionId || error.sessionId === sessionId))),
    error:
      error && (error.source === "action" || !error.sessionId || error.sessionId === sessionId)
        ? error.message
        : quietTransient((sessionsQuery.error ?? savedQuery.error)?.message),
    modelSourceRecovery: relayFailure
      ? {
          healthy: relayRecovered.includes(relayFailure) || relayCheck.data === true,
          checking: relayReconnecting || relayCheck.isFetching,
        }
      : undefined,
    reconnectModelSource,
    connectionRecovery: providerFailure
      ? { providerId: providerFailure.providerId, healthy, checking: connectionCheck.isFetching }
      : undefined,
    dismissError: () => setError(null),
    busy: pending.length > 0,
    draft,
    queuedSendingId,
    sendQueuedNow,
    queuedShortcutId: queuedShortcut && queuedShortcut.sessionId === sessionId ? queuedShortcut.id : null,
    dismissQueuedShortcut: () => setQueuedShortcut(null),
    attachments: attachmentDrafts[draftKey] ?? [],
    rootAttachments: attachmentDrafts[`${sessionId ?? "new"}:root`] ?? [],
    setRootAttachments: (update) =>
      setAttachmentDrafts((previous) => {
        const key = `${sessionId ?? "new"}:root`;
        return { ...previous, [key]: update(previous[key] ?? []) };
      }),
    setAttachments: (update) =>
      setAttachmentDrafts((previous) => ({ ...previous, [draftKey]: update(previous[draftKey] ?? []) })),
    rootDraft: typeof drafts[`${sessionId ?? "new"}:root`] === "string" ? drafts[`${sessionId ?? "new"}:root`]! : "",
    readDraft: (root = false) => {
      const current = readDrafts() ?? {};
      const key = root ? `${sessionId ?? "new"}:root` : draftKey;
      return typeof current[key] === "string" ? current[key] : "";
    },
    setDraft: (value: string) => setDrafts((previous) => ({ ...previous, [draftKey]: value })),
    setRootDraft: (value: string) => setDrafts((previous) => ({ ...previous, [`${sessionId ?? "new"}:root`]: value })),
    remapDrafts: (from, to) => {
      setDrafts((previous) => remapSessionDrafts(previous, from, to));
      setAttachmentDrafts((previous) => remapSessionDrafts(previous, from, to));
    },
    forgetDrafts: (id: string) => {
      setDrafts((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${id}:`))),
      );
      setAttachmentDrafts((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${id}:`))),
      );
    },
    perform,
    send,
    create,
    refresh,
  };
}
