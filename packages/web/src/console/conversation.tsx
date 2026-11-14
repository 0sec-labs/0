import { useNow } from "@/ui/lib/use-now";
import { queueComposerPrefill } from "@/lib/composer-prefill";
import { queryKeys } from "@/queries";
import { VOCAB, v } from "@/lib/vocabulary";
import { DitherBackdrop } from "@/ui/components/dither-backdrop";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { consoleErrorMessage } from "./provider-error";
import { readLastModelChoice, rememberModelChoice, usableModelChoice } from "@/lib/last-model-choice";
import { isTypingTarget, matchShortcut, shortcutHint } from "@/lib/shortcuts";
import { curateSlashCommands, modelButtonLabel } from "./composer-model";
import { useReconnecting } from "@/lib/network-resilience";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Box,
  Menu,
  Monitor,
  ChevronDown,
  Plus,
  FolderSearch,
  ListChecks,
  Paperclip,
  ShieldCheck,
  Terminal,
  Users,
  Wrench,
  Square,
} from "lucide-react";
import { Popover } from "@/ui/components/popover";
import type {
  ConsoleMessageInput,
  ConsoleSessionSnapshot,
  ConsoleWorker,
  DesktopConsoleDecisionResponse,
} from "@0/engine/shared";
import { SLASH_COMMANDS } from "@0/engine/dist/shared/slash-commands.js";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useMobileSidebar } from "@/ui/components/sidebar";
import { ModelIcon, ProviderIcon } from "@/components/provider-icon";
import { ModelCatalog } from "@/components/model-picker";
import { AccessProgramPicker } from "./access-program-picker";
import { ReasoningPicker } from "./reasoning-picker";
import { BackendConnectionPicker } from "@/components/backend-connection-picker";
import { FilePathPicker } from "./file-path-picker";
import { QueuedMessages } from "./queued-messages";
import { ModePicker } from "./mode-picker";
type SendBehavior = "queue" | "steer";
import { AgentOnboarding } from "./agent-onboarding";
import { useQuery } from "@tanstack/react-query";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { createBackendApi, useBackendApi } from "@/api";
import { configureChatRuntime, modelCatalogOwner, usesLocalModels } from "./model-source";
import { useModelCatalog } from "./use-model-catalog";
import { backendRouteHref } from "./chat-host";
import { useTeamAccess } from "@/components/team-access";
import { ComposerPickerSurface, IntegrationPicker, useIntegrationPicker } from "./integration-picker";
import { ActivityMark, ConversationSkeleton, LoadingDots } from "./loading-state";
import { ApprovalPanel } from "./approvals";
import { homeSuggestions, selectedWorkspacePath } from "./home-context";
import type { ProjectResponse } from "@/components/console-control/contracts";
import { TranscriptTurns, useTranscriptControls } from "./transcript-turns";
import { visibleTurns } from "./transcript-visibility";
import { ContextPopover } from "./context-popover";
import { ForceStopControl } from "./force-stop-control";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useComposerAutosize } from "./use-composer-autosize";
import { useComposerAttachments } from "./composer-attachments";
import { workersForTurn } from "./worker-turns";
import { reduceConversation } from "./transcript";
import { runFeedback } from "./run-feedback";
import { TaskProgress } from "./task-progress";
import type { ConsoleWorkspace } from "./use-console-workspace";
import { errorText } from "@/lib/api-error";
import { STORAGE_KEYS } from "@/lib/storage";

export function Conversation({
  emptyState,
  composerPlaceholder,
  workspace,
  worker,
  onResolve,
  onSubmit,
  onStop,
  resumeCap,
  sendBehavior,
  agentsOpen = false,
  onCloseAgents,
  onSelectWorker,
  onOpenDetails,
  onDrainAgents,
  onSubmitRoot,
  onStopRoot,
}: {
  /** @deprecated Ignored; the composer owns the context popover. */
  detailsControl?: ReactNode;
  emptyState?: ReactNode;
  composerPlaceholder?: string;
  onSubmitRoot: () => void;
  onStopRoot: () => void;
  onOpenDetails?: () => void;
  onDrainAgents?: () => void;
  agentsOpen?: boolean;
  onCloseAgents?: () => void;
  onSelectWorker: (id: string | null) => void;
  workspace: ConsoleWorkspace;
  worker: ConsoleWorker | undefined;
  onResolve: (decisionId: string, response: DesktopConsoleDecisionResponse) => void;
  onSubmit: () => void;
  onStop: () => void;
  resumeCap: () => void;
  sendBehavior: SendBehavior;
}) {
  const snapshot = workspace.snapshot;
  const transcriptControls = useTranscriptControls(workspace, onResolve, onSelectWorker);
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  // Stable identity keeps memoized turns from re-rendering on every keystroke.
  const referenceVisual = useCallback((text: string) => {
    const { readDraft, setRootDraft } = latestWorkspace.current;
    const current = readDraft(true);
    setRootDraft(current && !current.endsWith("\n") ? `${current}\n${text}` : current + text);
  }, []);
  // Retry re-sends the failed turn's message through the same send path as the composer.
  const retryMessage = useCallback((message: { text: string; attachments?: ConsoleMessageInput["attachments"] }) => {
    void latestWorkspace.current.send({
      text: message.text,
      mode: "send",
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    });
  }, []);
  const rootWorkspace = {
    ...workspace,
    draft: workspace.rootDraft,
    attachments: workspace.rootAttachments,
    setDraft: workspace.setRootDraft,
    setAttachments: workspace.setRootAttachments,
  };
  const team = useTeamAccess();
  const { client } = useBackendApi();
  const teamEnabled = team.enabled && client.backendId === "local";
  const canWrite = !teamEnabled || Boolean(team.user && team.user.role !== "viewer");
  const turns = useMemo(() => (snapshot ? visibleTurns(reduceConversation(snapshot)) : []), [snapshot]);
  const turnWorkers = useMemo(
    () => (snapshot ? workersForTurn(snapshot, turns) : new Map<string, ConsoleWorker[]>()),
    [snapshot, turns],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const messageCount = snapshot?.messages.length ?? 0;
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const seenMessages = useRef(0);
  const [scrolled, setScrolled] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const [visibleTurn, setVisibleTurn] = useState<string | null>(null);
  const updateVisibleTurn = () => {
    const viewport = scroller.current;
    if (!viewport) return;
    const anchor = viewport.getBoundingClientRect().top + Math.min(140, viewport.clientHeight * 0.25);
    const articles = Array.from(viewport.querySelectorAll<HTMLElement>("article[data-chat-turn]"));
    const current =
      articles.find((article) => {
        const rect = article.getBoundingClientRect();
        return rect.top <= anchor && rect.bottom > anchor;
      }) ??
      articles.find((article) => article.getBoundingClientRect().top > anchor) ??
      articles.at(-1);
    if (current) setVisibleTurn(current.dataset.chatTurn ?? null);
  };
  const conversationKey = snapshot?.session.id ?? "root";
  useEffect(() => {
    const delta = messageCount - seenMessages.current;
    seenMessages.current = messageCount;
    if (delta > 0 && !nearBottom.current) setUnseen((count) => count + delta);
  }, [messageCount]);
  useLayoutEffect(() => {
    nearBottom.current = true;
    setShowJump(false);
    setUnseen(0);
    const node = scroller.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
      updateVisibleTurn();
    }
  }, [conversationKey, turns.length === 0]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const viewport = scroller.current;
      if (!viewport) return;
      if (nearBottom.current) viewport.scrollTop = viewport.scrollHeight;
      else setShowJump(true);
      updateVisibleTurn();
      setMoreBelow(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8);
    });
    observer.observe(node);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [conversationKey, turns.length === 0]);
  const mobileSidebar = useMobileSidebar();
  if (!snapshot) return workspace.loading ? <ConversationSkeleton /> : null;

  const active = ["working", "waiting", "cancelling"].includes(snapshot.session.status);
  const empty =
    !worker && turns.length === 0 && snapshot.pendingDecisions.length === 0 && snapshot.queuedMessages.length === 0;
  if (empty && emptyState)
    return (
      <div className="flex min-h-0 flex-1 flex-col" aria-label={v("Editor {mission}")}>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">{emptyState}</div>
        <Composer
          onOpenAgents={() => onSelectWorker(null)}
          placeholder={composerPlaceholder}
          canWrite={canWrite}
          sendBehavior={sendBehavior}
          workspace={rootWorkspace}
          snapshot={snapshot}
          onSubmit={onSubmitRoot}
          onStop={onStopRoot}
        />
      </div>
    );
  if (empty)
    return (
      <div className="relative min-h-0 flex-1" aria-label="Home">
        <DitherBackdrop />
        {mobileSidebar && (
          <div className="absolute top-2 left-2 z-10 lg:hidden">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open navigation"
              aria-haspopup="dialog"
              onClick={() => mobileSidebar.setOpen(true)}
            >
              <Menu className="size-4" />
            </Button>
          </div>
        )}
        <div className="relative h-full overflow-y-auto overscroll-contain">
          <section className="relative flex min-h-full items-center justify-center px-6">
            <div className="relative flex w-full max-w-[712px] flex-col pb-[10dvh]">
              <Composer
                home
                onOpenAgents={() => onSelectWorker(null)}
                placeholder={composerPlaceholder}
                canWrite={canWrite}
                sendBehavior={sendBehavior}
                workspace={rootWorkspace}
                snapshot={snapshot}
                onSubmit={onSubmitRoot}
                onStop={onStopRoot}
              />
              <ContextSuggestions
                lead={<AgentOnboarding />}
                snapshot={snapshot}
                onChoose={queueComposerPrefill}
              />
            </div>
          </section>
        </div>
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div
        className={`console-chat-column relative flex min-h-0 min-w-0 flex-1 flex-col ${empty ? "justify-center pb-20" : ""}`}
      >
        <div
          ref={scroller}
          data-scrolled={scrolled}
          data-more-below={moreBelow}
          className={`console-transcript-scroller scroll-fade-y min-h-0 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 ${empty ? "flex-none" : "flex-1"}`}
          onScroll={() => {
            const node = scroller.current;
            if (!node) return;
            updateVisibleTurn();
            setScrolled(node.scrollTop > 8);
            setMoreBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 8);
            nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
            const away = !nearBottom.current && node.scrollHeight > node.clientHeight + 240;
            setShowJump(away);
            if (nearBottom.current) setUnseen(0);
          }}
          aria-label="Conversation"
        >
          <div className="mx-auto grid w-full max-w-[864px] grid-cols-[minmax(0,1fr)] gap-6">
            <div ref={content} className="min-w-0 space-y-10">
              {workspace.hasEarlierMessages && !worker && (
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={workspace.loadingEarlier}
                    onClick={() => {
                      const node = scroller.current;
                      const before = node ? node.scrollHeight - node.scrollTop : 0;
                      // Keep the reader's place: the new rows land above the viewport.
                      void workspace.loadEarlierMessages().then(() =>
                        requestAnimationFrame(() => {
                          if (node) node.scrollTop = node.scrollHeight - before;
                        }),
                      );
                    }}
                  >
                    {workspace.loadingEarlier ? "Loading…" : "Load earlier messages"}
                  </Button>
                </div>
              )}
              <TranscriptTurns
                turns={turns}
                turnWorkers={turnWorkers}
                snapshot={snapshot}
                canWrite={canWrite}
                {...transcriptControls}
                onReference={referenceVisual}
                onRetry={retryMessage}
              />
              {snapshot.lastOutcome?.outputCap && !worker && (
                <div
                  role="status"
                  className="rounded-[var(--radius-panel)] border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
                >
                  <div className="font-medium">0 hit its output limit</div>
                  <Button
                    className="mt-3"
                    size="sm"
                    disabled={workspace.busy || active || !canWrite}
                    onClick={resumeCap}
                  >
                    Keep going
                  </Button>
                </div>
              )}
              <QueuedMessages inline workspace={rootWorkspace} snapshot={snapshot} />
              {snapshot.pendingDecisions.map((decision) => (
                <div key={decision.id}>
                  <ApprovalPanel
                    decision={decision}
                    busy={workspace.busy || !canWrite}
                    onResolve={(response) => onResolve(decision.id, response)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        {turns.length > 2 && (
          <nav
            aria-label="Turn navigation"
            className="absolute left-0 top-1/2 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col overflow-visible py-3 sm:flex"
          >
            {turns.map((turn, index) => (
              <Tooltip
                key={turn.id}
                preview
                delay={0}
                side="right"
                content={
                  <span className="block w-72 max-w-[75vw] text-left leading-[18px]">
                    <span className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>
                        Turn {index + 1}
                        {visibleTurn === turn.id ? " · Reading" : ""}
                      </span>
                      <span>
                        {turn.isWorking
                          ? "Working"
                          : turn.stopReason === "cancelled"
                            ? "Stopped"
                            : turn.endedAt
                              ? new Date(turn.endedAt).toLocaleTimeString([], {
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : ""}
                      </span>
                    </span>
                    <span className="line-clamp-3 text-[13px] font-medium">
                      {turn.user.text.slice(0, 240) ||
                        (turn.user.attachments?.length ? "Image attachment" : `Turn ${index + 1}`)}
                    </span>
                    {turn.assistantText && (
                      <span className="mt-2 line-clamp-4 text-[12px] text-muted-foreground">
                        {turn.assistantText.replace(/[#*_`]/g, "").slice(0, 360)}
                      </span>
                    )}
                    <span className="mt-2 block text-[10px] text-muted-foreground/70">Click to jump here</span>
                  </span>
                }
              >
                <button
                  type="button"
                  aria-label={`Jump to turn ${index + 1}: ${turn.user.text.slice(0, 60)}`}
                  aria-current={visibleTurn === turn.id ? "location" : undefined}
                  data-active={visibleTurn === turn.id || undefined}
                  className="console-turn-marker group flex h-3 w-5 items-center justify-center rounded-[var(--radius-control)] focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() =>
                    document.getElementById(`chat-${turn.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })
                  }
                >
                  <span
                    className={`h-px transition-all duration-150 group-hover:w-3 group-hover:bg-foreground group-focus-visible:w-3 ${visibleTurn === turn.id ? "w-3 bg-foreground/85" : "w-1.5 bg-muted-foreground/35"}`}
                  />
                </button>
              </Tooltip>
            ))}
          </nav>
        )}

        <div className="relative shrink-0">
          {showJump && (
            <button
              type="button"
              aria-label={
                unseen > 0
                  ? `Scroll to latest, ${unseen} new ${unseen === 1 ? "message" : "messages"}`
                  : "Scroll to latest"
              }
              className="ui-surface-enter absolute bottom-full left-1/2 z-10 mb-3 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-2 rounded-lg border-[0.5px] border-border-2 bg-card px-3 text-[13px] font-medium text-muted-foreground-1 shadow-[var(--sh-overlay)] outline-none transition-colors hover:bg-card-hover hover:text-foreground focus-visible:outline-ring-inset"
              onClick={() => {
                const node = scroller.current;
                if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
                nearBottom.current = true;
                setShowJump(false);
                setUnseen(0);
              }}
            >
              <ArrowDown aria-hidden="true" strokeWidth={1.5} className="size-(--icon-sm)" />
              {unseen > 0 ? `${unseen} ${unseen === 1 ? "message" : "messages"}` : "Scroll to latest"}
            </button>
          )}
          <Composer
            onOpenAgents={() => onSelectWorker(null)}
            placeholder={composerPlaceholder}
            canWrite={canWrite}
            sendBehavior={sendBehavior}
            workspace={rootWorkspace}
            snapshot={snapshot}
            onSubmit={onSubmitRoot}
            onStop={onStopRoot}
          />
        </div>
        {empty && (
          <ContextSuggestions
            snapshot={snapshot}
            onChoose={queueComposerPrefill}
          />
        )}
      </div>
    </div>
  );
}

function ContextSuggestions({
  snapshot,
  onChoose,
  lead,
}: {
  snapshot: ConsoleSessionSnapshot;
  onChoose: (prompt: string) => void;
  lead?: ReactNode;
}) {
  const { client, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const path = selectedWorkspacePath(snapshot);
  const project = useQuery({
    queryKey: queryKeys.chatHomeProject(
      client.backendId,
      team.user?.workspaceId,
      team.user?.userId,
      snapshot.session.id,
      path,
    ),
    enabled: Boolean(path) && !snapshot.focusedFinding,
    staleTime: 15000,
    retry: false,
    queryFn: ({ signal }) =>
      webFetchJson<ProjectResponse>(`/api/console/project?path=${encodeURIComponent(path!)}`, { signal }),
  });
  const suggestions = homeSuggestions(
    snapshot,
    project.data && path ? { requestedPath: path, project: project.data } : undefined,
  );
  const icons = { code: FolderSearch, shield: ShieldCheck, plan: ListChecks };
  return (
    <div aria-label="Suggested prompts" className="flex w-full flex-wrap items-center justify-center gap-2 pt-4">
      {lead}
      {suggestions.slice(0, lead ? 2 : 3).map((suggestion) => {
        const Icon = icons[suggestion.icon];
        return (
          <Tooltip key={suggestion.label} content={suggestion.hint}>
            <Button
              type="button"
              variant="ghost"
              className="h-7 max-w-full gap-1.5 rounded-md border-[0.5px] border-border-2 bg-transparent !px-2 text-xs font-medium text-foreground hover:bg-secondary"
              onClick={() => onChoose(suggestion.prompt)}
            >
              <Icon aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0" />
              <span className="truncate">{suggestion.label}</span>
            </Button>
          </Tooltip>
        );
      })}
    </div>
  );
}

const COMMAND_SUMMARIES: Record<string, string> = {
  help: "Browse commands",
  capabilities: "Explore what 0 can do",
  status: v("Check this {mission}"),
  tools: "Browse available tools",
  "new-chat": v("Start a new {mission}"),
  onboard: "Open guided setup",
  clear: v("Clear this {mission}"),
  history: "Browse run reports",
  findings: "Review findings",
  fix: "Prepare a fix for review",
  copy: v("Export this {mission}"),
  sessions: v("Switch {missions}"),
  explain: "Get a simpler explanation",
  feedback: "Share feedback",
  settings: "Manage preferences",
  keybindings: "View keyboard shortcuts",
  theme: "Change appearance",
  model: "Choose a model",
  chat: v("Return to {mission}"),
  ops: "Open dashboard",
  plugins: "Browse plugins",
  connect: "Connect a provider",
  usage: "Check usage and cost",
  back: "Go back",
  scope: "Manage approved scope",
  doctor: "Check your setup",
  exit: v("Close this {mission}"),
};

function WorkspaceStartup({ message, runId }: { message?: string; runId?: string }) {
  const started = useMemo(() => Date.now(), [runId]);
  const seconds = Math.max(0, Math.floor((useNow(1000) - started) / 1000));
  return (
    <Tooltip
      content={v(
        "The first message starts an isolated VM and copies your workspace. Later messages reuse it while this {mission} stays open.",
      )}
    >
      <span role="status" className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
        <LoadingDots />
        {message ?? "Starting workspace"}…
        {seconds >= 5 && (
          <span className="tabular-nums">
            {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

export function Composer({
  home = false,
  onOpenAgents,
  placeholder,
  workspace: sourceWorkspace,
  snapshot,
  worker,
  onSubmit,
  onStop,
  sendBehavior,
  canWrite,
}: {
  home?: boolean;
  onOpenAgents?: () => void;
  placeholder?: string;
  canWrite: boolean;
  sendBehavior: SendBehavior;
  workspace: ConsoleWorkspace;
  snapshot: ConsoleSessionSnapshot;
  worker?: ConsoleWorker;
  onSubmit: () => void;
  onStop: () => void;
}) {
  // Only the composer observes keystrokes; the page/workspace reads fresh drafts
  // on submit without subscribing its entire chat and sidebar tree.
  const [drafts] = usePersistentState<Record<string, string>>(STORAGE_KEYS.drafts, {});
  const draftKey = `${snapshot.session.id}:${worker?.id ?? "root"}`;
  const storedDraft = drafts?.[draftKey];
  const draft = sourceWorkspace.readDraft
    ? typeof storedDraft === "string"
      ? storedDraft
      : sourceWorkspace.readDraft(!worker)
    : sourceWorkspace.draft;
  const workspace = { ...sourceWorkspace, draft };
  const chatApi = useBackendApi();
  const { client, configureConsoleSession, webFetchJson } = chatApi;
  const team = useTeamAccess();
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const navigate = useNavigate();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [caret, setCaret] = useState(workspace.draft.length);
  const integrations = useIntegrationPicker({
    draft: workspace.draft,
    caret,
    onSelect: (_plugin, replacement) => {
      workspace.setDraft(
        workspace.draft.slice(0, replacement.start) + replacement.text + workspace.draft.slice(replacement.end),
      );
      const nextCaret = replacement.start + replacement.text.length;
      setCaret(nextCaret);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(nextCaret, nextCaret);
      });
    },
  });
  const modelOwner = modelCatalogOwner(client.backendId, snapshot.runtime);
  const localRelay = client.backendId !== "local" && usesLocalModels(snapshot.runtime);
  const localModels = useMemo(
    () => (modelOwner !== client.backendId ? createBackendApi(modelOwner) : undefined),
    [modelOwner, client.backendId],
  );
  const modelLeases = useRef(new Set<NonNullable<typeof localModels>>());
  useEffect(() => {
    if (!localModels) return;
    modelLeases.current.add(localModels);
    return () => {
      modelLeases.current.delete(localModels);
      queueMicrotask(() => {
        if (!modelLeases.current.has(localModels)) localModels.client.dispose();
      });
    };
  }, [localModels]);
  const modelCatalog = useModelCatalog({
    backendId: modelOwner,
    webFetchJson: localModels?.webFetchJson ?? webFetchJson,
    connectionIdentity: snapshot.runtime?.connectionIdentity,
  });
  // The initial remote relay admits local ChatGPT/Codex models only; never offer an unsupported provider as ready.
  const catalogModels = (modelCatalog.data?.models ?? []).filter(
    (model) => !localRelay || model.provider === "chatgpt-codex",
  );
  const modelDiagnostics = (modelCatalog.data?.diagnostics ?? []).filter(
    (item) => !localRelay || item.providerId === "chatgpt-codex",
  );

  // Before a runtime exists, Home shows the model the next mission will start with (the remembered pick).
  // It only counts while its provider still lists it, so a disconnected provider falls back to "Choose model".
  const rememberedModel = useMemo(
    () =>
      usableModelChoice(
        readLastModelChoice(client.backendId),
        modelCatalog.data ? catalogModels : undefined,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogModels is derived from modelCatalog.data and localRelay
    [client.backendId, snapshot.runtime?.model, modelCatalog.data, localRelay],
  );
  const modelLabel = modelButtonLabel(snapshot.runtime, rememberedModel, catalogModels.length > 0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const commandQuery = /^\/([^\s]*)$/.exec(workspace.draft)?.[1]?.toLowerCase();
  const [showAllCommands, setShowAllCommands] = useState(false);
  const curated = useMemo(
    () => curateSlashCommands(SLASH_COMMANDS, commandQuery ?? "", showAllCommands),
    [commandQuery, showAllCommands],
  );
  const commands = commandQuery === undefined ? [] : curated.items;
  const commandsOpen = !worker && commandQuery !== undefined && !commandsDismissed;
  useEffect(() => {
    setCommandIndex(0);
    setCommandsDismissed(false);
    if (commandQuery === undefined) setShowAllCommands(false);
  }, [workspace.draft]);
  useEffect(() => {
    document.getElementById(`composer-command-${commandIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [commandIndex]);
  const selectCommand = (name: string) => {
    workspace.setDraft(`/${name} `);
    setCommandsDismissed(true);
    textarea.current?.focus();
  };

  const currentTurn = useMemo(() => reduceConversation(snapshot).at(-1), [snapshot]);
  const feedback = runFeedback(snapshot, currentTurn);
  const active = worker ? ["running", "queued", "parked"].includes(worker.status) : feedback?.active === true;
  const stopping =
    active &&
    (snapshot.session.status === "cancelling" ||
      Boolean(currentTurn?.notices.some((notice) => notice.startsWith("Cancellation requested."))));
  const startingWorkspace =
    active && !worker && snapshot.execution?.backend === "smolvm" && snapshot.execution.status === "pending";
  const environmentName =
    snapshot.execution?.backend === "smolvm"
      ? "SmolVM"
      : snapshot.execution?.backend === "local"
        ? "Local"
        : "Environment";
  const environmentStatus =
    snapshot.execution?.backend !== "smolvm"
      ? undefined
      : snapshot.execution.status === "pending"
        ? active
          ? "Starting"
          : "Not started"
        : snapshot.execution.status[0].toUpperCase() + snapshot.execution.status.slice(1);
  const environmentSettings = `/settings?section=agents&session=${encodeURIComponent(snapshot.session.id)}&return=${encodeURIComponent(`/chats/${snapshot.session.id}`)}`;
  const closed = snapshot.session.status === "closed";
  const reconnecting = useReconnecting();
  const workerReadOnly = Boolean(worker && !["running", "queued", "parked"].includes(worker.status));
  const attachmentUI = useComposerAttachments({
    attachments: workspace.attachments,
    onChange: workspace.setAttachments,
    disabled: !canWrite || workspace.busy || closed || workerReadOnly,
    worker: Boolean(worker),
  });
  const [composerFocused, setComposerFocused] = useState(false);
  const queuedShortcut =
    !worker &&
    composerFocused &&
    !workspace.draft.trim() &&
    !workspace.attachments.length &&
    !workspace.busy &&
    canWrite &&
    !closed &&
    snapshot.queuedMessages.some((message) => message.id === workspace.queuedShortcutId)
      ? workspace.queuedShortcutId
      : null;
  const showStop = active && !workspace.draft.trim() && !workspace.attachments.length;
  const submitAction = showStop
    ? stopping
      ? "Stopping response"
      : "Stop response"
    : active && !worker
      ? sendBehavior === "queue"
        ? "Queue message"
        : "Interrupt and send"
      : "Send message";
  const canSend =
    canWrite &&
    !attachmentUI.loading &&
    Boolean(workspace.draft.trim() || workspace.attachments.length) &&
    workspace.draft.length <= 32000 &&
    !workspace.busy &&
    !closed &&
    !workerReadOnly;
  const sendActive = showStop ? !(workspace.busy || stopping || !canWrite) : canSend || workspace.busy || stopping;
  const textareaStyle = useComposerAutosize(textarea, workspace.draft, !workerReadOnly);
  const shortcutState = useRef({
    active,
    stopping,
    canWrite,
    uploadOpen: attachmentUI.open,
    onStop,
  });
  shortcutState.current = {
    active,
    stopping,
    canWrite,
    uploadOpen: attachmentUI.open,
    onStop,
  };
  useEffect(() => {
    if (worker || workerReadOnly) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const node = textarea.current;
      if (!node || node.offsetParent === null) return; // another dock chat owns the keys
      const hit = matchShortcut(event);
      if (!hit) return;
      const latest = shortcutState.current;
      if (hit.id === "composer.focus") {
        event.preventDefault();
        node.focus();
      } else if (hit.id === "mission.stop") {
        if (!latest.active || latest.stopping || !latest.canWrite) return;
        event.preventDefault();
        latest.onStop();
      } else if (hit.id === "composer.upload") {
        // Typing in any other field keeps the key; the composer itself may open the picker.
        if (isTypingTarget(event.target as HTMLElement) && event.target !== node) return;
        event.preventDefault();
        latest.uploadOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [worker, workerReadOnly]);
  if (workerReadOnly)
    return (
      <div className="flex items-center justify-between gap-3 px-1 py-2 text-xs text-muted-foreground">
        <span>{worker?.status === "completed" ? "Complete" : "Stopped"}</span>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/chats/${snapshot.session.id}`)}>
          {v("Main {mission}")}
        </Button>
      </div>
    );
  return (
    <div className={`shrink-0 bg-transparent ${worker || home ? "p-0" : "p-3 sm:px-6"}`}>
      <div className={`mx-auto ${home ? "max-w-none" : "max-w-[896px]"}`}>
        {!worker &&
          feedback?.active &&
          ((feedback.waiting && !snapshot.pendingDecisions.length) ||
            feedback.cancellationTimedOut ||
            snapshot.session.cancellation?.phase === "force_stopping" ||
            snapshot.session.status === "cancelling" ||
            feedback.label === "Stopping…" ||
            feedback.label.startsWith("Starting workspace")) && (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-chat-run-status
              className={`mb-2 flex min-w-0 items-center gap-2 px-1 text-xs ${feedback.error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {feedback.active && (
                <span className={feedback.waiting ? "opacity-50" : undefined}>
                  {feedback.waiting ? (
                    <span aria-hidden="true" className="block size-1.5 rounded-full bg-current" />
                  ) : (
                    <LoadingDots compact />
                  )}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <span className="break-words">
                  {feedback.label}
                  {feedback.error ? `: ${consoleErrorMessage(feedback.error)}` : ""}
                </span>
                {feedback.detail && <p className="mt-1 leading-5">{feedback.detail}</p>}
                {feedback.cancellationTimedOut && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(`/chats?new=1&host=${encodeURIComponent(client.backendId)}`)}
                    >
                      {v("New {mission}")}
                    </Button>
                    <ForceStopControl
                      cancellation={snapshot.session.cancellation}
                      canWrite={canWrite}
                      busy={workspace.busy}
                      onForceStop={() => {
                        void workspace
                          .perform(() => chatApi.controlConsoleSession(snapshot.session.id, "force-stop"))
                          .then(() => workspace.refresh());
                      }}
                    />
                    {onOpenAgents && snapshot.workers.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={onOpenAgents}>
                        Inspect agents
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        <div>
          {!worker && home && (
            <div className="flex min-h-8 min-w-0 items-center justify-between gap-3 pb-1.5 pl-4 pr-4 text-muted-foreground">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <FilePathPicker
                  workspace={workspace}
                  sessionId={snapshot.session.id}
                  cwd={snapshot.workspacePath ?? snapshot.scopeEnforcement.projectPath}
                  workspaceDisabled={
                    !canWrite ||
                    active ||
                    workspace.busy ||
                    closed ||
                    snapshot.workers.some((item) => ["queued", "running", "parked"].includes(item.status))
                  }
                  disabled={closed}
                />
                <BackendConnectionPicker />
              </div>
              {onOpenAgents && snapshot.workers.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 px-2 text-xs font-normal text-muted-foreground-1"
                  aria-label={`Open ${snapshot.workers.length} agents`}
                  title={`${snapshot.workers.filter((item) => ["running", "queued", "parked"].includes(item.status)).length} active · ${snapshot.workers.filter((item) => item.status === "completed").length} complete`}
                  onClick={onOpenAgents}
                >
                  {snapshot.workers.some((item) => ["running", "queued", "parked"].includes(item.status)) ? (
                    <ActivityMark compact />
                  ) : (
                    <Users className="size-3.5" />
                  )}
                  <span>
                    {snapshot.workers.length} {snapshot.workers.length === 1 ? "agent" : "agents"}
                  </span>
                </Button>
              )}
              {snapshot.todos && snapshot.todos.total > 0 ? (
                <TaskProgress todos={snapshot.todos} active={feedback?.active === true} />
              ) : null}
              {snapshot.execution?.backend === "smolvm" && (
                <Tooltip content={v("Change environment for new {missions}")}>
                  <Link
                    to={environmentSettings}
                    aria-label={`Environment: ${environmentName}${environmentStatus ? ` ${environmentStatus}` : ""}. Change environment for new ${VOCAB.mission.plural}`}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded px-1 py-1 text-xs text-muted-foreground-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {snapshot.execution?.backend === "smolvm" ? (
                      <Box aria-hidden="true" className="size-3.5" />
                    ) : (
                      <Monitor aria-hidden="true" className="size-3.5" />
                    )}
                    <span>{environmentName}</span>
                    {environmentStatus && <span className="text-muted-foreground/70">· {environmentStatus}</span>}
                    <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground-3" />
                  </Link>
                </Tooltip>
              )}
              {stopping ? (
                <span role="status" className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
                  <LoadingDots />
                  Stopping…
                </span>
              ) : (
                startingWorkspace && (
                  <WorkspaceStartup message={snapshot.execution?.message} runId={snapshot.execution?.runId} />
                )
              )}
            </div>
          )}
          <div
            onDrop={attachmentUI.onDrop}
            onDragOver={attachmentUI.onDragOver}
            onDragEnter={attachmentUI.onDragEnter}
            onDragLeave={attachmentUI.onDragLeave}
            data-dragging={attachmentUI.dragging || undefined}
            className="@container/composer relative flex flex-col rounded-[var(--radius-card,8px)] bg-card p-3 shadow-[var(--shadow-composer)]"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[inherit] border-[0.5px] border-transparent [background:linear-gradient(180deg,var(--border-2),var(--border-1))] [mask:linear-gradient(#000,#000)_padding-box_exclude,linear-gradient(#000,#000)_border-box]"
            />
            {attachmentUI.dragging && (
              <div
                role="status"
                className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-[inherit] border border-primary bg-card/90 text-[13px] font-[450] text-foreground"
              >
                <Paperclip aria-hidden="true" strokeWidth={1.5} className="mr-2 size-3.5 text-primary-ink" />
                Drop files to attach
              </div>
            )}
            {attachmentUI.controls}
            <IntegrationPicker picker={integrations} />
            <ComposerPickerSurface open={commandsOpen} label="Commands" className="w-80 max-w-[calc(100%-2.5rem)]">
              <div
                id="composer-command-list"
                role="listbox"
                aria-label="Slash commands"
                className="max-h-[224px] overflow-y-auto overscroll-contain scroll-fade-y"
              >
                {commands.length ? (
                  commands.map((command, index) => (
                    <button
                      key={command.name}
                      id={`composer-command-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === commandIndex}
                      className={`flex min-h-[var(--h-menu-row,28px)] w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 font-[450] tracking-[-0.01em] text-foreground outline-none focus-visible:outline-ring-inset ${index === commandIndex ? "bg-secondary" : "hover:bg-secondary/60"}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setCommandIndex(index)}
                      onClick={() => selectCommand(command.name)}
                    >
                      <Terminal aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0 text-icon-muted" />
                      <span className="shrink-0">/{command.name}</span>
                      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground-1">
                        {COMMAND_SUMMARIES[command.name] ?? command.description.replace(/ \(TUI:.*\)/, "")}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-1.5 text-[13px] text-muted-foreground-1">No matching commands. Try /help.</p>
                )}
              </div>
              {curated.hidden > 0 && (
                <button
                  type="button"
                  className="flex min-h-[var(--h-menu-row,28px)] w-full items-center rounded-md px-2 py-1 text-left text-[13px] font-[450] text-muted-foreground-1 outline-none hover:bg-secondary/60 hover:text-foreground focus-visible:outline-ring-inset"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setShowAllCommands(true)}
                >
                  Show all ({curated.hidden} more)
                </button>
              )}
            </ComposerPickerSurface>
            <div className="relative">
              <textarea
                data-composer-textarea=""
                style={textareaStyle}
                autoFocus
                rows={1}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                ref={textarea}
                aria-autocomplete="list"
                aria-controls={
                  integrations.open
                    ? integrations.textareaProps["aria-controls"]
                    : commandsOpen
                      ? "composer-command-list"
                      : undefined
                }
                aria-expanded={commandsOpen || integrations.open}
                aria-activedescendant={
                  integrations.open
                    ? integrations.textareaProps["aria-activedescendant"]
                    : commandsOpen && commands.length
                      ? `composer-command-${commandIndex}`
                      : undefined
                }
                aria-label={worker ? `Message ${worker.name}` : "Message Zero"}
                className="block min-h-16 max-h-56 w-full resize-none overflow-y-auto overscroll-contain scroll-fade-y bg-transparent p-1 text-[14px] font-[450] leading-[1.2] tracking-[-0.02em] [--sf-size:32px] outline-none focus:outline-none focus-visible:outline-none placeholder:text-muted-foreground-3 supports-[animation-timeline:scroll()]:[scrollbar-width:none]"
                value={workspace.draft}
                disabled={closed || readOnlyTeam}
                placeholder={
                  closed
                    ? reconnecting
                      ? "Reconnecting…"
                      : "This conversation is closed."
                    : worker
                      ? "Message agent…"
                      : active
                        ? "Add a message…"
                        : (placeholder ?? undefined)
                }
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => {
                  setComposerFocused(false);
                  workspace.dismissQueuedShortcut();
                }}
                onChange={(event) => {
                  workspace.dismissQueuedShortcut();
                  setCaret(event.target.selectionStart);
                  workspace.setDraft(event.target.value);
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(event) => {
                  if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (integrations.onKeyDown(event)) return;
                  if (commandsOpen) {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCommandsDismissed(true);
                      return;
                    }
                    if (commands.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                      event.preventDefault();
                      setCommandIndex(
                        (index) => (index + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length,
                      );
                      return;
                    }
                    if (commands.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
                      event.preventDefault();
                      selectCommand(commands[commandIndex]!.name);
                      return;
                    }
                  }
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !composing.current &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault();
                    if (canSend) onSubmit();
                  }
                }}
                onPaste={attachmentUI.onPaste}
              />
              {!workspace.draft && !closed && !worker && !active && !placeholder && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1 top-1 text-[14px] font-[450] leading-[1.2] tracking-[-0.02em] text-muted-foreground-3"
                >
                  Ask anything
                  <span className="@max-md/composer:hidden">, / for commands, @ for context</span>
                </span>
              )}
            </div>
            <div className="-mx-1 -mb-1 flex items-center gap-2 pt-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                {!worker && (
                  <DropdownMenu>
                    <Tooltip content="Add to message">
                      <DropdownMenu.Trigger
                        aria-label="Add to message"
                        disabled={!canWrite || closed || workspace.busy || workerReadOnly || attachmentUI.loading}
                        className="inline-flex size-7 items-center justify-center rounded-md border-[0.5px] border-transparent text-muted-foreground-1 outline-none transition-colors duration-100 hover:bg-secondary hover:text-foreground active:brightness-97 focus-visible:outline-ring-inset data-[popup-open]:bg-secondary data-[popup-open]:text-foreground disabled:opacity-55"
                        aria-keyshortcuts="Meta+/ Control+/"
                      >
                        <Plus className="size-3.5" strokeWidth={1.5} />
                      </DropdownMenu.Trigger>
                    </Tooltip>
                    <DropdownMenu.Content
                      side="bottom"
                      align="start"
                      sideOffset={4}
                      collisionPadding={12}
                      className="max-w-[calc(100vw-24px)] max-h-[min(28rem,calc(100dvh-2rem))] overscroll-contain w-56 font-sans"
                    >
                      <DropdownMenu.Item
                        icon={<Paperclip className="size-3.5 text-icon-muted" strokeWidth={1.5} />}
                        className="text-[13px] font-[450] tracking-[-0.01em]"
                        onClick={attachmentUI.open}
                      >
                        <span className="min-w-0 flex-1 truncate">Add files or images</span>
                        <span className="shrink-0 text-xs text-muted-foreground-2">
                          {shortcutHint("composer.upload")}
                        </span>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu>
                )}
                {!worker && (
                  <ModePicker
                    workspace={workspace}
                    sessionId={snapshot.session.id}
                    mode={snapshot.pendingConfiguration?.autonomyMode ?? snapshot.session.autonomyMode}
                    disabled={workspace.busy || closed || !canWrite}
                  />
                )}
                {!worker && (
                  <DropdownMenu
                    onOpenChange={(open) => {
                      if (open) modelCatalog.refreshIfStale();
                    }}
                  >
                    <Tooltip content={localRelay ? "Choose a model from local accounts" : "Choose model"}>
                      <DropdownMenu.Trigger
                        aria-label="Choose model"
                        disabled={active || workspace.busy || closed || !canWrite}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 max-w-44 gap-1.5 px-2 text-xs text-muted-foreground-1 hover:text-foreground sm:max-w-64"
                        >
                          {(snapshot.runtime?.providerId || modelLabel.known) && (
                            <ModelIcon
                              modelId={snapshot.runtime?.model ?? rememberedModel?.model ?? ""}
                              providerId={snapshot.runtime?.providerId ?? rememberedModel?.providerId ?? ""}
                              className="size-3.5 shrink-0 text-primary-ink"
                            />
                          )}
                          <span className="truncate">{modelLabel.text}</span>
                          {snapshot.runtime?.providerId === "openrouter" && (
                            <span title="Via OpenRouter" className="inline-flex">
                              <ProviderIcon providerId="openrouter" className="size-3 shrink-0" />
                              <span className="sr-only">via OpenRouter</span>
                            </span>
                          )}
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground-3" strokeWidth={1.5} />
                        </Button>
                      </DropdownMenu.Trigger>
                    </Tooltip>
                    <DropdownMenu.Content
                      side="bottom"
                      align="start"
                      sideOffset={4}
                      collisionPadding={12}
                      className="max-w-[calc(100vw-24px)] max-h-[min(360px,var(--available-height,calc(100dvh-24px)))] overscroll-contain p-1 [&>.overflow-y-auto]:flex-1 [&>.overflow-y-auto]:scroll-py-1 flex w-80 min-w-0 flex-col overflow-hidden font-sans"
                    >
                      <AccessProgramPicker
                        workspace={workspace}
                        sessionId={snapshot.session.id}
                        runtime={snapshot.runtime}
                        disabled={active || workspace.busy || closed || !canWrite}
                      />
                      <ModelCatalog
                        models={catalogModels}
                        selected={snapshot.runtime ?? rememberedModel}
                        backendId={chatApi.client.backendId}
                        onSelect={(model) => {
                          rememberModelChoice(chatApi.client.backendId, {
                            providerId: model.provider,
                            model: model.id,
                          });
                          void workspace.perform(() =>
                            configureChatRuntime(
                              chatApi,
                              snapshot.session.id,
                              { providerId: model.provider, model: model.id },
                              snapshot.runtime,
                            ),
                          );
                        }}
                        pending={modelCatalog.isLoading}
                        error={
                          modelCatalog.error
                            ? consoleErrorMessage(errorText(modelCatalog.error, "Could not load models"))
                            : undefined
                        }
                        diagnostics={modelDiagnostics}
                        emptyMessage={
                          localRelay
                            ? "Connect ChatGPT locally to use models on this host."
                            : "No models available. Manage connections below."
                        }
                        footer={
                          <>
                            <DropdownMenu.Item
                              icon={<Plus className="size-3.5 shrink-0 text-icon-muted" strokeWidth={1.5} />}
                              className="text-[13px] font-[450] tracking-[-0.01em]"
                              onClick={() => {
                                if (localRelay) window.location.assign(backendRouteHref("local", "/connections"));
                                else
                                  navigate(
                                    `/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/chats/${snapshot.session.id}`)}`,
                                  );
                              }}
                            >
                              Manage connections
                              {modelDiagnostics.length > 0 && (
                                <span aria-hidden="true" className="ml-1.5 inline-block size-1.5 rounded-full bg-warning align-middle" />
                              )}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              icon={<Wrench className="size-3.5 shrink-0 text-icon-muted" strokeWidth={1.5} />}
                              className="text-[13px] font-[450] tracking-[-0.01em]"
                              onClick={() => {
                                if (localRelay) window.location.assign(backendRouteHref("local", "/models"));
                                else
                                  navigate(
                                    `/models?session=${snapshot.session.id}&return=${encodeURIComponent(`/chats/${snapshot.session.id}`)}`,
                                  );
                              }}
                            >
                              Model settings
                            </DropdownMenu.Item>
                          </>
                        }
                      />
                    </DropdownMenu.Content>
                  </DropdownMenu>
                )}
                {!worker && (
                  <ReasoningPicker
                    workspace={workspace}
                    sessionId={snapshot.session.id}
                    reasoning={snapshot.runtime?.reasoning}
                    disabled={active || workspace.busy || closed || !canWrite}
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  hidden={workspace.draft.length < 30000}
                  className={`text-xs ${workspace.draft.length > 32000 ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {workspace.draft.length.toLocaleString()} / 32,000
                </span>
                {snapshot.queuedMessages.length > 0 && !worker && (
                  <QueuedMessages workspace={workspace} snapshot={snapshot} />
                )}
                <Tooltip
                  content={showStop ? submitAction : `${submitAction}. Shift+Enter for a new line.`}
                  shortcut={
                    showStop ? shortcutHint("mission.stop") : commandsOpen || integrations.open ? undefined : "Enter"
                  }
                >
                  <Button
                    size="icon-sm"
                    variant={sendActive ? "default" : "ghost"}
                    className={`size-7 disabled:opacity-100 ${sendActive ? "" : "bg-secondary text-muted-foreground"}`}
                    aria-label={
                      showStop
                        ? stopping
                          ? "Stopping response"
                          : "Stop response"
                        : workspace.busy
                          ? "Sending message"
                          : "Send message"
                    }
                    aria-busy={workspace.busy || stopping}
                    disabled={showStop ? workspace.busy || stopping || !canWrite : !canSend}
                    onClick={showStop ? onStop : onSubmit}
                  >
                    {workspace.busy || stopping ? (
                      <LoadingDots className="scale-75" />
                    ) : showStop ? (
                      <Square aria-hidden="true" className="size-3 fill-current" strokeWidth={1.5} />
                    ) : (
                      <ArrowUp className="size-3.5" strokeWidth={1.5} />
                    )}
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
        {!worker && !home && (
          <div
            data-composer-status
            className="@container/rail flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 px-4 pt-1 text-xs text-muted-foreground-2"
          >
            <BackendConnectionPicker rail />
            <FilePathPicker
              rail
              workspace={workspace}
              sessionId={snapshot.session.id}
              cwd={snapshot.workspacePath ?? snapshot.scopeEnforcement.projectPath}
              workspaceDisabled={
                !canWrite ||
                active ||
                workspace.busy ||
                closed ||
                snapshot.workers.some((item) => ["queued", "running", "parked"].includes(item.status))
              }
              disabled={closed}
            />
            {onOpenAgents && snapshot.workers.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 gap-1.5 px-2 text-xs font-medium text-muted-foreground-1 hover:bg-secondary hover:text-foreground"
                aria-label={`Open ${snapshot.workers.length} agents`}
                title={`${snapshot.workers.filter((item) => ["running", "queued", "parked"].includes(item.status)).length} active · ${snapshot.workers.filter((item) => item.status === "completed").length} complete`}
                onClick={onOpenAgents}
              >
                {snapshot.workers.some((item) => ["running", "queued", "parked"].includes(item.status)) ? (
                  <ActivityMark compact />
                ) : (
                  <Users className="size-3" />
                )}
                <span>
                  {snapshot.workers.length} {snapshot.workers.length === 1 ? "agent" : "agents"}
                </span>
              </Button>
            )}
            {snapshot.todos && snapshot.todos.total > 0 ? (
              <span className="flex min-w-0 [&>button]:ml-0 [&>button]:h-6 [&>button]:font-medium [&>button]:text-muted-foreground-1 [&>button]:hover:bg-secondary">
                <TaskProgress todos={snapshot.todos} active={feedback?.active === true} />
              </span>
            ) : null}
            {snapshot.execution?.backend === "smolvm" && (
              <Tooltip content={v("Change environment for new {missions}")}>
                <Link
                  to={environmentSettings}
                  aria-label={`Environment: ${environmentName}${environmentStatus ? ` ${environmentStatus}` : ""}. Change environment for new ${VOCAB.mission.plural}`}
                  className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-xs font-medium text-muted-foreground-1 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {snapshot.execution?.backend === "smolvm" ? (
                    <Box aria-hidden="true" className="size-3" />
                  ) : (
                    <Monitor aria-hidden="true" className="size-3" />
                  )}
                  <span>{environmentName}</span>
                  {environmentStatus && <span className="text-muted-foreground/70">· {environmentStatus}</span>}
                  <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground-3" />
                </Link>
              </Tooltip>
            )}
            {stopping ? (
              <span role="status" className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
                <LoadingDots />
                Stopping…
              </span>
            ) : (
              startingWorkspace && (
                <WorkspaceStartup message={snapshot.execution?.message} runId={snapshot.execution?.runId} />
              )
            )}
            <span className="-mr-2 ml-auto flex shrink-0 items-center">
              <ContextPopover snapshot={snapshot} />
            </span>
          </div>
        )}
        {queuedShortcut && (
          <p role="status" className="mt-2 px-1 text-xs text-muted-foreground">
            Message queued. Current work and agents will continue; your message will send after this response.
          </p>
        )}
        {workerReadOnly && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {v("This sub-agent is done. Switch to the main {mission} to continue.")}
          </p>
        )}
      </div>
    </div>
  );
}
