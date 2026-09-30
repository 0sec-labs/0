import { consoleExecutionProfile } from "../console-execution.js";
/** @jsxImportSource @opentui/react */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { createLocalConsoleSession } from "../console-session.js";
import { isDevUiRemount, useDevUiBoundary, useDevUiRef, useDevUiState } from "../dev-ui-reload.js";
import type { AuditActivity } from "./audit-workspace.js";
import { loadFindingFocus, type FindingFocus } from "../finding-focus.js";
import { exportChatConversation } from "./chat-export.js";
import { describeFixStatus, fixEligibility, fixInputEligibility, fixResultLines, fixPublicationLines, FIX_USAGE } from "./fix-action.js";
import { runSourceFix, planSourceFixPublication, publishSourceFixDraftPR, createRuntime, resolveSourceFixRepository, loadSourceFixProjectInputs, saveSourceFixProjectInputs, type SourceFixResult, type SourceFixPublicationPlan } from "@0/core";
import { isNativeRuntime } from "./findings-data.js";
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { DEFAULT_AUTONOMY_MODE } from "@0/shared";
import {
  ScopePolicy,
  createConsoleRuntime,
  eventBus,
  agentTaskLabel,
  type ConsoleAutonomyMode,
  type ConsoleScopeRequest,
  type ConsoleScopeResolution,
  claimDiagnostics,
  type ConsoleLocalScopeRequest,
  type ConsoleLocalScopeResolution,
  type ScopedAuditEscalationRequest,
  type ConsoleSession,
  type RuntimeConfig,
  type LlmApiRuntime,
  type NativeMessage,
  type NativeRuntime,
  type OperatorQuestionRequest,
  type OperatorQuestionAnswer,
  type SubagentLifecyclePayload,
  type SubagentMessagePayload,
  type PeerMessagePayload,
  type TodosEventPayload,
  type SessionObjectivePayload,
  type ToolCall,
  type ToolRisk,
  describeDestructiveCategory,
  sendOperatorMessage,
  renderInboundMessage,
  type MessagingRuntime,
  type McpHost,
} from "@0/core";
import { decodePasteBytes, type ScrollBoxRenderable } from "@opentui/core";
import {
  useSettings,
  updateSetting,
  previewSetting,
  reloadSettings,
} from "./settings-store.js";
import { createPreferredConsoleRuntime, saveAppliedModelPreference } from "./model-preference.js";
import { useTheme, type Theme } from "./theme-context.js";
import { modelProvider } from "@0/shared";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  addImage,
  addText,
  createPasteStore,
  expandPasteMarkers,
  isLongPaste,
  IMAGE_PATH_RE,
  type PasteStore,
} from "./chat/paste-store.js";
import {
  createPresentationEmitter,
  type PresentationEmitter,
} from "../presentation/event-bus.js";
import {
  readGitStatus,
  type GitStatus,
} from "./git-status.js";
import {
  buildStatusSegments,
  fitStatusSegments,
  fitStatusPills,
  formatTokenCount,
  pillText,
  type StatusBarUsageEntry,
  type StatusColorRole,
} from "./status-bar.js";
import { SHIMMER_TEXT_INTERVAL_MS, spinnerGlyph } from "./animations.js";
import { ShimmerText } from "./chat/shimmer.js";
import {
  createSelectorState,
  highlighted,
  reduceSelector,
  visibleItems,
  type SelectorItem,
  type SelectorState,
} from "./selector.js";
import {
  appendFeedback,
  buildDiagnosticFeedback,
  buildSubmitPreview,
  submitFeedback,
  submissionBlockedReason,
  describeSkip,
  parseFeedbackCommand,
  type FeedbackPayload,
} from "./feedback.js";
import {
  base64ByteLength,
  formatToolArgs,
  formatToolResult,
  projectToolPreview,
} from "./tool-format.js";
import {

  pruneSessions,
  saveSession,
} from "./session-store.js";
import type { SessionPluginHostManager } from "./session-plugin-host.js";
import {
  reportOperatorGate,
  reportHerdrModel,
  reportHerdrContextPercent,
  reportHerdrTarget,
  reportHerdrObjective,
  reportHerdrActivity,
  reportHerdrCompaction,
} from "../herdr-state.js";
import {
  GLYPH_CELLS,
  ELAPSED_VISIBLE_AFTER_MS,
  formatElapsedClock,
  frameAt,
  frameIntervalMs,
  type AnimationKind,
} from "./animation.js";
import {
  PROVIDERS,
  isProviderConfigured,
} from "./provider-status.js";
import {
  credentialEnvPatch,
  loadCredentials,
  redactSecret,
  saveCredentials,
} from "./credential-store.js";
import {
  connectionRecoveryForError,
  type ConnectionRecovery,
} from "./connection-recovery.js";
import { VERSION } from "@0/shared";
import {
  type TuiSettings,
} from "./settings.js";
import {
  pushHistory,
  recallNext,
  recallPrev,
} from "./composer-history.js";
import { suggestCompletion } from "./composer-suggest.js";
import {
  buildCapabilityPanel,
  buildHelpPanel,
  buildScopePanel,
  buildStatusPanel,
  buildToolsPanel,
} from "./panels.js";
import { getAllCapabilities } from "./capability-registry.js";
import { fitLegend, fitTuiText, sanitizeComposerText } from "./text.js";
import { THEME_NAMES, getThemeEntry, isThemeName, readableOnPrimary } from "./themes.js";
import { sleekScrollbar } from "./scrollbar.js";
import {
  parseSubagentCard,
  reduceActiveSubagents,
  summaryInputFromMessage,
} from "./subagent-card.js";
import { onTuiOutputLine } from "./output-guard.js";
import {
  COMPOSER_QUEUE_LIMIT,
  classifyComposerInput,
  composerQueueLabel,
  dequeueComposerInput,
  enqueueComposerInput,
  queuedInputAction,
} from "./composer-queue.js";
import {
  LEDGER_MARK_ROWS,
  clampAgentSelection,
  commandMenuBoxHeight,
  commandMenuWindowStart,
  computeChatLayout,
  computeCommandMenuHeight,
  computeCommandMenuLayout,
  computeLedgerRows,
  moveAgentSelection,
} from "./chat-layout.js";
import {
  applySubagentLifecycle,
  applySubagentProgress,
  clipDetailLines,
  computeHerdFocusLayout,
  focusHeaderLines,
  herdFocusTranscriptTitle,
  projectAgentForest,
  projectLiveAgentForest,
  renderFocusActivity,
  shellChromeRows,
  subagentPeers,
  windowFocusTail,
  HERD_FOCUS_EMPTY_TEXT,
  type HerdSubagentMap,
} from "./herd-layout.js";
import { clampScrollOffset, wheelOffsetStep } from "./mouse.js";
import {
  computeLogoFrame,
  logoAnimationFrameCount,
  logoAnimationLoops,
} from "./logo-animation.js";
import {
  buildOperatorAnswer,
  createOperatorQuestionState,
  operatorActiveDisplayIndex,
  operatorActiveRow,
  operatorAppend,
  operatorBackspace,
  operatorHasOptions,
  operatorMove,
  operatorToggle,
  planOperatorRows,
  type OperatorDisplayRow,
  type OperatorQuestionState,
} from "./operator-question.js";
import {
  SLASH_COMMANDS,
  filterCommands,
  findCommand,
  type SlashCommand,
} from "@0/shared";
import {
  deletePreviousCharacter,
  deletePreviousWord,
  deleteToLineStart,
  stepComposerCursor,
} from "./composer-edit.js";
import { appendTranscriptEntry } from "./transcript.js";
import {
  applyStreamPatches,
  enqueueStreamPatch,
  type StreamPatch,
} from "./stream-coalescer.js";
import {
  planTranscript,
  resolveTranscriptStyleSettings,
} from "./transcript-style.js";
import { useSelectionCopy, type SelectionCopyFn } from "./use-selection-copy.js";
import { useToast, Toast } from "./toast.js";
import { ContextMenu } from "./context-menu.js";
import {
  useContextMenu,
  isRightClick,
  type ContextMenuItem,
} from "./use-context-menu.js";
import { clearMarkdownCache, firstCodeBlock } from "./markdown.js";
import {
  MAX_RICH_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_PREVIEW_CHARS,
} from "./transcript-preview.js";
import {
  copyToClipboard,
  defaultSpawn,
  defaultWhich,
} from "./clipboard.js";
import type {
  ChatEntry,
  ChatImageAttachment,
  EntryDisplay,
  KeyHint,
} from "./chat/types.js";
import {
  TERMINAL_BLOCK_LOGO,
  TERMINAL_BLOCK_LOGO_WIDTH,
  LOGO_FRAME_INTERVAL_MS,
} from "./chat/logo.js";
import {
  modeLabel,
  modeColorFor,
  herdToneColor,
  completionFor,
  commandMatchesPrefix,
  buildScopeResolution,
  activityExcerpt,
  reasoningExcerpt,
  toolActivity,
} from "./chat/helpers.js";
import {
  renderEntry,
  renderFold,
} from "./chat/TranscriptEntry.js";
import { AgentWorkList } from "./chat/AgentChatSwitcher.js";
import { agentWorkListHeight, agentChatSwitcherShortcut, activeAgentChatTabs, agentChatWorkItems, adjacentAgentChatTab } from "./chat/agent-chat-switcher-layout.js";
import { replaceSubagentTurn, retainSubagentTurns } from "./chat/subagent-transcript.js";
import { applyCommsMessage, type CommsMessage } from "./agents-comms-layout.js";
import { DialogActionButton } from "./dialog-screen-chrome.js";
import { Todos } from "./chat/Todos.js";
import { ComposerFrame, ComposerInput, composerContentRows } from "./chat/Composer.js";
import { autonomyFooterText, isAutonomyCycleKey, nextAutonomyMode } from "./composer-mode.js";
import { matchesBinding } from "./keybindings.js";
import { reduceWorkerTelemetry, resolveContextLimit, selectConversationContext } from "./context-window.js";
import type { WorkerTelemetry } from "./context-window.js";
import { Cells, textCells } from "./primitives.js";
import {
  KeyHints,
  keyHintsLength,
} from "./chat/KeyHints.js";
import {
  SelectorPanel,
  selectorPanelBudget,
  selectorPanelHeight,
} from "./chat/SelectorPanel.js";
import {
  ApprovalCard,
  approvalCardRows,
  argumentSummaryLines,
  APPROVAL_GRANT_ID,
  APPROVAL_DENY_ID,
  type ApprovalPrompt,
} from "./chat/ApprovalCard.js";
import { OperatorQuestionCard } from "./chat/OperatorQuestionCard.js";
import { Masthead } from "./chat/Masthead.js";
import { ZERO_HEIGHT } from "./chat/zero-art.js";
import { CommandMenu } from "./chat/CommandMenu.js";
import { appendTuiCrash, appendTuiEvent, serializeError, logProblem, describeErrorForSurface, tuiLogPath } from "./tui-crash.js";

export type ChatDestination = "launcher" | "ops" | "history" | "findings" | "doctor" | "replay" | "settings" | "keybindings" | "new-chat" | "models" | "market" | "usage" | "connect" | "comms" | "finding" | "sessions" | "onboard";

function waitingForAgentsLabel(count: number): string {
  const liveCount = Math.max(0, Math.trunc(count));
  return liveCount > 0
    ? `Waiting for ${liveCount} agent${liveCount === 1 ? "" : "s"}`
    : "Waiting for agents";
}

/**
 * Map a status pill's semantic colour role onto the live palette. Kept theme-
 * aware here (status-bar.ts is pure/theme-free): each band gets its own colour so
 * the bar reads as segmented OMP-style pills. `mode` resolves through
 * `modeColorFor` so the mode colour is IDENTICAL to the header and the turn
 * footer (Co-pilot purple, YOLO red, Recon blue, Standard neutral). The only red
 * ever produced is YOLO's, honouring the "red = errors/failures" invariant — a
 * dirty tree is WARNING (amber), not red.
 */
/**
 * The display-only `ToolResult.meta` sidecar (never seen by the model) a tool
 * may attach — bash / run_command → a command card, apply_patch → an edit card.
 * Typed structurally so this module needs no extra core-type import.
 */
interface ToolCardMeta {
  kind?: "command" | "edit" | "web" | "task" | "code" | "image";
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  timeoutMs?: number;
  timedOut?: boolean;
  stdout?: string;
  path?: string;
  added?: number;
  removed?: number;
  diff?: string;
  provider?: string;
  query?: string;
  answer?: string;
  sources?: Array<{ title?: string; url: string; age?: string }>;
  // task card
  taskLabel?: string;
  taskContext?: string;
  goal?: string;
  constraints?: string;
  contract?: string;
  assignment?: string;
  subReports?: Array<{ name: string; agent?: string; brief?: string; isolated?: boolean }>;
  todos?: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed"; group?: string }>;
  // code card
  language?: "javascript" | "python";
  code?: string;
  output?: string;
  // image card (browser screenshot)
  image?: {
    imageBase64: string;
    mimeType: string;
    width: number;
    height: number;
    caption?: string;
  };
}

/**
 * Map a tool result's display-only `meta` sidecar onto the rich-card fields of
 * a `ChatEntry`, for BOTH a live turn and a restored one. Returns an empty
 * object when there is no card to draw, so a spread leaves the entry untouched.
 */
function toolCardFieldsFromMeta(meta: ToolCardMeta | undefined): Partial<ChatEntry> {
  if (
    !meta ||
    (meta.kind !== "command" &&
      meta.kind !== "edit" &&
      meta.kind !== "web" &&
      meta.kind !== "task" &&
      meta.kind !== "code" &&
      meta.kind !== "image")
  ) {
    return {};
  }
  if (meta.kind === "code") {
    return {
      metaKind: "code",
      codeLanguage: meta.language,
      codeSource: meta.code,
      codeOutput: meta.output,
      exitCode: meta.exitCode ?? null,
      wallMs: meta.durationMs,
    };
  }
  if (meta.kind === "image") {
    // Reuse the existing inline-image path: an ImageCard is drawn from
    // `entry.images` (ChatImageAttachment = ToolPreviewImage + origin). The
    // pixel size + media type come straight from the meta the tool decoded, so
    // OpenTUI can draw the PNG where the terminal supports it and falls back to
    // a captioned dimensions placeholder otherwise.
    const img = meta.image;
    if (!img) return { metaKind: "image" };
    const byteSize = base64ByteLength(img.imageBase64);
    const attachment: ChatImageAttachment = {
      index: 1,
      data: img.imageBase64,
      mimeType: img.mimeType,
      format: img.mimeType.split("/")[1],
      pixelWidth: img.width > 0 ? img.width : undefined,
      pixelHeight: img.height > 0 ? img.height : undefined,
      byteSize,
      alt: img.caption,
      origin: "browser",
    };
    return { metaKind: "image", images: [attachment] };
  }
  if (meta.kind === "task") {
    return {
      metaKind: "task",
      taskLabel: meta.taskLabel,
      taskContext: meta.taskContext,
      taskGoal: meta.goal,
      taskConstraints: meta.constraints,
      taskContract: meta.contract,
      taskAssignment: meta.assignment,
      subReports: meta.subReports,
      taskTodos: meta.todos,
    };
  }
  if (meta.kind === "command") {
    return {
      metaKind: "command",
      command: meta.command,
      commandOutput: meta.stdout,
      exitCode: meta.exitCode ?? null,
      wallMs: meta.durationMs,
      timeoutMs: meta.timeoutMs,
      timedOut: meta.timedOut,
    };
  }
  if (meta.kind === "web") {
    return {
      metaKind: "web",
      webProvider: meta.provider,
      webQuery: meta.query,
      webAnswer: meta.answer,
      webSources: meta.sources,
    };
  }
  return {
    metaKind: "edit",
    editPath: meta.path,
    editAdded: meta.added,
    editRemoved: meta.removed,
    editDiff: meta.diff,
  };
}

/**
 * Reconstruct a rich card's `ChatEntry` fields from a SERIALIZED tool result
 * (a restored session). The display-only `meta` is gone (it never reached the
 * model transcript), so a command card recovers only its command + output, and
 * an edit card its path / +/- counts / hunk diff from the patch envelope. No
 * wall or timeout footer survives a restore.
 */
function restoredToolCardFields(
  name: string,
  input: unknown,
  content: unknown,
  success: boolean,
): Partial<ChatEntry> {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (name === "spawn_agents") {
    // The live plan/TODO snapshot and per-agent names were carried on the
    // (now-gone) meta; from the serialized args we can still recover the shared
    // context and each task's brief so the launch card survives a restore.
    const rawTasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [];
    const subReports = rawTasks.map((entry, i) => {
      const task = typeof entry?.task === "string" ? entry.task.trim() : "";
      const brief = task ? task.split("\n")[0].slice(0, 64) : "";
      const agent = typeof entry?.role === "string" ? entry.role : undefined;
      return {
        name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : `#${i + 1}`,
        ...(agent ? { agent } : {}),
        ...(brief ? { brief } : {}),
      };
    });
    if (subReports.length === 0) return {};
    return {
      metaKind: "task",
      taskLabel: `${subReports.length} ${subReports.length === 1 ? "agent" : "agents"}`,
      taskContext: typeof args.context === "string" && args.context.trim() ? args.context : undefined,
      subReports,
    };
  }
  if (name === "js_eval" || name === "python_eval") {
    // The display-only meta (language / code / output / duration) is gone on a
    // restore; recover the source from args and the output from the serialized
    // result text so the code card still draws.
    const code = typeof args.code === "string" ? args.code : undefined;
    if (!code) return {};
    return {
      metaKind: "code",
      codeLanguage: name === "python_eval" ? "python" : "javascript",
      codeSource: code,
      codeOutput: typeof content === "string" ? content : undefined,
      exitCode: success ? 0 : 1,
    };
  }
  if (name === "bash" || name === "run_command") {
    const command = typeof args.command === "string" ? args.command.trim() : undefined;
    if (!command) return {};
    return {
      metaKind: "command",
      command,
      commandOutput: typeof content === "string" ? content : undefined,
      exitCode: success ? 0 : 1,
      timedOut: false,
    };
  }
  if (name === "apply_patch") {
    const patch = typeof args.patch === "string" ? args.patch : undefined;
    if (!patch) return {};
    let added = 0;
    let removed = 0;
    const diffLines: string[] = [];
    const paths: string[] = [];
    for (const line of patch.split("\n")) {
      const fileMatch = /^\*\*\* (?:Update|Add|Delete|Replace) File: (.+)$/.exec(line);
      if (fileMatch) {
        if (!paths.includes(fileMatch[1])) paths.push(fileMatch[1]);
        continue;
      }
      if (line.startsWith("*** ") || line.startsWith("@@")) continue;
      if (line.startsWith("+")) {
        added += 1;
        diffLines.push(line);
      } else if (line.startsWith("-")) {
        removed += 1;
        diffLines.push(line);
      } else {
        diffLines.push(line);
      }
    }
    return {
      metaKind: "edit",
      editPath: paths.length > 0 ? paths.join(", ") : "(patch)",
      editAdded: added,
      editRemoved: removed,
      editDiff: diffLines.join("\n").trim(),
    };
  }
  return {};
}

function statusRoleColor(
  role: StatusColorRole,
  theme: Theme,
  mode: ConsoleAutonomyMode,
): string {
  switch (role) {
    case "model":
      return theme.PRIMARY;
    case "mode":
      return modeColorFor(mode, theme);
    case "evolution":
      return theme.SUCCESS;
    case "cwd":
      return theme.INFO;
    case "branch":
      return theme.BRAND;
    case "dirty":
      return theme.WARNING;
    case "tokens":
      return theme.INFO;
    case "cost":
      return theme.SUCCESS;
    case "context":
      return theme.ACCENT;
    case "activity":
      return theme.ACCENT;
    case "effort":
    case "elapsed":
    case "plan":
    default:
      return theme.MUTED;
  }
}

function startupRecoveryText(detail: string): string {
  if (/no provider credential found/i.test(detail)) {
    return "Connect your own API key or provider subscription with /connect.";
  }
  const recovery = connectionRecoveryForError(detail);
  if (recovery?.providerId === "chatgpt-codex") {
    return "ChatGPT Codex needs device OAuth. Use /connect; do not paste an OpenAI API key.";
  }
  return detail;
}


export interface ChatScreenOptions {
  target?: string;
  dbPath?: string;
  scope?: ScopePolicy;
  model?: string;
  /** Internal inheritance guard: a model from another connection is not a new explicit choice. */
  modelConnectionIdentity?: string;
  /** Explicit provider choice, applied only when constructing a new runtime. */
  providerId?: RuntimeConfig["provider"];
  /** Operator-approved role/model choices for new runtimes, never agent-authored consent. */
  agentModels?: Readonly<Record<string, string>>;
  singleModel?: boolean;
  role?: "discovery" | "attack" | "verify" | "report" | "audit" | "review";
  maxToolIterations?: number;
  allowScanners?: boolean;
  autonomyMode?: ConsoleAutonomyMode;
  /**
   * A stored session's transcript to resume into on mount — the full-screen
   * resume browser (run.tsx ResumeRoute) opens the chat with these, so the new
   * ChatScreen builds its console around the restored history and rehydrates the
   * transcript. Absent for a fresh chat.
   */
  initialMessages?: NativeMessage[];
  /** A one-shot finding workflow request submitted after the session is ready. */
  initialPrompt?: string;
  /**
   * A connected MCP host whose registered tools join the console's tool set
   * (network-gated, `mcp__`-fenced as untrusted). The CLI connects it before
   * launching the TUI and threads it down here, so the session build stays
   * synchronous — no async connect inside React. The session closes the host on
   * cleanup. Absent when no `ZERO_MCP` servers are configured.
   */
  mcpHost?: McpHost;
}

export interface ChatScreenProps {
  options?: ChatScreenOptions;
  onGoBack: () => void;
  onNavigate: (destination: ChatDestination, id?: string) => void;
  onExit: () => void;
  /**
   * Opens the provider recovery screen after a recognized credential failure.
   * Tool and target errors stay in the transcript instead of misrouting here.
   * REQUIRED: it was previously optional and the sole call site (run.tsx) forgot
   * to wire it, so a Codex 401 only printed "turn failed" and the device-auth
   * pane never opened. Keeping it required makes that omission a compile error.
   */
  onConnectionFailure: (recovery: ConnectionRecovery) => void;
  /**
   * A handle the coordinator populates with a function that submits an operator
   * message into the SAME composer-submit path a typed message takes (queue if a
   * turn is in flight, otherwise send). Finding handoffs use this path so their
   * evidence, approval gates, and transcript stay in one session.
   */
  submitHandle?: React.MutableRefObject<((text: string) => void) | null>;
  /** Generated prompts are drafts for review, never automatic turns. */
  stagePromptHandle?: React.MutableRefObject<((text: string) => void) | null>;
  /** Save a future connection choice, or retry when no session was constructed. */
  reconnectHandle?: React.MutableRefObject<((providerId: string) => void) | null>;
  /** Share the existing session host with contextual controls; never create another. */
  onSessionChange?: (session: ConsoleSession | null) => void;
  onWorkingChange?: (busy: boolean) => void;
  onNextChatOptions?: (selection: Pick<ChatScreenOptions, "model" | "providerId" | "agentModels" | "singleModel">) => void;
  /**
   * The shell-level marketplace host manager. A session leases its initial
   * host until cleanup; changed enablement applies to the next explicit chat.
   */
  pluginHostManager?: SessionPluginHostManager;
  /** Compact status of the configured self-evolving finder-lens worker. */
  evolutionStatus?: string;
  interactive: boolean;
  messagingHomeDir: string;
  protectedSessionIds: ReadonlySet<string>;
  onAuditActivity: (activity: AuditActivity) => void;
  closeHandle: React.MutableRefObject<(() => Promise<void>) | null>;
  herdHandle: React.MutableRefObject<(() => Readonly<HerdSubagentMap>) | null>;
  runtimeInfoHandle: React.MutableRefObject<{
    model: () => string;
    providerId: () => string;
    connectionIdentity: () => string | undefined;
    codexCatalog?: (signal?: AbortSignal) => Promise<import("@0/core").CodexCatalogModel[]>;
    nativeRuntime: () => NativeRuntime;
    /**
     * Live-apply a model/provider/role-map selection to the running runtime.
     * Reconfigures in place at a turn boundary (never mid-turn): applies at
     * once when idle, otherwise stashes and flushes when the current turn
     * completes. A provider switch into a dark (uncredentialed) provider is
     * NOT applied live — it stays staged for the next audit with a notice.
     */
    applySelection: (sel: {
      model?: string;
      providerId?: string;
      agentModels?: Record<string, string>;
      singleModel?: boolean;
    }) => void;
  } | null>;
}


type PendingScope = {
  request: ConsoleScopeRequest;
  resolve: (resolution: ConsoleScopeResolution | null) => void;
};

type PendingLocalScope = {
  request: ConsoleLocalScopeRequest;
  resolve: (resolution: ConsoleLocalScopeResolution | null) => void;
};

type PendingEscalation = {
  request: ScopedAuditEscalationRequest;
  resolve: (approved: boolean) => void;
};

type PendingToolApproval = {
  call: ToolCall;
  /** Presentation-only risk, from the core classifier at the approval boundary. */
  risk?: ToolRisk;
  completeDetails?: boolean;
  resolve: (approved: boolean) => void;
};

/**
 * A pending `ask_operator` question. It authorizes NOTHING — it is the model
 * asking the human for a decision/value — so it lives apart from the approval
 * gates above and resolves an {@link OperatorQuestionAnswer} (or `null` when the
 * operator dismisses it with Esc).
 */
type PendingOperatorQuestion = {
  request: OperatorQuestionRequest;
  resolve: (answer: OperatorQuestionAnswer | null) => void;
  /** Host-created forms may prefill suggestions; answering still grants no execution permission. */
  initialState?: OperatorQuestionState;
};


/**
 * Rebuild visible transcript entries from a stored conversation.
 *
 * Resuming used to restore the model's history but leave the ledger empty,
 * so the operator saw a blank screen and had no idea what the session was
 * about. These messages come off disk and may be malformed or from an
 * older shape, so every branch is defensive: anything unrecognised is
 * skipped rather than rendered as a raw blob, and nothing here throws.
 *
 * Nothing is invented — an assistant message with no text produces no
 * entry rather than a placeholder.
 */
export function entriesFromStoredMessages(messages: readonly unknown[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  // tool_use ids are matched to their results so a call renders as one
  // card with its outcome, the same shape a live turn produces.
  const pendingCalls = new Map<string, { name: string; input: unknown }>();
  let seq = 0;
  const id = () => `restored-${seq++}`;

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { role?: unknown; content?: unknown };
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({
          id: id(),
          kind: message.role === "user" ? "user" : "assistant",
          text: b.text,
          turn: 0,
        });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        if (typeof b.id === "string") {
          pendingCalls.set(b.id, { name: b.name, input: b.input });
        }
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const call = pendingCalls.get(b.tool_use_id);
        pendingCalls.delete(b.tool_use_id);
        const name = call?.name ?? "tool";
        const success = b.is_error !== true;
        // Stored results are serialized, so the summariser would otherwise
        // see an opaque string and report "N lines" instead of the counted
        // summary a live turn produces. Parse when it looks like JSON.
        let output: unknown = b.content;
        if (typeof output === "string") {
          const trimmed = output.trim();
          if (trimmed.length <= 32_768 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
            try {
              output = JSON.parse(trimmed);
            } catch {
              // Not JSON after all; the raw string is still a fine summary input.
            }
          }
        }
        const restoredCall = { name, arguments: call?.input };
        const restoredResult = { success, output, error: success ? null : String(b.content ?? "") };
        out.push({
          id: id(),
          kind: "tool",
          text: name,
          detail: formatToolResult(restoredCall, restoredResult),
          toolPreview: projectToolPreview(restoredCall, restoredResult),
          // Carry the argument one-liner too (as a live turn does), so a
          // restored session's `save_finding` calls feed the findings sidebar.
          toolArgs: formatToolArgs(restoredCall),
          success,
          turn: 0,
          // Rebuild the rich-card fields from the serialized transcript. The
          // display-only `meta` was never serialized (it never reaches the
          // model), so a restored card carries only what the model transcript
          // holds — the command + its output, or the patch envelope — and no
          // wall/timeout footer.
          ...restoredToolCardFields(name, call?.input, b.content, success),
        });
      }
    }
  }

  // A call with no recorded result still happened; show it as unresolved
  // rather than dropping evidence silently.
  for (const [, call] of pendingCalls) {
    out.push({
      id: id(),
      kind: "tool",
      text: call.name,
      detail: formatToolArgs({ name: call.name, arguments: call.input }),
      turn: 0,
    });
  }
  return out;
}

/** A finding surfaced this run: a title, a normalised severity, and — when the
 * `save_finding` result reported one — the persisted finding id so the sidebar
 * row can open the full detail view. */
export interface RunFinding {
  title: string;
  severity: string;
  /** Persisted finding id, when the tool result carried one. */
  id?: string;
}

/**
 * This run's findings, read from the transcript itself: every successful
 * `save_finding` tool call, newest last. The argument one-liner is
 * `"<severity> <category>: <title>"` (see tool-format), so the leading word is
 * the severity and the text after the colon is the title. Deriving from the
 * entries the screen already holds means the right sidebar needs no new event
 * plumbing and works identically for a live turn and a restored session.
 */
export function runFindingsFromEntries(entries: readonly ChatEntry[]): RunFinding[] {
  const out: RunFinding[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.text !== "save_finding") continue;
    if (entry.success === false) continue;
    const raw = (entry.toolArgs ?? entry.detail ?? "").trim();
    if (!raw) continue;
    const colon = raw.indexOf(": ");
    const head = colon >= 0 ? raw.slice(0, colon) : "";
    const title = (colon >= 0 ? raw.slice(colon + 2) : raw).trim();
    const severity = (head.split(/\s+/)[0] || "info").toLowerCase();
    // The formatted result one-liner is "saved <id>" (see tool-format.ts), so
    // the persisted id can be recovered without new event plumbing. Missing on
    // a restored session whose result text was not stored — the row then falls
    // back to a non-clickable entry.
    const idMatch = (entry.detail ?? "").match(/^saved\s+(\S+)/);
    out.push({ title: title || "(untitled finding)", severity, id: idMatch?.[1] });
  }
  return out;
}

const REPOSITORY_STARTERS = [
  {
    label: "Deep vulnerability review",
    prompt: "Deeply review this Git repository for exploitable security vulnerabilities. Map entry points and trust boundaries, verify findings against code or tests, and return evidence, severity, impact, and safe remediation. Read-only: do not modify files, install packages, or access the network.",
  },
  {
    label: "Auth & secrets",
    prompt: "Review authentication, authorization, tenant boundaries, and secret handling in this Git repository. Trace the relevant flows and report only evidence-backed weaknesses. Read-only: do not modify files or access the network.",
  },
  {
    label: "Dependency risk",
    prompt: "Review dependency manifests and lockfiles in this Git repository for security risk. Do not install, update, or access the network; distinguish local evidence from anything requiring a live advisory check.",
  },
] as const;
const COMPACT_REPOSITORY_STARTERS = REPOSITORY_STARTERS.slice(0, 2);


/** Window after a first Ctrl+C in which a second Ctrl+C confirms the quit. */
const EXIT_CONFIRM_MS = 3000;

/** Upper bound for model-token publication; input and approvals stay immediate. */
const STREAM_PRESENTATION_INTERVAL_MS = 33;

/** Max transcript entries retained per subagent — the tail is all the focus
 * view can show anyway, and it bounds memory across a large child fleet. */
const SUBAGENT_TRANSCRIPT_MAX = 300;

const EMPTY_EXPANDED_TURNS: ReadonlySet<number> = new Set();

/**
 * Parse a compaction-threshold setting (`"80%"`) into the fraction the core
 * loop expects (`0.80`). Falls back to the 0.80 default on anything unparseable,
 * so a malformed setting never disables compaction with a NaN threshold.
 */
function parsePct(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n / 100 : 0.8;
}

/** The inline transcript indicator text for a (non-degraded) compaction row. */
function compactionIndicatorText(tokensBefore: number, tokensAfter?: number): string {
  return `⊟ compacted · ${tokensBefore}→${tokensAfter ?? "?"} · [⌃O]`;
}


export function ChatScreen({
  options,
  onGoBack,
  onNavigate,
  onExit,
  onConnectionFailure,
  submitHandle,
  stagePromptHandle,
  reconnectHandle,

  onSessionChange,
  onWorkingChange,
  onNextChatOptions,
  pluginHostManager,
  evolutionStatus,
  interactive,
  messagingHomeDir,
  protectedSessionIds,
  onAuditActivity,
  closeHandle,
  herdHandle,
  runtimeInfoHandle,
}: ChatScreenProps) {
  const devUi = useDevUiBoundary(`chat:${messagingHomeDir}`);
  const connectionFailureRef = useDevUiRef(devUi, "connectionFailureRef", onConnectionFailure);
  connectionFailureRef.current = onConnectionFailure;
  const [entries, setEntries] = useDevUiState<ChatEntry[]>(devUi, "entries", []);
  const entriesRef = useDevUiRef<ChatEntry[]>(devUi, "entriesRef", []);
  entriesRef.current = entries;
  const pendingStreamPatches = useDevUiRef<StreamPatch[]>(devUi, "pendingStreamPatches", []);
  const streamPresentationTimer = useDevUiRef<NodeJS.Timeout | undefined>(devUi, "streamPresentationTimer", undefined);
  const flushStreamPatches = useCallback(() => {
    const pending = pendingStreamPatches.current;
    if (streamPresentationTimer.current) {
      clearTimeout(streamPresentationTimer.current);
      streamPresentationTimer.current = undefined;
    }
    if (pending.length === 0) return;

    pendingStreamPatches.current = [];
    setEntries((current) => applyStreamPatches(current, pending, (patch) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: patch.kind,
      text: patch.text,
      turn: patch.turn,
      at: patch.at,
    })));
  }, []);
  const queueStreamPatch = useCallback((patch: StreamPatch) => {
    pendingStreamPatches.current = enqueueStreamPatch(pendingStreamPatches.current, patch);
    if (streamPresentationTimer.current) return;

    streamPresentationTimer.current = setTimeout(() => {
      streamPresentationTimer.current = undefined;
      flushStreamPatches();
    }, STREAM_PRESENTATION_INTERVAL_MS);
  }, [flushStreamPatches]);
  const discardStreamPatches = useCallback(() => {
    pendingStreamPatches.current = [];
    if (!streamPresentationTimer.current) return;
    clearTimeout(streamPresentationTimer.current);
    streamPresentationTimer.current = undefined;
  }, []);
  useEffect(() => discardStreamPatches, [discardStreamPatches]);
  const [session, setSession] = useDevUiState<ConsoleSession | null>(devUi, "session", null);
  const initialPromptRef = useDevUiRef(devUi, "initialPromptRef", options?.initialPrompt?.trim() || null);
  const presentationEmitterRef = useDevUiRef<PresentationEmitter | null>(devUi, "presentationEmitterRef", null);
  if (!presentationEmitterRef.current) {
    presentationEmitterRef.current = createPresentationEmitter();
  }
  const presentedEntriesRef = useDevUiRef(devUi, "presentedEntriesRef", new Map<string, ChatEntry>());
  const presentedSessionIdRef = useDevUiRef<string | undefined>(devUi, "presentedSessionIdRef", undefined);
  const [modelId, setModelId] = useDevUiState<string | null>(devUi, "modelId", null);
  const [git, setGit] = useDevUiState<GitStatus | null>(devUi, "git", null);
  const [clockTick, setClockTick] = useDevUiState(devUi, "clockTick", () => Date.now());
  const [animTick, setAnimTick] = useDevUiState(devUi, "animTick", 0);
  /**
   * One shared frame counter for the loading shimmer, ticked at
   * `SHIMMER_TEXT_INTERVAL_MS` while a turn is running (see the effect below).
   * The live activity line and every running tool/subagent row read the SAME
   * frame, so their sweeps stay in phase; it is only advanced when there is
   * something to shimmer, so an idle console costs no repaints.
   */
  const [shimmerFrame, setShimmerFrame] = useDevUiState(devUi, "shimmerFrame", 0);
  /** Frame counter for the empty-state logo intro; driven by the ticker below. */
  const [logoFrame, setLogoFrame] = useDevUiState(devUi, "logoFrame", 0);
  /**
   * Masked credential entry. Held in component state only, written
   * straight to the 0600 store, and never appended to the transcript —
   * a secret must not end up in scrollback or an evidence record.
   */
  const [secretPrompt, setSecretPrompt] = useState<
    { providerId: string; label: string; envVar: string; value: string } | null
  >(null);
  // Live settings from the process-wide store: every screen subscribes to the
  // same source, so a change made in the settings screen re-renders chat
  // immediately instead of waiting for a remount that (now chat stays mounted
  // for the whole session) never comes.
  const settings = useSettings();
  // Live colour palette, derived from `settings.theme` and delivered
  // subscribably. Read once at the top of the component (hook rules) and
  // threaded into the module-level render helpers that cannot call the hook.
  const theme = useTheme();
  const {
    PRIMARY,
    MUTED,
    TEXT,
    ERROR,
    WARNING,
    INFO,
    ACCENT,
    PANEL,
    PANEL_ALT,
    CANVAS,
  } = theme;
  // Dark/legible text for the orange (PRIMARY) header strip — theme-picked so
  // it reads on every palette's signature colour.
  const headerFg = readableOnPrimary(theme);
  // The OpenTUI renderer, for the OSC-52 clipboard path (copy-on-highlight).
  // OpenTUI owns the framebuffer, so the terminal's native mouse-selection is
  // off; we re-add copy-on-highlight ourselves and must never touch raw stdout.
  const renderer = useRenderer();
  // The transient "Copied N bytes" pill. reduceMotion collapses its fade to a
  // single appear/dismiss (the toast module honours the flag).
  const { showToast, frame: toastFrame } = useToast({ reduceMotion: settings.reduceMotion });
  /**
   * Clipboard writer for copy-on-highlight.
   *
   * The renderer exposes `copyToClipboardOSC52(text)` — its own SAFE OSC-52
   * writer: it builds the escape sequence AND writes it through the renderer's
   * output path (never process.stdout), returning whether the terminal
   * accepted it. That is a different shape from clipboard.ts's `emit` (which
   * takes a PRE-BUILT sequence and returns void), so we adapt it as a `copy`
   * instead: OSC-52 via the renderer when supported, otherwise the platform
   * subprocess (defaultSpawn/defaultWhich, forwarded by the hook). Every branch
   * is feature-detected and swallows failure, so a renderer without the API —
   * or a host with no clipboard tool — degrades to "no copy", never a crash.
   */
  const copySelection = useCallback<SelectionCopyFn>((text, opts) => {
    const bytes = Buffer.byteLength(text, "utf8");
    try {
      if (
        renderer &&
        typeof renderer.isOsc52Supported === "function" &&
        renderer.isOsc52Supported() &&
        typeof renderer.copyToClipboardOSC52 === "function" &&
        renderer.copyToClipboardOSC52(text)
      ) {
        return Promise.resolve({ ok: true, method: "osc52", bytes });
      }
    } catch {
      // Fall through to the subprocess path below.
    }
    return copyToClipboard(text, {
      spawn: opts?.spawn,
      which: opts?.which,
      platform: opts?.platform,
      osc52: opts?.osc52,
    });
  }, [renderer]);
  useSelectionCopy({
    copy: copySelection,
    spawn: defaultSpawn,
    which: defaultWhich,
    onCopied: ({ bytes }) => showToast(`Copied ${bytes} bytes`),
  });
  // Right-click context menu over the transcript. Purely additive: it opens
  // only on a right press (button 2) and only when mouse support is on, so the
  // left-click / drag-to-select / keyboard paths are untouched.
  const transcriptMenu = useContextMenu();
  const copyMenuText = useCallback(
    (text: string, label: string) => {
      void copySelection(text, { spawn: defaultSpawn, which: defaultWhich }).then(
        (result) => showToast(result.ok ? `Copied ${label}` : "Copy failed"),
      );
    },
    [copySelection, showToast],
  );
  const buildMessageMenuItems = useCallback(
    (entry: ChatEntry): ContextMenuItem[] => {
      const text = entry.text ?? "";
      const items: ContextMenuItem[] = [
        {
          label: "Copy message",
          disabled: text.trim().length === 0,
          onSelect: () => copyMenuText(text, "message"),
        },
      ];
      const code = firstCodeBlock(text);
      if (code) {
        items.push({
          label: "Copy code block",
          onSelect: () => copyMenuText(code, "code block"),
        });
      }
      return items;
    },
    [copyMenuText],
  );
  /**
   * Per-turn transcript expansion. In collapsed mode each turn's successful
   * tool/reasoning steps fold to one ▸ line; clicking that line adds the turn
   * here so `planTranscript` renders it in full (and the steps show a ▾
   * affordance whose click removes it again). Independent of the global Ctrl+R
   * detail toggle, which flips every turn at once via the settings store.
   */
  const [expandedTurnsByAgent, setExpandedTurnsByAgent] = useDevUiState<ReadonlyMap<string | null, ReadonlySet<number>>>(devUi, "expandedTurnsByAgent", () => new Map());
  // ── Context-compaction status ────────────────────────────────────────────────
  // Report each compaction once to the live worker telemetry.
  const [latestCompaction, setLatestCompaction] = useDevUiState<number | undefined>(devUi, "latestCompaction", undefined);
  // The next planner sample replaces the estimated post-compaction size in the
  // inline notice with measured context occupancy.
  const pendingCompactionRef = useDevUiRef<{ compactionNumber: number; tokensBefore: number } | undefined>(
    devUi, "pendingCompactionRef", undefined,
  );
  useEffect(() => {
    const emitter = presentationEmitterRef.current!;
    if (!session) return;
    const correlation = { sessionId: session.scanId };
    emitter.emit("session.opened", {
      target: session.target,
    }, correlation);
    return () => {
      emitter.emit("session.closed", {}, correlation);
    };
  }, [session]);
  useEffect(() => {
    const emitter = presentationEmitterRef.current!;
    const sessionId = session?.scanId;
    if (!sessionId) return;
    if (presentedSessionIdRef.current !== sessionId) {
      presentedSessionIdRef.current = sessionId;
      presentedEntriesRef.current.clear();
    }
    const previous = presentedEntriesRef.current;
    const next = new Map<string, ChatEntry>();
    for (const entry of entries) {
      const prior = previous.get(entry.id);
      if (!prior) {
        emitter.emit("session.transcript.append", { entry }, { sessionId });
      } else if (prior !== entry) {
        emitter.emit("session.transcript.replace", { entry }, { sessionId });
      }
      next.set(entry.id, entry);
    }
    presentedEntriesRef.current = next;
  }, [entries, session?.scanId]);
  /** The turn currently under the mouse, for the subtle hover highlight. */
  const [hoveredTurn, setHoveredTurn] = useDevUiState<number | null>(devUi, "hoveredTurn", null);
  // The output-guard subscription is registered once; a ref lets it read
  // the live setting without tearing down and re-adding the listener.
  const settingsRef = useDevUiRef(devUi, "settingsRef", settings);
  settingsRef.current = settings;
  /**
   * Open a small inline picker. `commit` runs with the chosen item id; the
   * overlay owns no domain logic and is used by model/theme selection.
   */
  const [picker, setPicker] = useState<
    {
      state: SelectorState;
      commit: (id: string) => void;
      // Live preview as the highlight moves (e.g. /theme repaints the console);
      // onCancel reverts a preview when the picker is dismissed with Esc.
      onHighlight?: (id: string) => void;
      onCancel?: () => void;
    } | null
  >(null);
  const pickerRef = useDevUiRef(devUi, "pickerRef", picker);
  pickerRef.current = picker;
  // Fire onHighlight whenever the highlighted row changes (incl. on open), so a
  // picker can preview the highlighted choice without committing it.
  const pickerHighlightId = picker ? highlighted(picker.state)?.id : undefined;
  useEffect(() => {
    if (pickerHighlightId) pickerRef.current?.onHighlight?.(pickerHighlightId);
  }, [pickerHighlightId]);
  const [sessionTokens, setSessionTokens] = useDevUiState(devUi, "sessionTokens", { input: 0, output: 0 });
  /** Live turn-budget consumption, updated per model call. */
  const [turnBudget, setTurnBudget] = useDevUiState<{ used: number; limit: number } | null>(devUi, "turnBudget", null);
  const [startupError, setStartupError] = useDevUiState<{ text: string } | null>(devUi, "startupError", null);
  const [checkingModel, setCheckingModel] = useDevUiState(devUi, "checkingModel", false);
  const runtimeReadyRef = useDevUiRef(devUi, "runtimeReadyRef", false);
  const runtimeCheckEpoch = useDevUiRef(devUi, "runtimeCheckEpoch", 0);
  const [mode, setMode] = useDevUiState<ConsoleAutonomyMode>(devUi, "mode", options?.autonomyMode ?? DEFAULT_AUTONOMY_MODE);
  /**
   * The live autonomy mode, for callbacks that must not be rebuilt when it
   * changes. `buildSession` in particular is a `useCallback` that reruns on
   * `/model`; reading the ref is what keeps a model switch from silently
   * reverting the operator's mode.
   */
  const modeRef = useDevUiRef<ConsoleAutonomyMode>(devUi, "modeRef", options?.autonomyMode ?? DEFAULT_AUTONOMY_MODE);
  modeRef.current = mode;
  const target = session?.target ?? options?.target ?? "";
  const [scopeRules, setScopeRules] = useDevUiState<string[]>(devUi, "scopeRules", options?.scope?.raw.in_scope ?? []);
  const [busy, setBusy] = useDevUiState(devUi, "busy", false);
  const sourceFixAbortRef = useDevUiRef<AbortController | null>(devUi, "sourceFixAbortRef", null);
  const sourceFixPromiseRef = useDevUiRef<Promise<void> | null>(devUi, "sourceFixPromiseRef", null);
  const sourceFixCandidatesRef = useDevUiRef(devUi, "sourceFixCandidatesRef", new Map<string, SourceFixResult>());
  const [fixWorking, setFixWorking] = useDevUiState(devUi, "fixWorking", false);
  useEffect(() => () => sourceFixAbortRef.current?.abort(), []);
  const activeTurnStartedAt = useDevUiRef<number | null>(devUi, "activeTurnStartedAt", null);
  useEffect(() => {
    onSessionChange?.(session);
    return () => { if (!isDevUiRemount()) onSessionChange?.(null); };
  }, [onSessionChange, session]);
  useEffect(() => {
    onWorkingChange?.(busy || fixWorking);
    return () => { if (!isDevUiRemount()) onWorkingChange?.(false); };
  }, [onWorkingChange, busy, fixWorking]);
  /**
   * Messages typed while a turn was in flight, delivered FIFO once it ends.
   * A ref rather than state because the keyboard handler writes it
   * synchronously; `queuedMessages` mirrors it (not just a count) so the sticky
   * queue block near the composer can show WHAT is parked, not only how much.
   */
  const queuedRef = useDevUiRef<string[]>(devUi, "queuedRef", []);
  const [queuedMessages, setQueuedMessages] = useDevUiState<string[]>(devUi, "queuedMessages", []);
  const queuedCount = queuedMessages.length;
  const [composer, setComposer] = useDevUiState(devUi, "composer", "");
  const [composerCursor, setComposerCursor] = useDevUiState(devUi, "composerCursor", 0);
  const [composing, setComposing] = useDevUiState(devUi, "composing", false);
  const paletteDraftRef = useDevUiRef<{ text: string; composing: boolean } | null>(devUi, "paletteDraftRef", null);
  const [commandMenuOpen, setCommandMenuOpen] = useDevUiState(devUi, "commandMenuOpen", false);
  const [slashSelected, setSlashSelected] = useDevUiState(devUi, "slashSelected", 0);
  const [pendingScope, setPendingScope] = useDevUiState<PendingScope | null>(devUi, "pendingScope", null);
  const [pendingLocalScope, setPendingLocalScope] = useDevUiState<PendingLocalScope | null>(devUi, "pendingLocalScope", null);
  const [pendingEscalation, setPendingEscalation] = useDevUiState<PendingEscalation | null>(devUi, "pendingEscalation", null);
  const [pendingToolApproval, setPendingToolApproval] = useDevUiState<PendingToolApproval | null>(devUi, "pendingToolApproval", null);
  const [pendingOperatorQuestion, setPendingOperatorQuestion] = useDevUiState<PendingOperatorQuestion | null>(devUi, "pendingOperatorQuestion", null);
  /**
   * Live edit state for the `ask_operator` modal (cursor, selections, custom
   * text). Reset from the pending request whenever a new question arrives; the
   * keyboard handler mutates it through the pure operator-question reducers.
   */
  const [operatorState, setOperatorStateValue] = useDevUiState<OperatorQuestionState | null>(devUi, "operatorState", null);
  const operatorStateRef = useDevUiRef<OperatorQuestionState | null>(devUi, "operatorStateRef", operatorState);
  operatorStateRef.current = operatorState;
  // A command and Enter can arrive in one terminal burst before React paints.
  // Resolve against the synchronously edited value, never the previous frame.
  const setOperatorState = useCallback((next: SetStateAction<OperatorQuestionState | null>) => {
    operatorStateRef.current = typeof next === "function" ? next(operatorStateRef.current) : next;
    setOperatorStateValue(operatorStateRef.current);
  }, [setOperatorStateValue]);
  const [activeSubagents, setActiveSubagents] = useDevUiState<Record<string, SubagentLifecyclePayload>>(devUi, "activeSubagents", {});
  // Live id → display-name map for agents, fed from lifecycle events. Used by the
  // peer_message (IRC) handler to resolve a message's from/to ids to the same
  // AdjectiveNoun names the roster shows, without re-reading React state inside
  // the bus callback. Main is always itself.
  const agentNamesRef = useDevUiRef<Map<string, string>>(devUi, "agentNamesRef", new Map());
  // Per-subagent live transcript (assistant prose + tool cards), assembled from
  // `subagent_message` events. Keyed by agent_id; rendered by the focus view via
  // the SAME planTranscript/renderEntry as the main transcript, so a drilled-in
  // child reads exactly like the main agent. Bounded per agent (the tail is what
  // fits on screen anyway).
  const [subagentTranscripts, setSubagentTranscripts] = useDevUiState<Record<string, ChatEntry[]>>(devUi, "subagentTranscripts", {});
  const finalizedWorkerTurns = useDevUiRef<Map<string, Set<number>>>(devUi, "finalizedWorkerTurns", new Map());
  const [workerTelemetry, setWorkerTelemetry] = useDevUiState<Record<string, WorkerTelemetry>>(devUi, "workerTelemetry", {});
  const [commsMessages, setCommsMessages] = useDevUiState<CommsMessage[]>(devUi, "commsMessages", []);
  const commsSequenceRef = useDevUiRef(devUi, "commsSequenceRef", 0);
  const [workerOutcomes, setWorkerOutcomes] = useDevUiState<Record<string, SubagentLifecyclePayload>>(devUi, "workerOutcomes", {});
  const [lastContext, setLastContext] = useDevUiState<number>(devUi, "lastContext");
  /**
   * Two-press quit. Ctrl+C used to exit immediately; now the first press ARMS
   * (a toast warns, noting any running subagents that would be stopped) and a
   * second Ctrl+C within the window actually quits. Ref-based so the many
   * keyboard branches can call it without re-subscribing the handler.
   */
  const exitArmedRef = useDevUiRef(devUi, "exitArmedRef", 0);
  const requestExit = useCallback((cleanup?: () => void) => {
    const now = Date.now();
    if (now - exitArmedRef.current < EXIT_CONFIRM_MS) {
      cleanup?.();
      onExit();
      return;
    }
    exitArmedRef.current = now;
    const running = Object.keys(activeSubagents).length;
    showToast(
      running > 0
        ? `Press Ctrl+C again to quit — ${running} subagent${running === 1 ? "" : "s"} will be stopped`
        : "Press Ctrl+C again to quit",
    );
  }, [onExit, showToast, activeSubagents]);
  const requestExitRef = useDevUiRef(devUi, "requestExitRef", requestExit);
  requestExitRef.current = requestExit;
  /** Latest plan snapshot from the `update_todos` tool (the `todos` bus event). */
  const [todos, setTodos] = useDevUiState<TodosEventPayload | null>(devUi, "todos", null);
  /** Feedback staged for /feedback send (submitPreview is null when blocked). */
  const [pendingFeedback, setPendingFeedback] = useState<{
    payload: FeedbackPayload;
    preview: { url: string; body: string; headers: Record<string, string>; warnings: string[] } | null;
  } | null>(null);
  const latestProblemRef = useDevUiRef<FeedbackPayload | null>(devUi, "latestProblemRef", null);
  const reportedProblemsRef = useDevUiRef(devUi, "reportedProblemsRef", new Set<string>());
  const [problemReview, setProblemReview] = useState<FeedbackPayload | null>(null);
  // First-ever problem report: until the operator has answered the consent
  // prompt once (diagnosticReportingPrompted), an "automatic" policy must not
  // silently transmit — hold the payload and ask first.
  const [firstProblemConsent, setFirstProblemConsent] = useState<FeedbackPayload | null>(null);
  // The OMP-style "what am I working on" objective for the bottom-bar pill.
  // Empty ("") hides the pill; the session-objective service replaces it in
  // place (heuristic first, model-refined when/if it lands).
  const [objective, setObjective] = useDevUiState<string>(devUi, "objective", "");
  // Read the latest objective from `send`'s finally (which is a useCallback and
  // would otherwise close over a stale value) without re-subscribing it.
  const objectiveRef = useDevUiRef(devUi, "objectiveRef", objective);
  objectiveRef.current = objective;
  /**
   * The richer live-subagent model the herd view is built on: latest snapshot
   * plus a bounded activity ring per agent, keyed by `agent_id`, fed by the SAME
   * pure reducers herd-layout exposes. This is the single source for BOTH the
   * right rail and the inline focus view, so neither reimplements the plumbing.
   */
  const [herdAgents, setHerdAgentsState] = useDevUiState<HerdSubagentMap>(devUi, "herdAgents", {});
  const [operatorStopped, setOperatorStopped] = useDevUiState<ReadonlySet<string>>(devUi, "operatorStopped", () => new Set());
  const workerEpochsRef = useDevUiRef(devUi, "workerEpochsRef", new Map<string, number>());
  const herdAgentsRef = useDevUiRef(devUi, "herdAgentsRef", herdAgents);
  const setHerdAgents = useCallback((next: HerdSubagentMap) => {
    herdAgentsRef.current = next;
    setHerdAgentsState(next);
  }, []);
  const projectedHerdAgents = useMemo(() => {
    let projected: HerdSubagentMap | undefined;
    for (const id in herdAgents) {
      const worker = herdAgents[id];
      const done = workerOutcomes[id]?.done;
      const stopped = operatorStopped.has(id);
      if (worker.done === done && Boolean(worker.operatorStopped) === stopped) continue;
      (projected ??= { ...herdAgents })[id] = { ...worker, done, operatorStopped: stopped };
    }
    return projected ?? herdAgents;
  }, [herdAgents, operatorStopped, workerOutcomes]);
  const projectedHerdRef = useDevUiRef(devUi, "projectedHerdRef", projectedHerdAgents);
  projectedHerdRef.current = projectedHerdAgents;
  herdHandle.current = useCallback(() => projectedHerdRef.current, []);
  const workerRosterRecords = useMemo(() => Object.values(herdAgents).map((agent) => ({
    ...workerOutcomes[agent.agentId],
    agent_id: agent.agentId, parent_scan_id: agent.parentScanId,
    name: agent.name, task: agent.task, status: agent.status,
    max_turns: agent.maxTurns, turns: agent.turns ?? agent.turn,
  })), [herdAgents, workerOutcomes]);
  const agentTree = useMemo(
    () => projectAgentForest(workerRosterRecords, session?.scanId),
    [workerRosterRecords, session?.scanId],
  );
  const liveAgentTree = useMemo(
    () => projectLiveAgentForest(workerRosterRecords, session?.scanId),
    [workerRosterRecords, session?.scanId],
  );
  // Sibling arrival order is stable; preorder keeps each projected subtree contiguous.
  const workerRoster = useMemo(() => liveAgentTree.map((row) => row.item), [liveAgentTree]);
  const runningSpawnChildren = useMemo(
    () => workerRosterRecords.filter((worker) =>
      worker.parent_scan_id === session?.scanId
      && !operatorStopped.has(worker.agent_id)
      && (worker.status === "running" || worker.status === "queued"),
    ).length,
    [workerRosterRecords, session?.scanId, operatorStopped],
  );
  useEffect(() => {
    let runningWorkers = 0;
    let parkedWorkers = 0;
    for (const worker of workerRoster) {
      if (operatorStopped.has(worker.agent_id)) continue;
      if (worker.status === "running" || worker.status === "queued") runningWorkers += 1;
      else if (worker.status === "parked") parkedWorkers += 1;
    }
    onAuditActivity({
      workers: runningWorkers + parkedWorkers,
      waiting: Boolean(pendingScope || pendingLocalScope || pendingEscalation || pendingToolApproval || pendingOperatorQuestion)
        || (!busy && runningWorkers === 0 && parkedWorkers > 0),
    });
  }, [busy, entries, workerRoster, operatorStopped, pendingScope, pendingLocalScope, pendingEscalation, pendingToolApproval, pendingOperatorQuestion, onAuditActivity]);
  /** Main and workers share one chat surface; each thread keeps its own draft. */
  const [focusAgentId, setFocusAgentId] = useDevUiState<string | null>(devUi, "focusAgentId", null);
  const focusAgentRef = useDevUiRef<string | null>(devUi, "focusAgentRef", focusAgentId);
  focusAgentRef.current = focusAgentId;
  const workerDraftRef = useDevUiRef<{ text: string; cursor: number; composing: boolean } | null>(devUi, "workerDraftRef", null);
  const workerDraftsRef = useDevUiRef<Map<string, { text: string; cursor: number; composing: boolean }>>(devUi, "workerDraftsRef", new Map());
  const expandedTurns = expandedTurnsByAgent.get(focusAgentId) ?? EMPTY_EXPANDED_TURNS;
  const toggleTurnExpanded = useCallback((turn: number) => {
    setExpandedTurnsByAgent((previous) => {
      const turns = new Set(previous.get(focusAgentId));
      if (turns.has(turn)) turns.delete(turn);
      else turns.add(turn);
      const next = new Map(previous);
      next.set(focusAgentId, turns);
      return next;
    });
  }, [focusAgentId]);
  const focusEntries = focusAgentId ? subagentTranscripts[focusAgentId] : undefined;
  const focusTask = focusAgentId ? herdAgents[focusAgentId]?.task : undefined;
  const focusedTranscript = useMemo<ChatEntry[]>(() => [
    ...(focusTask ? [{ id: `${focusAgentId}-task`, kind: "user" as const, text: focusTask, turn: 0 }] : []),
    ...(focusEntries ?? []),
  ], [focusAgentId, focusTask, focusEntries]);
  const { width, height } = useTerminalDimensions();
  const alive = useDevUiRef(devUi, "alive", true);
  const closingRef = useDevUiRef(devUi, "closingRef", false);
  const initializedView = useDevUiRef(devUi, "initializedView", false);
  const pendingCancellationsRef = useDevUiRef(devUi, "pendingCancellationsRef", new Set<() => void>());
  const trackedRequest = useCallback(<T,>(denied: T) => {
    const deferred = Promise.withResolvers<T>();
    const cancel = () => deferred.resolve(denied);
    pendingCancellationsRef.current.add(cancel);
    void deferred.promise.then(() => pendingCancellationsRef.current.delete(cancel));
    return deferred;
  }, []);
  // Mirror the latest render values so the plugin-host effect can rebuild the
  // session in place without re-subscribing on every state change.
  const sessionRef = useDevUiRef(devUi, "sessionRef", session);
  sessionRef.current = session;
  const busyRef = useDevUiRef(devUi, "busyRef", busy);
  busyRef.current = busy;
  const modelIdRef = useDevUiRef(devUi, "modelIdRef", modelId);
  modelIdRef.current = modelId;
  // The live runtime for the current session, published by buildSession so the
  // live-apply path can reconfigure it in place without capturing a specific
  // runtime in a closure (a rebuild swaps the reference here).
  const runtimeRef = useDevUiRef<ReturnType<typeof createConsoleRuntime> | null>(devUi, "runtimeRef", null);
  const pendingModelPreferenceRef = useDevUiRef<LlmApiRuntime | null>(devUi, "pendingModelPreferenceRef", null);
  const sessionBuildEpoch = useDevUiRef(devUi, "sessionBuildEpoch", 0);
  // A selection that arrived mid-turn. NEVER reconfigure mid-turn; this is
  // flushed to the live runtime in send()'s completion path, where busy flips
  // back to false. Last-writer-wins per field, agentModels merged.
  const pendingSelectionRef = useDevUiRef<{
    model?: string;
    providerId?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
  } | null>(devUi, "pendingSelectionRef", null);
  // Latest idle-apply core + busy-aware handle, kept in refs so buildSession
  // and send() can reach them without dep churn or TDZ ordering constraints.
  const applyRuntimeSelectionRef = useDevUiRef<((sel: {
    model?: string;
    providerId?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
  }) => void) | null>(devUi, "applyRuntimeSelectionRef", null);
  const applySelectionRef = useDevUiRef<((sel: {
    model?: string;
    providerId?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
  }) => void) | null>(devUi, "applySelectionRef", null);
  const turn = useDevUiRef(devUi, "turn", 0);
  // Pane geometry reserves the central composer and independent full-height rails.
  const layout = computeChatLayout({ width, height, statusTextLength: 0 });
  const compact = layout.compact;
  const contentWidth = Math.max(1, width - (compact ? 2 : 4));
  const bodyHeight = Math.max(0, height - 3);
  const approvalWidth = Math.max(1, contentWidth - 2);
  const controlsWidth = contentWidth;
  const composerRef = useDevUiRef(devUi, "composerRef", "");
  const composerCursorRef = useDevUiRef(devUi, "composerCursorRef", 0);
  // OMP-style paste collapsing: long text and image-path pastes are stashed here
  // and represented in the composer by a compact chip marker; `pasteCounterRef`
  // is the monotonic chip number N (shared across text and image chips so their
  // store keys never collide). Expanded back to full payloads at the Enter
  // boundary — see the return handler — then the consumed keys are cleared.
  const pasteStoreRef = useDevUiRef<PasteStore>(devUi, "pasteStoreRef", createPasteStore());
  const pasteCounterRef = useDevUiRef(devUi, "pasteCounterRef", 0);
  const composingRef = useDevUiRef(devUi, "composingRef", false);
  const commandMenuOpenRef = useDevUiRef(devUi, "commandMenuOpenRef", false);
  /**
   * Shell-style recall of submitted operator messages. `historyRef` is the
   * ring (oldest first), `historyIndexRef` the cursor (>= length means "editing
   * the live draft, not browsing") and `historyDraftRef` the draft saved on the
   * first Up so Down can restore it. The pure transitions live in
   * composer-history.ts; these refs are written synchronously from the keyboard
   * handler, so they are refs rather than state.
   */
  const historyRef = useDevUiRef<string[]>(devUi, "historyRef", []);
  const historyIndexRef = useDevUiRef(devUi, "historyIndexRef", 0);
  const historyDraftRef = useDevUiRef(devUi, "historyDraftRef", "");
  /**
   * The transcript scrollbox, so PageUp/PageDown can drive it directly. The box
   * is deliberately NOT focusable (see the `focusable={false}` prop): plain
   * Up/Down belong to composer history, never to scrolling.
   */
  const transcriptRef = useRef<ScrollBoxRenderable | null>(null);
  // The drilled-in subagent's transcript scrollbox (auto-follows newest, like
  // the main one); pageup/pagedown scroll it while focused.
  /** The `ask_operator` modal body scrollbox, scrolled to keep the active row visible. */
  const operatorScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const commandCatalog: readonly SlashCommand[] = SLASH_COMMANDS;
  const isSlashComposer = composer.trimStart().startsWith("/");
  const slashQuery = isSlashComposer ? composer.trimStart().slice(1).split(/\s+/, 1)[0] ?? "" : "";
  // The command menu now renders through the shared `DialogSelectBody`, which
  // puts each command on ONE row (name · description · alias columns) exactly
  // like the model/theme pickers — so every entry costs a single row, compact
  // or not. The visible count is still derived from the real terminal height so
  // the box is never taller than the column can spare.
  const commandRowsPerCommand = 1;
  const commandMenuLimit = computeCommandMenuHeight({
    height,
    compact,
    rowsPerCommand: commandRowsPerCommand,
  }).maxCommands;
  const filteredSlashCommands = useMemo(
    () => isSlashComposer ? filterCommands(slashQuery) : [],
    [isSlashComposer, slashQuery],
  );
  // Every matching command is selectable — the list is no longer truncated to
  // what fits. The height-clamped box shows a window of `commandMenuLimit`
  // entries and the rows live in a <scrollbox> the selection scrolls (below), so
  // commands past the visible window are still reachable by arrowing down.
  const menuCommands = filteredSlashCommands;
  const visibleCommandRows = Math.min(menuCommands.length, commandMenuLimit);
  const selectedSlashCommand = menuCommands[slashSelected];
  const displayedScope = session ? session.scope : options?.scope;
  const scopeIncludes = displayedScope?.raw.in_scope ?? [];
  const scopeExcludes = displayedScope?.raw.out_of_scope ?? [];
  const scopeLabel = displayedScope === undefined
    ? "not configured"
    : `${scopeIncludes.length ? scopeIncludes.join(", ") : "empty · deny all"}${scopeExcludes.length ? `; excludes ${scopeExcludes.join(", ")}` : ""}`;

  useEffect(() => {
    setSlashSelected((current) => Math.min(current, Math.max(menuCommands.length - 1, 0)));
  }, [menuCommands.length]);

  const setCommandMenuVisible = useCallback((visible: boolean) => {
    commandMenuOpenRef.current = visible;
    setCommandMenuOpen(visible);
  }, []);

  const setComposerText = useCallback((value: string, cursor = value.length) => {
    composerRef.current = value;
    composerCursorRef.current = cursor;
    setComposer(value);
    setComposerCursor(cursor);
    setSlashSelected(0);
    setCommandMenuVisible(value.trimStart().startsWith("/"));
    // Any composer edit leaves history browsing and re-bases the cursor on the
    // live draft. A recall re-sets the cursor immediately after calling this.
    historyIndexRef.current = historyRef.current.length;
  }, [setCommandMenuVisible]);
  const draftRepositorySuggestion = useCallback((prompt: string) => {
    setComposerText(prompt);
    composingRef.current = true;
    setComposing(true);
  }, [setComposerText]);

  const selectAgentChat = useCallback((id: string | null) => {
    const previousId = focusAgentRef.current;
    if (id === previousId || (id && !herdAgentsRef.current[id])) return;
    const draft = { text: composerRef.current, cursor: composerCursorRef.current, composing: composingRef.current };
    if (previousId) workerDraftsRef.current.set(previousId, draft);
    else if (id) workerDraftRef.current = draft;
    const restored = id ? workerDraftsRef.current.get(id) : workerDraftRef.current;
    if (!id) workerDraftRef.current = null;
    focusAgentRef.current = id;
    setFocusAgentId(id);
    setComposerText(restored?.text ?? "", restored?.cursor ?? 0);
    composingRef.current = restored?.composing ?? false;
    setComposing(composingRef.current);
  }, [setComposerText]);
  const returnToConversation = useCallback(() => selectAgentChat(null), [selectAgentChat]);

  const moveComposerCursor = (direction: -1 | 1) => {
    const next = stepComposerCursor(composerRef.current, composerCursorRef.current, direction);
    composerCursorRef.current = next;
    setComposerCursor(next);
  };

  // Drop the store entries a submit expanded, so the map does not grow without
  // bound. Called from the composer-clear branches after Enter expands markers.
  const clearConsumedPastes = useCallback((ids: string[]) => {
    for (const id of ids) pasteStoreRef.current.delete(id);
  }, []);

  const restorePaletteDraft = useCallback(() => {
    const draft = paletteDraftRef.current;
    if (!draft) return false;
    paletteDraftRef.current = null;
    composingRef.current = draft.composing;
    setComposerText(draft.text);
    setComposing(draft.composing);
    return true;
  }, [setComposerText]);

  useEffect(() => {
    if (!stagePromptHandle) return;
    stagePromptHandle.current = (text) => {
      if (!text.trim()) return;
      restorePaletteDraft();
      const draft = composerRef.current;
      setComposerText(draft ? `${draft}\n\n${text}` : text);
      composingRef.current = true;
      setComposing(true);
    };
    return () => { stagePromptHandle.current = null; };
  }, [stagePromptHandle, restorePaletteDraft, setComposerText]);

  /**
   * Recall a previously submitted message into the composer. Up walks toward
   * older entries (saving the live draft on the first step), Down walks back
   * toward that draft. A no-op step leaves everything untouched; a real step
   * enters composing so the recalled text is editable.
   */
  const recallComposerHistory = useCallback((direction: "up" | "down") => {
    const entries = historyRef.current;
    const result = direction === "up"
      ? recallPrev(entries, historyIndexRef.current, historyDraftRef.current, composerRef.current)
      : recallNext(entries, historyIndexRef.current, historyDraftRef.current);
    if (!result.changed) return;
    if (!composingRef.current) {
      composingRef.current = true;
      setComposing(true);
    }
    setComposerText(result.value);
    // setComposerText re-based the cursor on the draft; restore the recall
    // position and remembered draft so the next step continues the walk.
    historyIndexRef.current = result.index;
    historyDraftRef.current = result.draft;
  }, [setComposerText]);

  const appendEntry = useCallback((entry: Omit<ChatEntry, "id">) => {
    flushStreamPatches();
    setEntries((current) => appendTranscriptEntry<ChatEntry>(current, {
      at: Date.now(),
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }));
  }, [flushStreamPatches]);

  const stageFeedback = useCallback((payload: FeedbackPayload) => {
    const written = appendFeedback(payload);
    if (!written.ok) {
      appendEntry({ kind: "error", text: "could not save feedback", detail: written.error, turn: turn.current });
      return;
    }
    const preview = buildSubmitPreview(payload);
    setPendingFeedback({ payload, preview });
    if (!preview) {
      const blocked = submissionBlockedReason(process.env, {}, payload);
      appendEntry({
        kind: "notice",
        text: "feedback saved locally",
        detail: blocked ? describeSkip(blocked) : "Submission is unavailable.",
        turn: turn.current,
      });
      return;
    }
    appendEntry({
      kind: "notice",
      text: "review feedback",
      detail: `Endpoint: ${preview.url}\nHeaders: ${JSON.stringify(preview.headers)}\nBody: ${preview.body}`
        + (preview.warnings.length ? `\n\nWarnings:\n${preview.warnings.join("\n")}` : "")
        + "\n\n/feedback send to submit · /feedback cancel to discard",
      turn: turn.current,
    });
  }, [appendEntry]);

  const chooseReporting = useCallback((choice: string) => {
    if (choice !== "off" && choice !== "ask" && choice !== "automatic") return;
    const saved = updateSetting("diagnosticReporting", choice, { scope: "global" });
    const recorded = updateSetting("diagnosticReportingPrompted", true, { scope: "global" });
    showToast(saved && recorded ? `Problem reports: ${choice}` : "Changed for this session only; couldn't save it.");
  }, [showToast]);

  const openReportingChoices = useCallback(() => {
    const current = settingsRef.current.diagnosticReporting;
    setPicker({
      state: createSelectorState("Problem reports", [
        { id: "off", label: "Keep reports local", detail: "Nothing is sent. You can still send one with /feedback.", current: current === "off" },
        { id: "ask", label: "Ask before sending", detail: "After a problem, show the report first. Nothing is sent until you confirm.", current: current === "ask" },
        { id: "automatic", label: "Send automatically", detail: "Error types, runtime info and scrubbed stack locations. Never messages, tool output or code.", current: current === "automatic" },
      ], current),
      commit: chooseReporting,
      onCancel: () => { restorePaletteDraft(); },
    });
  }, [chooseReporting, restorePaletteDraft]);

  const recordProblem = useCallback((kind: "tool" | "runtime", error: unknown, toolName?: string) => {
    if (!alive.current || abortRef.current?.signal.aborted) return;
    if (error instanceof Error && error.name === "AbortError") return;
    if (typeof error === "string" && /^(?:aborted|cancelled|canceled)\b|(?:operator|user).*(?:declined|rejected)|(?:was )?(?:already )?(?:declined|rejected) by (?:the )?(?:operator|user)\b|previously declined/i.test(error)) return;
    // Always capture the FULL error (stack included) to the always-on local log
    // by default — no env flag — so a failure is learnable even when the
    // surfaced line and the transmitted diagnostic are both bounded/coarse.
    // Local only; nothing here crosses a network wire.
    logProblem(kind, error, toolName);
    const payload = buildDiagnosticFeedback({
      kind, error, toolName, version: VERSION, platform: process.platform, arch: process.arch,
      runtime: process.versions.bun ? "bun" : "node",
      runtimeVersion: process.versions.bun ?? process.versions.node,
    });
    latestProblemRef.current = payload;
    const policy = settingsRef.current.diagnosticReporting;
    if (policy === "off" || submissionBlockedReason(process.env, { allowCloud: false }) === "opt-out") return;
    const key = `${policy}:${payload.message}`;
    const seen = reportedProblemsRef.current;
    if (seen.has(key)) return;
    if (seen.size >= 64) seen.delete(seen.values().next().value!);
    seen.add(key);
    // Ask before the first report, including installations with a saved automatic
    // preference. Held payloads become a picker via the effect below.
    if (!settingsRef.current.diagnosticReportingPrompted) {
      setFirstProblemConsent(payload);
      return;
    }
    if (policy === "ask") {
      setProblemReview(payload);
      return;
    }
    const written = appendFeedback(payload);
    if (!written.ok) {
      showToast("Could not save the diagnostic report.");
      return;
    }
    void submitFeedback(payload, process.env, { diagnosticConsent: { policy: settingsRef.current.diagnosticReporting } }).then((result) => {
      if (alive.current) showToast(result.ok ? "Problem report submitted" : "Problem report saved locally; couldn't send.");
    });
  }, [showToast]);

  useEffect(() => {
    if (!problemReview) return;
    if (settings.diagnosticReporting !== "ask") {
      setProblemReview(null);
      return;
    }
    if (busy || picker || pendingScope || pendingLocalScope || pendingToolApproval || pendingOperatorQuestion) return;
    const payload = problemReview;
    setProblemReview(null);
    setPicker({
      state: createSelectorState("Report this problem?", [
        { id: "review", label: "Review report", detail: "See exactly what would be sent, then decide." },
        { id: "local", label: "Keep it local", detail: "Save it on this machine only." },
        { id: "off", label: "Stop asking", detail: "Don't offer problem reports again." },
      ]),
      commit: (id) => {
        if (id === "review") stageFeedback(payload);
        else if (id === "off") chooseReporting("off");
        else if (id === "local") {
          const saved = appendFeedback(payload);
          showToast(saved.ok ? "Problem report saved locally" : "Could not save the problem report.");
        }
      },
    });
  }, [problemReview, settings.diagnosticReporting, busy, picker, pendingScope, pendingLocalScope, pendingToolApproval, pendingOperatorQuestion, stageFeedback, chooseReporting, showToast]);
  // Check the selected provider before accepting a message. A late check from
  // an old selection must not overwrite recovery.
  const checkRuntime = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || closingRef.current || stoppingAuditRef.current) return;
    const epoch = ++runtimeCheckEpoch.current;
    runtimeReadyRef.current = false;
    setCheckingModel(true);
    try {
      if (!await runtime.isAvailable()) throw new Error("Selected provider has no credentials.");
      if (!alive.current || epoch !== runtimeCheckEpoch.current || runtimeRef.current !== runtime) return;
      runtimeReadyRef.current = true;
      setStartupError(null);
      setModelId(runtime.resolvedModel());
      modelIdRef.current = runtime.resolvedModel();
      if (pendingModelPreferenceRef.current === runtime) {
        pendingModelPreferenceRef.current = null;
        if (!saveAppliedModelPreference(runtime)) {
          appendEntry({ kind: "notice", text: "Model switched, but couldn't be saved as your default", turn: turn.current });
        }
      }
    } catch (error) {
      if (!alive.current || epoch !== runtimeCheckEpoch.current || runtimeRef.current !== runtime) return;
      const detail = error instanceof Error ? error.message : String(error);
      setStartupError({ text: startupRecoveryText(detail) });
      logProblem("runtime-preflight", error);
    } finally {
      if (alive.current && epoch === runtimeCheckEpoch.current) setCheckingModel(false);
    }
  }, [appendEntry]);

  // First-report consent stays separate from analytics. Cancel defers the choice.
  useEffect(() => {
    if (!firstProblemConsent) return;
    if (settings.diagnosticReportingPrompted) {
      // Answered through the settings picker while a payload was held.
      setFirstProblemConsent(null);
      return;
    }
    if (busy || picker || pendingScope || pendingLocalScope || pendingToolApproval || pendingOperatorQuestion) return;
    const payload = firstProblemConsent;
    setFirstProblemConsent(null);
    setPicker({
      state: createSelectorState("Send problem reports to 0?", [
        { id: "automatic", label: "Send automatically", detail: "Error types, runtime info and scrubbed stack locations. Never messages, tool output or code.", current: settings.diagnosticReporting === "automatic" },
        { id: "ask", label: "Ask me each time", detail: "See exactly what would be sent first.", current: settings.diagnosticReporting === "ask" },
        { id: "off", label: "Keep reports local", detail: "Nothing is sent. You can still send one with /feedback.", current: settings.diagnosticReporting === "off" },
      ], settings.diagnosticReporting),
      commit: (id) => {
        if (id !== "automatic" && id !== "ask" && id !== "off") return;
        chooseReporting(id);
        if (id === "automatic") {
          const written = appendFeedback(payload);
          if (!written.ok) {
            showToast("Could not save the diagnostic report.");
            return;
          }
          void submitFeedback(payload, process.env, { diagnosticConsent: { policy: "automatic" } }).then((result) => {
            if (alive.current) showToast(result.ok ? "Problem report submitted" : "Problem report saved locally; couldn't send.");
          });
        } else if (id === "ask") {
          stageFeedback(payload);
        } else {
          const saved = appendFeedback(payload);
          showToast(saved.ok ? "Problem report saved locally" : "Could not save the problem report.");
        }
      },
      onCancel: () => { restorePaletteDraft(); },
    });
  }, [firstProblemConsent, settings.diagnosticReportingPrompted, settings.diagnosticReporting, busy, picker, pendingScope, pendingLocalScope, pendingToolApproval, pendingOperatorQuestion, chooseReporting, stageFeedback, showToast, restorePaletteDraft]);
  /** Construct only at initial startup, explicit new chat, or failed-start recovery. */
  const buildSession = useCallback(async (
    opts: { model?: string; providerId?: RuntimeConfig["provider"]; initialMessages?: NativeMessage[] } = {},
  ): Promise<{ session: ConsoleSession; model: string }> => {
    if (closingRef.current || stoppingAuditRef.current) throw new Error("This audit is stopping.");
    const buildEpoch = ++sessionBuildEpoch.current;
    // Resolve credentials into this construction only. Explicit shell exports
    // win, and changing a connection never mutates a live runtime's environment.
    const env = { ...process.env, ...credentialEnvPatch(loadCredentials(), process.env) };
    const { runtime, explicitChoice } = await createPreferredConsoleRuntime({
      model: (opts.providerId !== undefined ? opts.model : opts.model ?? options?.model) || undefined,
      provider: opts.providerId ?? options?.providerId,
      agentModels: options?.agentModels,
      singleModel: options?.singleModel,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }, {
      inheritedConnectionIdentity: opts.model === undefined && opts.providerId === undefined ? options?.modelConnectionIdentity : undefined,
      onDiscoveryError: (error) => recordProblem("runtime", error),
    });
    if (!alive.current || closingRef.current || stoppingAuditRef.current) throw new Error("This audit is stopping.");
    if (buildEpoch !== sessionBuildEpoch.current) throw new Error("This startup choice was superseded.");
    const resolvedModel = runtime.resolvedModel();
    // Resolve compaction from this direct/subscription runtime's model.
    const buildDiag = runtime.getConfigurationDiagnostics();
    const initialContextWindow = resolveContextLimit(
      { modelId: resolvedModel, providerId: buildDiag.provider },
    )?.tokens;
    const pluginLease = consoleExecutionProfile() === "smolvm" ? undefined : pluginHostManager?.acquire();
    let created: ConsoleSession;
    try {
    created = createLocalConsoleSession({
      runtime,
      costModel: resolvedModel,
      // Context-compaction (Stream A) inputs: the model's window drives the
      // trigger, and the operator's settings gate it + set the threshold.
      contextWindowTokens: initialContextWindow,
      compaction: {
        enabled: settingsRef.current.autoCompaction,
        thresholdFraction: parsePct(settingsRef.current.compactionThreshold),
      },
      target: options?.target,
      scope: options?.scope,
      role: options?.role,
      maxToolIterations: options?.maxToolIterations,
      allowScanners: options?.allowScanners,
      // New sessions use the shared default; an existing disabled session is
      // never reconstructed merely because its preference changes.
      allowModelSelfExtension: settingsRef.current.allowModelSelfExtension,
      // The session's approved marketplace host remains pinned through cleanup.
      pluginHost: pluginLease?.host,
      // Configured MCP servers (connected by the CLI before the TUI launched).
      // Their tools are network-gated + fenced as untrusted; the session closes
      // the host on cleanup.
      ...(options?.mcpHost ? { mcpHost: options.mcpHost } : {}),
      // Capture the operator's current mode when a session is first constructed.
      autonomyMode: modeRef.current,
      initialMessages: opts.initialMessages,
      // The parent messaging runtime. WITHOUT this, no subagent gets the
      // send_message/check_messages tools and the model correctly reports it
      // cannot coordinate — which is exactly what an operator was seeing.
      //
      // The console IS the operator's session, so the parent and the operator
      // are the same peer: operatorId is left undefined (child->operator would
      // just be child->parent, which is always on). Children address "Main"
      // and each other; sibling messaging flows child->child directly through
      // the mailbox spool, so it needs no console-side draining to work.
      agentMessaging: {
        selfId: "Main",
        selfRole: "parent" as const,
        siblingChannelEnabled: settingsRef.current.allowSubagentPeerMessaging,
        operatorChannelEnabled: settingsRef.current.allowSubagentOperatorMessaging,
        projectPath: process.cwd(),
        homeDir: messagingHomeDir,
      },
      requestScope: (request) => {
        const deferred = trackedRequest<ConsoleScopeResolution | null>(null);
        if (!alive.current || stoppingAuditRef.current) {
          deferred.resolve(null);
          return deferred.promise;
        }
        setPendingScope({ request, resolve: deferred.resolve });
        return deferred.promise;
      },
      requestLocalScope: (request) => {
        const deferred = trackedRequest<ConsoleLocalScopeResolution | null>(null);
        if (!alive.current || stoppingAuditRef.current) {
          deferred.resolve(null);
          return deferred.promise;
        }
        setPendingLocalScope({ request, resolve: deferred.resolve });
        return deferred.promise;
      },
      escalateScopedAudit: (request) => {
        const deferred = trackedRequest<boolean>(false);
        if (!alive.current || stoppingAuditRef.current) {
          deferred.resolve(false);
          return deferred.promise;
        }
        setPendingEscalation({ request, resolve: deferred.resolve });
        return deferred.promise;
      },
      approveTool: (call, risk) => {
        const deferred = trackedRequest<boolean>(false);
        if (!alive.current || stoppingAuditRef.current) {
          deferred.resolve(false);
          return deferred.promise;
        }
        setPendingToolApproval({ call, risk, resolve: deferred.resolve });
        return deferred.promise;
      },
      // The `ask_operator` question channel. Unlike the gates above it grants
      // nothing — it surfaces the model's structured question, waits for the
      // operator's answer, and resolves it (or null on Esc / a dead console).
      askOperator: (request) => {
        const deferred = trackedRequest<OperatorQuestionAnswer | null>(null);
        if (!alive.current || stoppingAuditRef.current) {
          deferred.resolve(null);
          return deferred.promise;
        }
        setPendingOperatorQuestion({ request, resolve: deferred.resolve });
        return deferred.promise;
      },
    }, options?.dbPath);
    } catch (error) {
      pluginLease?.release();
      throw error;
    }
    const cleanup = created.cleanup;
    let cleanupPromise: Promise<void> | undefined;
    created.cleanup = () => cleanupPromise ??= (async () => {
      appendTuiEvent({ kind: "wrap-cleanup", stage: "enter", cached: Boolean(cleanupPromise) });
      try { await cleanup(); appendTuiEvent({ kind: "wrap-cleanup", stage: "core-done" }); }
      finally { pluginLease?.release(); appendTuiEvent({ kind: "wrap-cleanup", stage: "lease-released" }); }
    })().catch((error: unknown) => {
      cleanupPromise = undefined;
      throw error;
    });
    // Publish the live runtime so applyRuntimeSelection can reconfigure it in
    // place. A rebuild (provider connect from a dead session) swaps this.
    runtimeRef.current = runtime;
    runtimeInfoHandle.current = {
      model: () => runtime.resolvedModel(),
      providerId: () => runtime.getConfigurationDiagnostics().provider,
      connectionIdentity: () => runtime.connectionIdentity(),
      codexCatalog: (signal) => runtime.codexModelCatalog(signal),
      nativeRuntime: () => runtime,
      applySelection: (sel) => applySelectionRef.current?.(sel),
    };
    if (explicitChoice) pendingModelPreferenceRef.current = runtime;
    void checkRuntime();
    // resolvedModel() is the id the runtime actually settled on after
    // provider detection — not necessarily what was requested — so it is
    // the only value honest enough to display.
    return { session: created, model: runtime.resolvedModel() };
  }, [options, pluginHostManager, messagingHomeDir, trackedRequest, runtimeInfoHandle, checkRuntime, recordProblem, appendEntry]);

  useEffect(() => {
    if (closingRef.current) return;
    let created: ConsoleSession | null = null;
    alive.current = true;
    const releaseView = () => {
      if (isDevUiRemount()) return;
      alive.current = false;
      void closeHandle.current?.().catch((error: unknown) => {
        appendTuiCrash({ source: "audit-cleanup", error: serializeError(error) });
      });
    };
    // A frontend generation owns the view, not the native conversation. The
    // stable hook cells rebind callbacks; no session/tool action is replayed.
    if (initializedView.current) return releaseView;
    initializedView.current = true;

    void (async () => {
    try {
      // Resume: when the full-screen browser opened this chat with a stored
      // transcript, build the console around it and rehydrate the transcript
      // silently (the restored messages ARE the context — see the /sessions
      // in-place path, which does the same).
      const resumeMessages = options?.initialMessages;
      const built = await buildSession(
        resumeMessages && resumeMessages.length > 0 ? { initialMessages: resumeMessages } : {},
      );
      created = built.session;
      sessionRef.current = created;
      setModelId(built.model);
      setSession(created);
      if (resumeMessages && resumeMessages.length > 0) {
        setEntries(entriesFromStoredMessages(resumeMessages));
      }
    } catch (error) {
      if (!alive.current || sessionRef.current) return;
      recordProblem("runtime", error);
      const detail = error instanceof Error ? error.message : String(error);
      setStartupError({ text: startupRecoveryText(detail) });
      const recovery = connectionRecoveryForError(detail);
      if (recovery) connectionFailureRef.current?.(recovery);
    }
    })();

    return releaseView;
  }, []);
  // Marketplace changes never replace this session's runtime or live harness.
  // Its leased host remains usable until cleanup; new chats acquire the new set.
  useEffect(() => {
    if (!pluginHostManager) return;
    return pluginHostManager.onChanged(() => {
      appendEntry({
        kind: "notice",
        text: "Plugins changed — run /new to use them",
        turn: turn.current,
      });
    });
  }, [pluginHostManager, appendEntry]);

  // Idle core: reconfigure the live runtime in place, right now. Assumes the
  // caller has already confirmed no turn is in flight (busy-gating lives in the
  // handle + the send() flush). A provider switch into a dark provider is not
  // applied — it stays staged for the next audit (the callers do that) with a
  // notice, so a credential-less switch can never break an active conversation.
  const applyRuntimeSelection = useCallback((sel: {
    model?: string;
    providerId?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
  }): void => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // A live switch uses the same explicit credential environment as construction.
    const env = { ...process.env, ...credentialEnvPatch(loadCredentials(), process.env) };
    const currentProvider = runtime.getConfigurationDiagnostics().provider;
    // Prefer the selected row's provider identity over model-family inference.
    let targetProvider: string | undefined = sel.providerId;
    if (targetProvider === undefined && sel.model !== undefined) {
      const derived = modelProvider(sel.model);
      // An OpenAI model family is also served by the active subscription.
      // A model-only switch must not force that account onto the API-key lane.
      const subscriptionModel = currentProvider === "chatgpt-codex" && derived === "openai";
      if (!subscriptionModel && derived !== currentProvider && derived !== "unknown") targetProvider = derived;
    }
    if (targetProvider !== undefined && !PROVIDERS.some((provider) => provider.id === targetProvider)) {
      appendEntry({ kind: "notice", text: `Unsupported provider: ${targetProvider}`, turn: turn.current });
      return;
    }
    if (targetProvider !== undefined && targetProvider !== currentProvider) {
      const configured = isProviderConfigured(targetProvider, env);
      if (!configured) {
        const label = PROVIDERS.find((candidate) => candidate.id === targetProvider)?.label ?? targetProvider;
        appendEntry({
          kind: "notice",
          text: `Connect ${label} first`,
          detail: "Saved for next time. Connect it, then pick the model again to switch now.",
          turn: turn.current,
        });
        return;
      }
    }
    runtime.reconfigure({
      ...(sel.model !== undefined ? { model: sel.model } : {}),
      ...(targetProvider !== undefined ? { provider: targetProvider } : {}),
      ...(sel.agentModels !== undefined ? { agentModels: sel.agentModels } : {}),
      ...(sel.singleModel !== undefined ? { singleModel: sel.singleModel } : {}),
      env,
    });
    // resolvedModel() is the id the runtime settled on after re-detection.
    const applied = runtime.resolvedModel();
    setModelId(applied);
    modelIdRef.current = applied;
    const providerNow = runtime.getConfigurationDiagnostics().provider;
    if (sel.model !== undefined) pendingModelPreferenceRef.current = runtime;
    void checkRuntime();
    const providerLabel = PROVIDERS.find((candidate) => candidate.id === providerNow)?.label ?? providerNow;
    showToast(`Model: ${applied} (${providerLabel})`);
  }, [appendEntry, checkRuntime, showToast]);
  applyRuntimeSelectionRef.current = applyRuntimeSelection;

  // Busy-aware handle. Apply at once when idle; when a turn is in flight, stash
  // (last-writer-wins per field; agentModels merged) and let send()'s
  // completion path flush it at the turn boundary. NEVER reconfigures mid-turn.
  const applySelection = useCallback((sel: {
    model?: string;
    providerId?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
  }): void => {
    if (busyRef.current) {
      const prior = pendingSelectionRef.current;
      pendingSelectionRef.current = {
        ...prior,
        ...sel,
        ...(sel.agentModels || prior?.agentModels
          ? { agentModels: { ...prior?.agentModels, ...sel.agentModels } }
          : {}),
      };
      appendEntry({
        kind: "notice",
        text: "Model switches after this turn",
        turn: turn.current,
      });
      return;
    }
    applyRuntimeSelection(sel);
  }, [appendEntry, applyRuntimeSelection]);
  applySelectionRef.current = applySelection;

  const reconnectProvider = useCallback(async (providerId: string) => {
    const knownProvider = PROVIDERS.find((candidate) => candidate.id === providerId);
    if (!knownProvider) {
      appendEntry({ kind: "error", text: "Unknown connection", detail: providerId, turn: turn.current });
      return;
    }
    const provider = providerId as NonNullable<RuntimeConfig["provider"]>;
    const providerLabel = knownProvider.label;
    // Keep the choice staged so /new inherits it too; then apply it LIVE to
    // this audit's running runtime (deferred to the turn boundary when busy).
    const selection = { providerId: provider };
    onNextChatOptions?.(selection);
    if (sessionRef.current) {
      applySelectionRef.current?.(selection);
      return;
    }
    try {
      const built = await buildSession({ providerId: provider, initialMessages: options?.initialMessages });
      sessionRef.current = built.session;
      modelIdRef.current = built.model;
      setSession(built.session);
      setModelId(built.model);
      setStartupError(null);
      appendEntry({ kind: "notice", text: `${providerLabel} configured`, turn: turn.current });
    } catch (error) {
      appendEntry({
        kind: "error",
        text: `${providerLabel} is not connected yet`,
        detail: error instanceof Error ? error.message : String(error),
        turn: turn.current,
      });
    }
  }, [appendEntry, buildSession, options?.initialMessages, onNextChatOptions]);

  useEffect(() => {
    if (!reconnectHandle) return;
    reconnectHandle.current = reconnectProvider;
    return () => {
      reconnectHandle.current = null;
    };
  }, [reconnectHandle, reconnectProvider]);

  const selectModel = useCallback(async (requested: string) => {
    // Stage for /new, then apply LIVE to the running audit (deferred to the
    // turn boundary when busy; kept staged only if the provider is dark).
    onNextChatOptions?.({ model: requested });
    if (sessionRef.current) {
      applySelectionRef.current?.({ model: requested });
      return;
    }
    try {
      const built = await buildSession({ model: requested, initialMessages: options?.initialMessages });
      sessionRef.current = built.session;
      modelIdRef.current = built.model;
      setSession(built.session);
      setModelId(built.model);
      setStartupError(null);
      appendEntry({ kind: "notice", text: `Model: ${built.model} (${modelProvider(built.model)})`, turn: turn.current });
    } catch (error) {
      appendEntry({
        kind: "notice",
        text: `Could not start ${requested}`,
        detail: error instanceof Error ? error.message : String(error),
        turn: turn.current,
      });
    }
  }, [appendEntry, buildSession, options?.initialMessages, onNextChatOptions]);




  /**
   * Claim the structured diagnostics channel while the console is mounted.
   *
   * The channel writes to stderr by default, which is right for a CLI run
   * but would paint straight over this renderer. Claiming redirects those
   * messages into the transcript, and `replay: true` picks up anything
   * emitted during startup before this effect ran.
   *
   * The stream-level output guard stays installed regardless: only part of
   * core has been migrated to the channel, so un-migrated call sites can
   * still write directly (see diagnostics/MIGRATION.md).
   */
  useEffect(() => {
    return claimDiagnostics(
      {
        emit: (event) => {
          if (!alive.current) return;
          appendTuiEvent({ kind: "runtime-diagnostic", ...event });
          // Lifecycle chatter belongs in the local log, not the conversation.
          // Turn failures are rendered once below, from the turn's outcome.
          if (event.level === "info" || event.code === "turn_runtime_error") return;
          if (!settingsRef.current.showRuntimeNotices) return;
          appendEntry({
            kind: event.level === "error" ? "error" : "notice",
            text: `runtime: ${event.message}`,
            detail: event.level === "error" ? `Details: ${tuiLogPath()}` : undefined,
            turn: turn.current,
          });
        },
      },
      { replay: true },
    );
  }, [appendEntry]);

  // Surface anything the runtime wrote to stdout/stderr while the TUI owns
  // the screen. The output guard has already intercepted it (so it cannot
  // corrupt the framebuffer); showing it here keeps operationally important
  // notices — plan quota exhausted, retry budget spent, scanner warnings —
  // visible instead of silently swallowed.
  useEffect(() => {
    return onTuiOutputLine((line) => {
      if (!alive.current) return;
      if (!settingsRef.current.showRuntimeNotices) return;
      appendEntry({
        kind: "notice",
        text: line.stream === "stderr" ? `runtime: ${line.text}` : line.text,
        turn: turn.current,
      });
    });
  }, [appendEntry]);

  // Tell herdr when 0 is parked on a human decision, so the pane joins
  // its attention queue instead of looking busy. No-op outside herdr.
  useEffect(() => {
    reportOperatorGate(Boolean(pendingScope || pendingLocalScope || pendingEscalation || pendingToolApproval || pendingOperatorQuestion || secretPrompt));
  }, [pendingScope, pendingLocalScope, pendingEscalation, pendingToolApproval, pendingOperatorQuestion, secretPrompt]);

  // Seed the ask_operator modal's live edit state from each incoming request,
  // and clear it when the question is answered or dismissed.
  useEffect(() => {
    setOperatorState(
      pendingOperatorQuestion
        ? pendingOperatorQuestion.initialState ?? createOperatorQuestionState(pendingOperatorQuestion.request)
        : null,
    );
  }, [pendingOperatorQuestion]);

  useEffect(() => {
    if (!interactive || !settings.showTimestamps) return;
    const timer = setInterval(() => setClockTick(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [settings.showTimestamps, interactive]);

  // Refresh the git context behind the status bar. readGitStatus never
  // throws and is time-boxed, so a huge or broken repo degrades to
  // "not a repo" instead of stalling a frame.
  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    const refresh = () => {
      void readGitStatus(process.cwd()).then((next) => {
        if (!cancelled) setGit(next);
      });
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [interactive]);


  // Subscribe to subagent lifecycle + progress events from the core event bus.
  // Filter by this session's scanId. `activeSubagents` drives the compact
  // ACTIVE SUBAGENTS block (terminal states removed); `herdAgents` is the
  // richer model the rail and the inline focus view read — fed by the SAME pure
  // reducers the herd screen uses, and KEEPING terminal records so a completed
  // agent's summary/error stays readable in focus and its ✓/× glyph in the rail.
  useEffect(() => {
    if (!session) return;
    const scanId = session.scanId;
    const ownedScanIds = new Set([scanId]);
    const knownAgents = Object.values(herdAgentsRef.current);
    let extended: boolean;
    do {
      extended = false;
      for (const agent of knownAgents) {
        if (ownedScanIds.has(agent.parentScanId) && !ownedScanIds.has(agent.agentId)) {
          ownedScanIds.add(agent.agentId);
          extended = true;
        }
      }
    } while (extended);
    const unsub = eventBus.subscribe({
      emit: (type, payload) => {
        if (!payload || typeof payload !== "object") return;
        const eventData = payload as Record<string, unknown>;
        const parentScanId = eventData["parent_scan_id"];
        const producerScanId = eventData["scan_id"] ?? eventData["scanId"];
        if (producerScanId !== undefined && (typeof producerScanId !== "string" || !ownedScanIds.has(producerScanId))) return;
        if (typeof parentScanId === "string") {
          if (!ownedScanIds.has(parentScanId)) return;
        } else if (typeof producerScanId !== "string" || !ownedScanIds.has(producerScanId)) {
          return;
        }
        if (type === "subagent_lifecycle") {
          const event = payload as unknown as SubagentLifecyclePayload;
          setWorkerTelemetry((prev) => reduceWorkerTelemetry(prev, event));
          ownedScanIds.add(event.agent_id);
          const previousStatus = herdAgentsRef.current[event.agent_id]?.status;
          const startsLife = event.status === "queued"
            ? previousStatus !== "queued"
            : event.status === "running" && previousStatus !== "queued" && previousStatus !== "running" && previousStatus !== "parked";
          if (startsLife) {
            workerEpochsRef.current.set(event.agent_id, (workerEpochsRef.current.get(event.agent_id) ?? 0) + 1);
            setOperatorStopped((previous) => {
              if (!previous.has(event.agent_id)) return previous;
              const next = new Set(previous);
              next.delete(event.agent_id);
              return next;
            });
          }
          setWorkerOutcomes((prev) => ({ ...prev, [event.agent_id]: event }));
          if (event.summary || event.error) {
            const answer = event.error || event.summary!;
            setSubagentTranscripts((prev) => {
              const existing = prev[event.agent_id] ?? [];
              if (existing.some((entry) => entry.kind === "assistant" && entry.text.includes(answer))) return prev;
              const result: ChatEntry = { id: `${event.agent_id}-result-${event.turns ?? 0}`, kind: event.error ? "error" : "assistant", text: answer, turn: event.turns ?? 0, at: Date.now() };
              return { ...prev, [event.agent_id]: retainSubagentTurns([...existing, result], SUBAGENT_TRANSCRIPT_MAX) };
            });
          }
          if (event.name) agentNamesRef.current.set(event.agent_id, event.name);
          setActiveSubagents((prev) => reduceActiveSubagents(prev, event));
          setHerdAgents(applySubagentLifecycle(herdAgentsRef.current, eventData, Date.now()));
          if (focusAgentRef.current === event.agent_id &&
            (previousStatus === "running" || previousStatus === "queued") &&
            event.status !== "running" && event.status !== "queued") returnToConversation();
        } else if (type === "peer_message") {
          // An inter-agent message crossed the hub — render it as an IRC line in
          // the transcript. Resolve both endpoints to the roster's display names
          // (Main is itself; "all" is a broadcast); the accent colouring happens
          // in the renderer.
          const p = payload as unknown as PeerMessagePayload;
          commsSequenceRef.current += 1;
          setCommsMessages((previous) => applyCommsMessage(previous, eventData, commsSequenceRef.current));
          const nameFor = (id: string): string =>
            id === "Main" || id === "all"
              ? id
              : agentNamesRef.current.get(id) ?? "Unnamed sub-agent";
          appendEntry({
            kind: "peer",
            text: p.body,
            peerFrom: nameFor(p.from),
            peerTo: nameFor(p.to),
            at: p.ts,
            turn: turn.current,
          });
        } else if (type === "subagent_progress") {
          setHerdAgents(applySubagentProgress(herdAgentsRef.current, eventData, Date.now()));
        } else if (type === "subagent_message") {
          const p = payload as unknown as SubagentMessagePayload;
          const finalized = finalizedWorkerTurns.current.get(p.agent_id);
          if (p.partial && finalized?.has(p.turn)) return;
          if (!p.partial) {
            const settled = finalized ?? new Set<number>();
            settled.add(p.turn);
            finalizedWorkerTurns.current.set(p.agent_id, settled);
          }
          setWorkerTelemetry((prev) => reduceWorkerTelemetry(prev, p));
          // Use the main conversation's argument formatting and rich cards,
          // retaining the complete bounded public result rather than reducing
          // tools without rich metadata to a one-line summary.
          const fresh: ChatEntry[] = [];
          if (p.reasoning_summary) {
            fresh.push({ id: `${p.agent_id}-t${p.turn}-r`, kind: "reasoning",
              text: p.reasoning_summary, turn: p.turn, at: p.ts });
          }
          if (p.assistant) {
            fresh.push({
              id: `${p.agent_id}-t${p.turn}-a`,
              kind: "assistant",
              text: p.assistant,
              turn: p.turn,
              at: p.ts,
            });
          }
          (p.tools ?? []).forEach((t) => {
            if (!t.running && !t.result.success) recordProblem("tool", t.result.error, t.call.name);
            fresh.push({
              id: `${p.agent_id}-t${p.turn}-x${t.callIndex}`,
              kind: "tool",
              text: t.call.name,
              detail: t.running ? undefined : formatToolResult(t.call, t.result),
              toolPreview: t.running ? undefined : projectToolPreview(t.call, t.result),
              toolArgs: formatToolArgs(t.call),
              success: t.running ? undefined : t.result.success,
              ...toolCardFieldsFromMeta(t.result.meta),
              turn: p.turn,
              at: p.ts,
            });
          });
          setSubagentTranscripts((prev) => ({
            ...prev,
            [p.agent_id]: replaceSubagentTurn(prev[p.agent_id] ?? [], fresh, p.agent_id, p.turn, SUBAGENT_TRANSCRIPT_MAX),
          }));
        } else if (type === "todos") {
          // A worker's plan must not replace this audit's root plan.
          if (producerScanId === scanId) setTodos(payload as unknown as TodosEventPayload);
        } else if (type === "session_objective") {
          const p = payload as unknown as SessionObjectivePayload;
          if (p.scanId !== scanId) return;
          setObjective(p.objective);
          if (p.objective.trim()) onAuditActivity({ title: p.objective.trim() });
        }
      },
    });
    return unsub;
  }, [session, setHerdAgents, recordProblem, returnToConversation]);


  // A focused agent that leaves the live map (never observed, or the session
  // reset) drops focus rather than staring at a stale record.
  useEffect(() => {
    if (focusAgentId && !herdAgents[focusAgentId]) {
      returnToConversation();
    }
  }, [focusAgentId, herdAgents, returnToConversation]);


  // Capture / preview seed ONLY. Guarded by an env var and never populated in a
  // normal session: it plants a deterministic set of sample agents so the right
  // rail, the list navigation and the inline focus view can be captured without
  // a live `spawn_agents` fan-out — the same discipline `OSEC_TRANSCRIPT_STYLE`
  // uses to pin a style for a render capture.
  useEffect(() => {
    if (!process.env["OSEC_TUI_DEMO_AGENTS"]) return;
    const now = Date.now();
    setHerdAgents({
      "agent-recon": {
        agentId: "agent-recon",
        parentScanId: "demo",
        task: "recon web tier",
        status: "running",
        startedAt: now - 300_000,
        maxTurns: 8,
        turn: 3,
        findings: 1,
        tool: "http_probe",
        note: "enumerating /api endpoints",
        lastSeen: now,
        activity: [
          { kind: "lifecycle", ts: now - 8000, status: "queued" },
          { kind: "lifecycle", ts: now - 7000, status: "running" },
          { kind: "progress", ts: now - 5000, turn: 1, maxTurns: 8, tool: "dns_lookup" },
          { kind: "progress", ts: now - 3000, turn: 2, maxTurns: 8, tool: "http_probe", note: "200 on /api" },
          { kind: "progress", ts: now - 1000, turn: 3, maxTurns: 8, tool: "http_probe", note: "enumerating /api endpoints" },
        ],
      },
      "agent-authz": {
        agentId: "agent-authz",
        parentScanId: "demo",
        task: "auth & session fuzzing",
        status: "running",
        startedAt: now - 420_000,
        maxTurns: 8,
        turn: 2,
        findings: 0,
        tool: "replay",
        lastSeen: now,
        activity: [
          { kind: "lifecycle", ts: now - 6000, status: "running" },
          { kind: "progress", ts: now - 2000, turn: 2, maxTurns: 8, tool: "replay", note: "cookie tampering" },
        ],
      },
      "agent-secrets": {
        agentId: "agent-secrets",
        parentScanId: "demo",
        task: "secret scanning",
        status: "completed",
        maxTurns: 5,
        turns: 5,
        findings: 2,
        summary: "2 leaked API keys in JS bundles",
        lastSeen: now,
        activity: [
          { kind: "lifecycle", ts: now - 9000, status: "running" },
          { kind: "lifecycle", ts: now - 500, status: "completed", turns: 5, findings: 2 },
        ],
      },
    });
    setActiveSubagents({
      "agent-recon": {
        agent_id: "agent-recon",
        parent_scan_id: "demo",
        status: "running",
        task: "recon web tier",
        max_turns: 8,
        turns: 3,
      },
      "agent-authz": {
        agent_id: "agent-authz",
        parent_scan_id: "demo",
        status: "running",
        task: "auth & session fuzzing",
        max_turns: 8,
        turns: 2,
      },
    });
  }, []);

  const resolveScope = useCallback((approved: boolean) => {
    const pending = pendingScope;
    if (!pending) return;
    setPendingScope(null);
    if (!approved) {
      pending.resolve(null);
      appendEntry({ kind: "notice", text: "denied — the tool did not run", turn: turn.current });
      return;
    }

    const resolution = buildScopeResolution(pending.request);
    if (!resolution) {
      pending.resolve(null);
      appendEntry({ kind: "notice", text: "couldn't safely add those hosts — the tool did not run", turn: turn.current });
      return;
    }

    pending.resolve(resolution);
    setScopeRules(resolution.scope.raw.in_scope ?? []);
  }, [appendEntry, pendingScope]);

  const resolveLocalScope = useCallback((approved: boolean) => {
    const pending = pendingLocalScope;
    if (!pending) return;
    setPendingLocalScope(null);
    if (!approved) {
      pending.resolve(null);
      appendEntry({
        kind: "notice",
        text: "denied — the tool did not run",
        turn: turn.current,
      });
      return;
    }
    // Authorize the directory the operator was actually shown. The engine
    // re-canonicalizes and re-checks it, so a symlink swapped between the
    // prompt and the apply cannot widen what was approved.
    pending.resolve({ scopePath: pending.request.requestedPath });
    appendEntry({
      kind: "notice",
      text: `allowed reading ${pending.request.requestedPath} (this session)`,
      turn: turn.current,
    });
  }, [appendEntry, pendingLocalScope]);

  const resolveEscalation = useCallback((approved: boolean) => {
    const pending = pendingEscalation;
    if (!pending) return;
    setPendingEscalation(null);
    pending.resolve(approved);
    appendEntry({
      kind: "notice",
      text: approved
        ? `${pending.request.call.name} enabled for this session`
        : `${pending.request.call.name} kept off`,
      turn: turn.current,
    });
  }, [appendEntry, pendingEscalation]);

  const resolveToolApproval = useCallback((approved: boolean) => {
    const pending = pendingToolApproval;
    if (!pending) return;
    setPendingToolApproval(null);
    pending.resolve(approved);
    appendEntry({
      kind: "notice",
      text: approved ? `${pending.call.name} allowed` : `${pending.call.name} denied`,
      turn: turn.current,
    });
  }, [appendEntry, pendingToolApproval]);

  /**
   * Records whose decision has already been dispatched.
   *
   * `resolve*` above reads `pending*` from the render it was built in, so two
   * key events delivered in the same tick — before React has re-rendered with
   * the cleared state — would both see a non-null pending record and run the
   * grant twice: two transcript notices, and a scope resolution applied
   * twice. The promise itself is idempotent, but the side effects are not.
   * Keying on the pending record's identity makes "exactly once" a property
   * of the dispatcher rather than of event timing. A WeakSet so a resolved
   * record is collectable.
   */
  const dispatched = useDevUiRef<WeakSet<object>>(devUi, "dispatched", new WeakSet());
  const dispatchOnce = useCallback((owner: object, run: () => void) => {
    if (dispatched.current.has(owner)) return;
    dispatched.current.add(owner);
    run();
  }, []);

  /**
   * The single authorization prompt currently in front of the operator.
   *
   * Only the topmost is shown. Four independently-rendered panels could
   * previously stack in the same column at once; each one that appears is a
   * decision the operator has to take in order anyway, and a stack of them
   * is precisely what over-subscribes the column.
   *
   * Precedence matches the order the old keyboard handler used, so which
   * prompt answers a keystroke has not changed.
   */
  const approvalPrompt = useMemo<ApprovalPrompt | null>(() => {
    if (pendingScope) {
      const owner = pendingScope;
      return {
        owner,
        title: "Allow access to these hosts?",
        context: `${owner.request.call.name} wants ${owner.request.requestedUrls.join(", ")}`,
        subject: owner.request.call.name,
        bodyLines: owner.request.requestedUrls.map((url) => `host: ${url}`),
        borderColor: WARNING,
        titleColor: WARNING,
        items: [
          {
            id: APPROVAL_GRANT_ID,
            label: "Allow",
            meta: "these hosts, this audit only",
            detail: "Only these exact hosts, only for this audit. Deny rules still win.",
          },
          {
            id: APPROVAL_DENY_ID,
            label: "Deny",
            meta: "tool won't run",
            detail: "Nothing changes; the tool call is refused.",
          },
        ],
        decide: (id) => dispatchOnce(owner, () => resolveScope(id === APPROVAL_GRANT_ID)),
        decline: () => dispatchOnce(owner, () => resolveScope(false)),
      };
    }
    if (pendingLocalScope) {
      const owner = pendingLocalScope;
      return {
        owner,
        title: "Allow reading this folder?",
        context: `${owner.request.call.name} wants to read ${owner.request.requestedPath}`,
        subject: owner.request.call.name,
        bodyLines: [`wants to read: ${owner.request.requestedPath}`],
        borderColor: WARNING,
        titleColor: WARNING,
        items: [
          {
            id: APPROVAL_GRANT_ID,
            label: "Allow",
            meta: "this folder, this session only",
            detail: "Read access to this folder and below, this session only.",
          },
          {
            id: APPROVAL_DENY_ID,
            label: "Deny",
            meta: "tool won't run",
            detail: "No access is granted; the tool call is refused.",
          },
        ],
        decide: (id) => dispatchOnce(owner, () => resolveLocalScope(id === APPROVAL_GRANT_ID)),
        decline: () => dispatchOnce(owner, () => resolveLocalScope(false)),
      };
    }
    if (pendingEscalation) {
      const owner = pendingEscalation;
      return {
        owner,
        title: "Enable this tool?",
        context: `${owner.request.call.name} — ${owner.request.reason}`,
        subject: owner.request.call.name,
        bodyLines: [owner.request.reason],
        borderColor: WARNING,
        titleColor: WARNING,
        items: [
          {
            id: APPROVAL_GRANT_ID,
            label: "Enable",
            meta: "this audit only",
            detail: "Other approvals still apply to it.",
          },
          {
            id: APPROVAL_DENY_ID,
            label: "Keep off",
            meta: "tool stays blocked",
            detail: "The tool stays blocked for this session.",
          },
        ],
        decide: (id) => dispatchOnce(owner, () => resolveEscalation(id === APPROVAL_GRANT_ID)),
        decline: () => dispatchOnce(owner, () => resolveEscalation(false)),
      };
    }
    if (pendingToolApproval) {
      const owner = pendingToolApproval;
      // A positively-classified destructive call is dressed as DANGER: the ERROR
      // tone, the card's danger glyph (severity), a static category line, and a
      // deny-first selection (below). This never changes that the gate fires or
      // what it authorizes — an unclassified/obfuscated call is simply calm.
      const danger = owner.risk?.level === "destructive";
      const dangerLabel = danger && owner.risk?.category
        ? describeDestructiveCategory(owner.risk.category)
        : undefined;
      const argumentsLines = owner.completeDetails
        ? Object.entries(owner.call.arguments).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        : argumentSummaryLines(owner.call.arguments);
      const bodyLines = dangerLabel ? [`Destructive action: ${dangerLabel}`, ...argumentsLines] : argumentsLines;
      return {
        owner,
        title: `Allow this tool call? · ${modeLabel(modeRef.current)}`,
        context: `${owner.call.name} ${JSON.stringify(owner.call.arguments)}`,
        subject: owner.call.name,
        bodyLines,
        completeDetails: owner.completeDetails,
        borderColor: danger ? ERROR : INFO,
        titleColor: danger ? ERROR : INFO,
        severity: danger ? "danger" : undefined,
        items: [
          {
            id: APPROVAL_GRANT_ID,
            label: "Allow once",
            meta: "just this call",
            detail: "Only this call. The next one asks again.",
          },
          {
            id: APPROVAL_DENY_ID,
            label: "Deny",
            meta: "call won't run",
            detail: "The agent is told you said no and continues without it.",
          },
        ],
        decide: (id) => dispatchOnce(owner, () => resolveToolApproval(id === APPROVAL_GRANT_ID)),
        decline: () => dispatchOnce(owner, () => resolveToolApproval(false)),
      };
    }
    return null;
  }, [
    dispatchOnce,
    pendingEscalation,
    pendingLocalScope,
    pendingScope,
    pendingToolApproval,
    resolveEscalation,
    resolveLocalScope,
    resolveScope,
    resolveToolApproval,
  ]);

  /**
   * Selector position for the open approval, keyed by the pending record it
   * belongs to. Derived rather than pushed through an effect: an effect would
   * leave one frame in which the prompt is up and its selector is not, and
   * that frame is a keystroke the operator could lose.
   */
  const [approvalCursor, setApprovalCursor] = useDevUiState<{ owner: object; state: SelectorState } | null>(devUi, "approvalCursor", null);
  const approvalDetailsScrollRef = useDevUiRef<ScrollBoxRenderable | null>(devUi, "approvalDetailsScrollRef", null);
  useEffect(() => {
    if (approvalDetailsScrollRef.current) approvalDetailsScrollRef.current.scrollTop = 0;
  }, [approvalPrompt?.owner]);
  const approvalState: SelectorState | null = approvalPrompt
    ? (approvalCursor && approvalCursor.owner === approvalPrompt.owner
        ? approvalCursor.state
        // The grant is highlighted first, exactly as Enter used to approve
        // directly — the semantics of the default answer are unchanged. The ONE
        // exception is a DANGER prompt: it opens on the declining choice, so a
        // reflexive Enter denies rather than runs a destructive call.
        : createSelectorState(
            approvalPrompt.title,
            approvalPrompt.items,
            approvalPrompt.severity === "danger" ? APPROVAL_DENY_ID : APPROVAL_GRANT_ID,
          ))
    : null;
  const stepApproval = useCallback((action: "up" | "down") => {
    setApprovalCursor((current) => {
      if (!approvalPrompt) return current;
      // Prefer the queued state over the rendered one, so two arrow presses
      // delivered in the same tick step twice instead of collapsing to one.
      const base = current && current.owner === approvalPrompt.owner ? current.state : approvalState;
      if (!base) return current;
      return { owner: approvalPrompt.owner, state: reduceSelector(base, { type: action }) };
    });
  }, [approvalPrompt, approvalState]);

  /**
   * `send` is declared after the command router, but /explain needs to
   * submit a real turn. A ref breaks the cycle without reordering two
   * large callbacks or making either depend on the other's identity.
   */
  const submitRef = useDevUiRef<((text: string) => Promise<void>) | null>(devUi, "submitRef", null);
  /** Name of the tool currently executing, for the tool animation. */
  const [runningTool, setRunningTool] = useDevUiState<string | null>(devUi, "runningTool", null);
  const waitingForSpawnResult = busy && (runningTool === "spawn_agent" || runningTool === "spawn_agents");
  const waitActivityLabel = waitingForSpawnResult
    ? waitingForAgentsLabel(runningSpawnChildren)
    : undefined;
  /**
   * Interrupt handle for the turn in flight, or null when none is running.
   * Held in a ref because the keyboard handler must reach the CURRENT turn's
   * controller, not the one captured when the handler was built.
   */
  const abortRef = useDevUiRef<AbortController | null>(devUi, "abortRef", null);
  const turnSettledRef = useDevUiRef<Promise<void> | null>(devUi, "turnSettledRef", null);
  const stopAuditPromiseRef = useDevUiRef<Promise<void> | null>(devUi, "stopAuditPromiseRef", null);
  const closePromiseRef = useDevUiRef<Promise<void> | null>(devUi, "closePromiseRef", null);
  const stoppingAuditRef = useDevUiRef(devUi, "stoppingAuditRef", false);

  // Cancellation is checkpoint-based. Keep its feedback out of the transcript.
  const interruptTurn = useCallback(() => {
    const controller = abortRef.current;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    showToast("Interrupting main turn…");
    return true;
  }, [showToast]);
  const captureStopScope = useCallback((workerId?: string): Map<string, number> => {
    const rootId = workerId ?? sessionRef.current?.scanId;
    const captured = new Map<string, number>();
    if (!rootId) return captured;
    const family = new Set([rootId]);
    const records = Object.values(herdAgentsRef.current);
    let extended: boolean;
    do {
      extended = false;
      for (const record of records) {
        if (family.has(record.parentScanId) && !family.has(record.agentId)) {
          family.add(record.agentId);
          extended = true;
        }
      }
    } while (extended);
    for (const record of records) {
      if (family.has(record.agentId) && (record.status === "queued" || record.status === "running" || record.status === "parked")) {
        captured.set(record.agentId, workerEpochsRef.current.get(record.agentId) ?? 0);
      }
    }
    return captured;
  }, []);

  const confirmStopped = useCallback((captured: ReadonlyMap<string, number>) => {
    setOperatorStopped((previous) => {
      let next: Set<string> | undefined;
      for (const [id, epoch] of captured) {
        if ((workerEpochsRef.current.get(id) ?? 0) !== epoch || previous.has(id)) continue;
        (next ??= new Set(previous)).add(id);
      }
      return next ?? previous;
    });
  }, []);

  const stopAudit = useCallback((): Promise<void> => {
    if (stopAuditPromiseRef.current) return stopAuditPromiseRef.current;
    const ownedSession = sessionRef.current;
    const captured = captureStopScope();
    const activeTurn = turnSettledRef.current;
    stoppingAuditRef.current = true;
    onAuditActivity({ stopping: true });
    queuedRef.current = [];
    setQueuedMessages([]);
    abortRef.current?.abort();
    for (const cancel of pendingCancellationsRef.current) cancel();
    pendingCancellationsRef.current.clear();
    setPendingScope(null);
    setPendingLocalScope(null);
    setPendingEscalation(null);
    setPendingToolApproval(null);
    setPendingOperatorQuestion(null);
    const stopping = Promise.resolve().then(async () => {
      const t0 = Date.now();
      appendTuiEvent({ kind: "stop-audit", stage: "await-turn" });
      await activeTurn;
      appendTuiEvent({ kind: "stop-audit", stage: "turn-settled", ms: Date.now() - t0 });
      await ownedSession?.stopPersistentAgents();
      appendTuiEvent({ kind: "stop-audit", stage: "agents-stopped", ms: Date.now() - t0 });
      confirmStopped(captured);
      onAuditActivity({ outcome: "stopped", workers: 0, waiting: false });
    }).finally(() => {
      stoppingAuditRef.current = false;
      stopAuditPromiseRef.current = null;
      onAuditActivity({ stopping: false });
    });
    stopAuditPromiseRef.current = stopping;
    return stopping;
  }, [captureStopScope, confirmStopped, onAuditActivity]);

  closeHandle.current = () => closePromiseRef.current ??= (async () => {
    closingRef.current = true;
    sourceFixAbortRef.current?.abort();
    await sourceFixPromiseRef.current;
    alive.current = false;
    const t0 = Date.now();
    appendTuiEvent({ kind: "close-handle", stage: "stop-audit" });
    await stopAudit();
    appendTuiEvent({ kind: "close-handle", stage: "audit-stopped", ms: Date.now() - t0, hasSession: Boolean(sessionRef.current) });
    if (sessionRef.current) await sessionRef.current.cleanup();
    else await options?.mcpHost?.closeAll();
    appendTuiEvent({ kind: "close-handle", stage: "cleaned-up", ms: Date.now() - t0 });
  })().catch((error: unknown) => {
    // Failed cleanup keeps the audit visible for the existing explicit retry.
    closePromiseRef.current = null;
    throw error;
  });

  const showFixPanel = useCallback((title: string, lines: string[]) => {
    appendEntry({
      kind: "panel", text: title,
      panel: { title, rows: lines.flatMap((line) => line.split("\n").map((value) => ({ value }))) },
      turn: turn.current,
    });
  }, [appendEntry]);

  const startSourceFix = useCallback((id: string) => {
    if (busy || sourceFixAbortRef.current || pendingOperatorQuestion || pendingToolApproval) {
      showFixPanel("Fix not started", ["Wait for the current turn or fix, or run /fix cancel."]);
      return;
    }
    let focus: FindingFocus;
    try {
      focus = loadFindingFocus(id, { dbPath: options?.dbPath });
      const check = fixEligibility(focus.finding);
      if (!check.eligible) throw new Error(check.reason);
    } catch (error) {
      showFixPanel("Can't start fix", [error instanceof Error ? error.message : String(error), FIX_USAGE]);
      return;
    }
    const controller = new AbortController();
    sourceFixAbortRef.current = controller;
    setFixWorking(true);
    sourceFixPromiseRef.current = (async () => {
      try {
        const overrideRepo = process.env["ZERO_FIX_REPO"]?.trim();
        let repoRoot: string | undefined;
        if (overrideRepo) repoRoot = await resolveSourceFixRepository(overrideRepo);
        else {
          for (const suggested of new Set([session?.localScopePath, focus.target, target, process.cwd()])) {
            repoRoot = await resolveSourceFixRepository(suggested);
            if (repoRoot) break;
          }
        }
        let testCommand = process.env["ZERO_FIX_TEST_COMMAND"]?.trim() ?? "";
        if (repoRoot && !testCommand) {
          try { testCommand = loadSourceFixProjectInputs(repoRoot)?.testCommand ?? ""; }
          catch (error) {
            showFixPanel("Couldn't load saved fix setup", [
              error instanceof Error ? error.message : String(error),
              "Enter the repo and test command again.",
            ]);
          }
        }
        let requestedRepo = repoRoot ?? overrideRepo ?? "";
        do {
          controller.signal.throwIfAborted();
          const request: OperatorQuestionRequest = {
            requestId: `source-fix-setup-${focus.finding.id}-${Date.now()}`,
            questions: [
              { header: "Repository", question: "Which local Git repo should be fixed?", allowCustom: true },
              { header: "Regression command", question: "Which command should verify the fix? (e.g. your test command)", allowCustom: true },
            ],
          };
          const state = createOperatorQuestionState(request);
          state.custom = [requestedRepo, testCommand];
          state.index = requestedRepo ? 1 : 0;
          const answer = trackedRequest<OperatorQuestionAnswer | null>(null);
          const cancelQuestion = () => answer.resolve(null);
          controller.signal.addEventListener("abort", cancelQuestion, { once: true });
          setPendingOperatorQuestion({ request, initialState: state, resolve: answer.resolve });
          let response: OperatorQuestionAnswer | null;
          try { response = await answer.promise; }
          finally {
            controller.signal.removeEventListener("abort", cancelQuestion);
            setPendingOperatorQuestion((pending) => pending?.request === request ? null : pending);
          }
          if (!response || controller.signal.aborted) {
            showFixPanel("Fix cancelled", ["Nothing was run."]);
            return;
          }
          requestedRepo = response.answers.find((item) => item.header === "Repository")?.customText?.trim() ?? "";
          testCommand = response.answers.find((item) => item.header === "Regression command")?.customText?.trim() ?? "";
          repoRoot = await resolveSourceFixRepository(requestedRepo);
          const inputs = fixInputEligibility({ repoRoot, testCommand });
          if (!inputs.eligible) showFixPanel("Fix needs more input", [inputs.reason]);
        } while (!repoRoot || !testCommand);
        controller.signal.throwIfAborted();
        const call: ToolCall = {
          name: "run_source_fix",
          arguments: {
            regression_command: testCommand,
            repository: repoRoot,
            execution: "Write a patch and run this command on isolated copies (up to 3 tries). Your checkout isn't changed. No push, no PR.",
          },
        };
        const approval = trackedRequest<boolean>(false);
        const cancelApproval = () => approval.resolve(false);
        controller.signal.addEventListener("abort", cancelApproval, { once: true });
        setPendingToolApproval({ call, completeDetails: true, resolve: approval.resolve });
        let approved: boolean;
        try { approved = await approval.promise; }
        finally {
          controller.signal.removeEventListener("abort", cancelApproval);
          setPendingToolApproval((pending) => pending?.call === call ? null : pending);
        }
        if (!approved || controller.signal.aborted) {
          showFixPanel("Fix denied", ["Nothing was run or saved."]);
          return;
        }
        try { saveSourceFixProjectInputs({ repoRoot, testCommand }); }
        catch (error) {
          showFixPanel("Fix setup not saved", [error instanceof Error ? error.message : String(error), "This run continues; next time you'll be asked again."]);
        }
        showFixPanel(`Fixing ${focus.finding.id}`, [
          `repo ${repoRoot}`, `test command ${testCommand}`,
          "Working on isolated copies; your checkout is untouched. /fix cancel stops it.",
        ]);
        const runtime = createRuntime({ type: "api", timeout: 600_000, model: modelId ?? undefined, provider: options?.providerId });
        if (!isNativeRuntime(runtime) || !(await runtime.isAvailable())) throw new Error("selected API runtime is unavailable; connect a provider first");
        const result = await runSourceFix({
          repoRoot, finding: focus.finding, runtime, testCommand,
          apply: false, keepWorktree: true, signal: controller.signal,
        });
        if (result.candidate) sourceFixCandidatesRef.current.set(focus.finding.id, result);
        if (!alive.current) return;
        showFixPanel(`Source fix ${focus.finding.id}`, [
          controller.signal.aborted ? "Source fix cancelled; nothing published." : describeFixStatus(result.status, result),
          ...fixResultLines(result),
          ...(result.candidate ? [`Review above, then /fix publish ${focus.finding.id} to inspect publication details. No push has occurred.`] : []),
        ]);
      } catch (error) {
        if (alive.current) showFixPanel("Source fix failed", [controller.signal.aborted ? "Source fix cancelled; nothing published." : error instanceof Error ? error.message : String(error)]);
      } finally {
        sourceFixAbortRef.current = null;
        sourceFixPromiseRef.current = null;
        if (alive.current) setFixWorking(false);
      }
    })();
  }, [busy, modelId, options?.dbPath, options?.providerId, session?.localScopePath, target, pendingOperatorQuestion, pendingToolApproval, trackedRequest, showFixPanel]);

  const requestFixPublication = useCallback((id: string) => {
    if (busy || sourceFixAbortRef.current) {
      showFixPanel("Can't publish yet", ["Wait for the current turn or fix to finish."]);
      return;
    }
    const result = sourceFixCandidatesRef.current.get(id);
    if (!result) {
      showFixPanel("No verified fix to publish", [`Run /fix ${id || "<finding-id>"} first. Only verified fixes can be published.`]);
      return;
    }
    const controller = new AbortController();
    sourceFixAbortRef.current = controller;
    setFixWorking(true);
    sourceFixPromiseRef.current = (async () => {
      try {
        const plan: SourceFixPublicationPlan = await planSourceFixPublication(result);
        if (controller.signal.aborted || !alive.current) return;
        showFixPanel("Review draft PR", [...fixPublicationLines(plan), ...fixResultLines(result)]);
        setPicker({
          state: createSelectorState("Publish this fix?", [
            { id: "keep-local", label: "Keep local", detail: "Don't push anything" },
            { id: "publish-draft", label: "Push and open draft PR", detail: `${plan.branch} → ${plan.baseBranch}; ${plan.remote}` },
          ]),
          onCancel: () => showFixPanel("Cancelled", ["Fix kept locally; nothing pushed."]),
          commit: (choice) => {
            if (choice !== "publish-draft") {
              showFixPanel("Kept local", ["Nothing pushed."]);
              return;
            }
            if (sourceFixAbortRef.current) return;
            const publishing = new AbortController();
            sourceFixAbortRef.current = publishing;
            setFixWorking(true);
            showFixPanel("Publishing draft PR", ["Re-checking the fix before pushing.", ...fixPublicationLines(plan)]);
            sourceFixPromiseRef.current = (async () => {
              try {
                const published = await publishSourceFixDraftPR(result, { approval: "publish-draft-pr", signal: publishing.signal });
                if (alive.current) showFixPanel("Draft PR created", [published.prUrl, `branch ${published.branch}`, `worktree ${published.worktree}`]);
              } catch (error) {
                if (alive.current) showFixPanel("Draft PR failed", [
                  error instanceof Error ? error.message : String(error),
                  `Fix and branch kept at ${plan.worktree}. If the push went through, the remote branch still exists.`,
                ]);
              } finally {
                sourceFixAbortRef.current = null;
                sourceFixPromiseRef.current = null;
                if (alive.current) setFixWorking(false);
              }
            })();
          },
        });
      } catch (error) {
        if (alive.current) showFixPanel("Can't publish", [error instanceof Error ? error.message : String(error), "Fix kept locally; nothing pushed."]);
      } finally {
        sourceFixAbortRef.current = null;
        sourceFixPromiseRef.current = null;
        if (alive.current) setFixWorking(false);
      }
    })();
  }, [busy, showFixPanel]);

  const routeSlashCommand = useCallback((raw: string): boolean => {
    const parsed = findCommand(raw);
    if (!parsed.isSlash) return false;

    if (!parsed.isKnown || !parsed.command) {
      appendEntry({
        kind: "notice",
        text: parsed.rawName ? `unknown command: /${parsed.rawName}` : "choose a slash command",
        detail: "Type /help to see commands.",
        turn: turn.current,
      });
      return true;
    }

    const args = parsed.args.trim();
    switch (parsed.command) {
      case "help": {
        const query = args.startsWith("/") ? args.slice(1) : args;
        const commands = query ? filterCommands(query) : commandCatalog;
        appendEntry({
          kind: "panel",
          text: "help",
          panel: buildHelpPanel(commands, query || undefined),
          turn: turn.current,
        });
        return true;
      }
      case "capabilities":
        appendEntry({
          kind: "panel",
          text: "capabilities",
          panel: buildCapabilityPanel(getAllCapabilities()),
          turn: turn.current,
        });
        return true;
      case "status": {
        const panel = buildStatusPanel({
          model: modelId ?? undefined,
          provider: modelId ? modelProvider(modelId) : undefined,
          mode: modeLabel(mode),
          target: target || undefined,
          scopeRules,
          toolCount: session?.tools.length ?? 0,
          turns: turn.current,
          inputTokens: sessionTokens.input,
          outputTokens: sessionTokens.output,
        });
        if (lastContext !== undefined) {
          panel.rows.push({ label: "context", value: `${lastContext} tokens` });
        }
        if (turnBudget) {
          panel.rows.push({
            label: "this turn",
            value: `${turnBudget.used} tokens${turnBudget.limit > 0 ? ` of ${turnBudget.limit}` : ""}`,
          });
        }
        appendEntry({ kind: "panel", text: "status", panel, turn: turn.current });
        return true;
      }
      case "scope":
        appendEntry({
          kind: "panel",
          text: "scope",
          panel: buildScopePanel({
            scopeRules: scopeIncludes,
            outOfScope: scopeExcludes,
            scopeConfigured: displayedScope !== undefined,
            mode: modeLabel(mode),
          }),
          turn: turn.current,
        });
        return true;
      case "new-chat":
        onNavigate("new-chat");
        return true;
      case "clear": {
        if (busy) {
          appendEntry({
            kind: "notice",
            text: "wait for the current turn to finish",
            turn: turn.current,
          });
          return true;
        }
        // Conversation only. Scope, target, autonomy mode, granted
        // escalations and the denied-host / denied-path memory all live on
        // the session and are deliberately LEFT ALONE: they are
        // authorization state, and dropping a *denial* because the operator
        // tidied their screen would silently re-open something they already
        // refused. `clearConversation()` empties the message array and
        // nothing else — see ConsoleSession in turn-engine.ts.
        session?.clearConversation();
        discardStreamPatches();
        setEntries([]);
        entriesRef.current = [];
        turn.current = 0;
        setTurnBudget(null);
        setLastContext(undefined);
        clearMarkdownCache();
        setLatestCompaction(undefined);
        pendingCompactionRef.current = undefined;
        // The live plan tree belongs to the conversation being emptied.
        setTodos(null);
        // The objective describes the conversation being emptied; drop it so a
        // stale title doesn't ride on the fresh session's bottom bar.
        setObjective("");
        appendEntry({
          kind: "notice",
          text: "conversation cleared",
          turn: turn.current,
        });
        return true;
      }
      case "sessions": {
        onNavigate("sessions");
        return true;
      }
      case "feedback": {
        const feedbackCommand = parseFeedbackCommand(args);
        if (feedbackCommand.kind === "usage") {
          setPicker({
            state: createSelectorState("Feedback", [
              { id: "write", label: "Write feedback", detail: "You'll see a preview before anything is sent." },
              { id: "problem", label: "Review latest problem", detail: "No prompts or tool output included.", disabled: latestProblemRef.current === null },
              { id: "privacy", label: "Problem reports", meta: settingsRef.current.diagnosticReporting, detail: "Keep local, ask first, or send automatically." },
            ]),
            commit: (id) => {
              if (id === "privacy") openReportingChoices();
              else if (id === "problem" && latestProblemRef.current) stageFeedback(latestProblemRef.current);
              else if (id === "write") {
                restorePaletteDraft();
                if (composerRef.current.trim()) {
                  showToast("Draft kept · use /feedback submit <message> when ready.");
                } else {
                  setComposerText("/feedback submit ");
                  composingRef.current = true;
                  setComposing(true);
                }
              }
            },
            onCancel: () => { restorePaletteDraft(); },
          });
          return true;
        }

        if (feedbackCommand.kind === "submit") {
          const message = feedbackCommand.message;
          if (!message) {
            appendEntry({
              kind: "notice",
              text: "usage: /feedback submit <message>",
              detail: "You'll see a preview before anything is sent.",
              turn: turn.current,
            });
            return true;
          }

          const payload: FeedbackPayload = {
            message,
            timestamp: new Date().toISOString(),
            version: VERSION,
            model: modelId ?? undefined,
            mode: modeLabel(mode),
          };

          stageFeedback(payload);
          return true;
        }

        if (feedbackCommand.kind === "send") {
          if (!pendingFeedback) {
            appendEntry({
              kind: "notice",
              text: "no feedback to send",
              detail: "Use /feedback submit <message> first.",
              turn: turn.current,
            });
            return true;
          }

          if (pendingFeedback.preview === null) {
            appendEntry({
              kind: "notice",
              text: "cannot send feedback",
              detail: "Sending is blocked. It's saved locally; /feedback cancel clears it.",
              turn: turn.current,
            });
            return true;
          }

          // Fire-and-forget: show immediate notice, append result asynchronously
          const preview = pendingFeedback.preview;
          const payload = pendingFeedback.payload;
          setPendingFeedback(null);

          appendEntry({
            kind: "notice",
            text: "sending feedback…",
            detail: `Transmitting to ${preview.url}.`,
            turn: turn.current,
          });

          submitFeedback(payload, process.env, {
            expectedPreview: preview,
            diagnosticConsent: { policy: settingsRef.current.diagnosticReporting, confirmed: true },
          }).then((result) => {
            appendEntry({
              kind: result.ok ? "notice" : "error",
              text: result.ok ? "feedback sent" : "feedback not sent",
              detail: result.ok
                ? `Sent to ${preview.url}. Status: ${result.status}.`
                : (result.error ?? "unknown error"),
              turn: turn.current,
            });
          });

          return true;
        }

        if (feedbackCommand.kind === "cancel") {
          if (!pendingFeedback) {
            appendEntry({
              kind: "notice",
              text: "no pending feedback to cancel",
              turn: turn.current,
            });
            return true;
          }
          setPendingFeedback(null);
          appendEntry({
            kind: "notice",
            text: "pending feedback cancelled",
            detail: "Nothing was sent. The local copy is kept.",
            turn: turn.current,
          });
          return true;
        }

        // Plain /feedback <message> — local-only (existing behaviour)
        const written = appendFeedback({
          message: feedbackCommand.message,
          timestamp: new Date().toISOString(),
          version: VERSION,
          model: modelId ?? undefined,
          mode: modeLabel(mode),
        });
        appendEntry({
          kind: written.ok ? "notice" : "error",
          text: written.ok ? "feedback recorded locally" : "could not write feedback",
          detail: written.ok
            ? `Saved to ${written.path}. Nothing was transmitted — share it if and when you choose.`
            : written.error,
          turn: turn.current,
        });
        return true;
      }
      case "copy": {
        if (!session || busy) {
          showToast(busy ? "Wait for the current turn to finish." : "Nothing to export yet.");
          return true;
        }
        try {
          const exported = exportChatConversation(session.messages);
          void copySelection(exported.text, { spawn: defaultSpawn, which: defaultWhich }).then((result) => {
            appendEntry({
              kind: result.ok ? "notice" : "error",
              text: result.ok
                ? result.method === "osc52" ? "Conversation sent to terminal clipboard." : "Conversation copied."
                : "Clipboard unavailable; conversation JSON was saved.",
              detail: `Private JSON: ${exported.path}`,
              turn: turn.current,
            });
          }).catch(() => {
            appendEntry({ kind: "error", text: "Clipboard failed; conversation JSON was saved.", detail: exported.path, turn: turn.current });
          });
        } catch (error) {
          appendEntry({ kind: "error", text: "Could not export the conversation.", detail: error instanceof Error ? error.message : String(error), turn: turn.current });
        }
        return true;
      }
      case "fix": {
        if (args === "cancel") {
          sourceFixAbortRef.current?.abort();
          showFixPanel("Cancel fix", [sourceFixAbortRef.current ? "Cancelling. Anything already made is kept; nothing is published." : "No fix is running."]);
          return true;
        }
        if (args === "publish" || args.startsWith("publish ")) {
          const id = args.slice("publish".length).trim();
          if (!id || /\s/.test(id)) showFixPanel("Usage", [FIX_USAGE]);
          else requestFixPublication(id);
          return true;
        }
        if (args) {
          if (/\s/.test(args)) showFixPanel("Usage", [FIX_USAGE]);
          else startSourceFix(args);
          return true;
        }
        const findings = runFindingsFromEntries(entries).filter((finding) => finding.id);
        if (!findings.length) showFixPanel("No findings to fix", [FIX_USAGE, "Open /findings and pick one, or type its id."]);
        else setPicker({
          state: createSelectorState("Fix which finding?", findings.map((finding) => ({ id: finding.id!, label: finding.title, detail: finding.severity }))),
          commit: startSourceFix,
          onCancel: () => showFixPanel("Cancelled", ["Nothing was run."]),
        });
        return true;
      }
      case "explain": {
        if (!session) {
          appendEntry({ kind: "notice", text: "runtime is not ready", turn: turn.current });
          return true;
        }
        if (busy) {
          appendEntry({ kind: "notice", text: "wait for the current turn to finish", turn: turn.current });
          return true;
        }
        const topic = args.trim();
        if (entries.length === 0 && !topic) {
          appendEntry({
            kind: "notice",
            text: "nothing to explain yet",
            detail: "Run something first, or use /explain <topic>.",
            turn: turn.current,
          });
          return true;
        }
        // Sent as a normal turn so the explanation is a real model answer
        // grounded in this conversation, not a canned local string.
        const prompt = topic
          ? `Explain "${topic}" like I am five years old. Use 3–5 very short sentences, mostly under 12 words each. Use familiar everyday words and one simple comparison. No jargon, acronyms, code, headings, or baby talk. Say what happened, why it matters, and one thing to do next. Keep the facts accurate and say plainly what is not yet confirmed. Explain only; do not run new tests or tools.`
          : `Explain your previous result like I am five years old. Use 3–5 very short sentences, mostly under 12 words each. Use familiar everyday words and one simple comparison. No jargon, acronyms, code, headings, or baby talk. Say what happened, why it matters, and one thing to do next. Keep the facts accurate and say plainly what is not yet confirmed. Explain only; do not run new tests or tools.`;
        void submitRef.current?.(prompt);
        return true;
      }
      case "settings":
        // The full screen, not the composer picker: settings want grouping,
        // real descriptions and reset affordances, none of which fit in a
        // list squeezed above the composer.
        onNavigate("settings");
        return true;
      case "keybindings":
        // run.tsx routes the "keybindings" destination to the rebinding editor;
        // chat just needs the nav entry (mirrors "/settings").
        onNavigate("keybindings");
        return true;
      case "onboard":
        onNavigate(parsed.command);
        return true;
      case "theme": {
        const current = settingsRef.current.theme;
        const arg = args.trim().toLowerCase();
        if (arg) {
          if (!isThemeName(arg)) {
            appendEntry({
              kind: "notice",
              text: "unknown theme",
              detail: `Run /theme with no argument to pick from ${THEME_NAMES.length}.`,
              turn: turn.current,
            });
            return true;
          }
          updateSetting("theme", arg);
          appendEntry({ kind: "notice", text: `Theme: ${getThemeEntry(arg).label}`, turn: turn.current });
          return true;
        }
        const items: SelectorItem[] = THEME_NAMES.map((name) => {
          const entry = getThemeEntry(name);
          return {
            id: name,
            label: entry.label,
            meta: entry.mode,
            detail: entry.description,
            current: name === current,
          };
        });
        setPicker({
          state: createSelectorState("Theme · live preview", items, current),
          // Preview in memory as the operator arrows — no disk write per row.
          onHighlight: (id) => { if (isThemeName(id)) previewSetting("theme", id); },
          // Enter keeps the highlighted theme (persist it).
          commit: (id) => { if (isThemeName(id)) updateSetting("theme", id); },
          // Esc restores the theme that was active before the picker opened.
          onCancel: () => { reloadSettings(); },
        });
        return true;
      }
      case "model": {
        const requested = args.trim();
        if (!requested) {
          // The full screen, not the composer picker: the model list wants
          // provider grouping, per-provider credential state and setup hints,
          // none of which fit above the composer. `/model <id>` below still
          // switches in place without leaving chat.
          onNavigate("models");
          return true;
        }
        selectModel(requested);
        return true;
      }
      case "tools": {
        const toolNames = session?.tools.map((tool) => tool.name) ?? [];
        appendEntry({
          kind: "panel",
          text: "tools",
          panel: buildToolsPanel(toolNames),
          turn: turn.current,
        });
        return true;
      }
      case "chat":
        appendEntry({
          kind: "notice",
          text: "You're already in chat",
          turn: turn.current,
        });
        return true;
      case "launcher":
        onNavigate("launcher");
        return true;
      case "ops":
        onNavigate("ops");
        return true;
      case "hackstore":
        // run.tsx routes the "market" destination to the Hackstore screen
        // (kept as the internal route id); chat just needs the nav entry
        // (mirrors "/ops"/"/settings").
        onNavigate("market");
        return true;
      case "usage":
        // run.tsx routes "usage" to the usage screen (with the live token
        // snapshot); this nav entry turns the registered "/usage" command from a
        // palette-only stub into a working route.
        onNavigate("usage");
        return true;
      case "connect":
        // Likewise for "/connect": run.tsx already routes the destination.
        onNavigate("connect");
        return true;
      case "history":
        onNavigate("history");
        return true;
      case "findings":
        onNavigate("findings");
        return true;
      case "doctor":
        onNavigate("doctor");
        return true;
      case "back":
        onGoBack();
        return true;
      case "exit":
        onExit();
        return true;
      default:
        appendEntry({
          kind: "notice",
          text: `unknown command: /${parsed.rawName}`,
          turn: turn.current,
        });
        return true;
    }
  }, [
    activeSubagents,
    appendEntry,
    showFixPanel,
    startSourceFix,
    requestFixPublication,
    entries,
    busy,
    captureStopScope,
    confirmStopped,
    focusAgentId,
    returnToConversation,
    stopAudit,
    commandCatalog,
    discardStreamPatches,
    lastContext,
    mode,
    modelId,
    onExit,
    onGoBack,
    onNavigate,
    openReportingChoices,
    restorePaletteDraft,
    setComposerText,
    showToast,
    stageFeedback,
    pendingFeedback,
    scopeLabel,
    scopeRules,
    displayedScope,
    scopeIncludes,
    scopeExcludes,
    copySelection,
    options?.dbPath,
    selectModel,
    session,
    sessionTokens,
    setPendingFeedback,
    target,
    turnBudget,
  ]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (routeSlashCommand(text)) return;
    if (!runtimeReadyRef.current) {
      if (!composerRef.current.trim()) {
        setComposerText(raw);
        composingRef.current = true;
        setComposing(true);
      }
      showToast("Message not sent — your draft is kept.");
      return;
    }
    if (busy || abortRef.current || stoppingAuditRef.current || !alive.current || !session) return;

    const currentTurn = ++turn.current;
    const turnStartedAt = Date.now();
    activeTurnStartedAt.current = turnStartedAt;
    setBusy(true);
    appendEntry({ kind: "user", text, turn: currentTurn });
    let assistantText = "";
    // Reasoning is a separate stream from the answer and gets its own
    // accumulator so the two never interleave into one entry.
    let reasoningText = "";
    // The turn's usage, captured from the outcome so `finally` can stamp it onto
    // the answer alongside the elapsed. Null until the turn returns, so a turn
    // that throws before reporting usage simply stamps nothing.
    let turnUsage: { inputTokens: number; outputTokens: number } | null = null;
    // One controller per turn, published so Esc can reach it. It is cleared
    // in `finally`, so an Esc after the turn ended aborts nothing.
    const controller = new AbortController();
    abortRef.current = controller;
    const settled = Promise.withResolvers<void>();
    turnSettledRef.current = settled.promise;
    onAuditActivity({ title: objectiveRef.current || (entriesRef.current.find((entry) => entry.kind === "user")?.text || text).split("\n", 1)[0].slice(0, 100) });

    try {
      const outcome = await session.send(text, {
        onAssistantDelta: (chunk) => {
          assistantText += chunk;
          queueStreamPatch({
            kind: "assistant",
            text: assistantText,
            turn: currentTurn,
            at: Date.now(),
          });
        },
        onReasoningDelta: (chunk) => {
          reasoningText += chunk;
          queueStreamPatch({
            kind: "reasoning",
            text: reasoningText,
            turn: currentTurn,
            at: Date.now(),
          });
        },
        onToolStart: (call) => {
          setRunningTool(call.name);
          // A tool call ends the current thought. Reset the accumulator so
          // the NEXT reasoning entry contains only new reasoning: without
          // this, the coalescing check below sees a tool entry as `last`,
          // starts a fresh entry, and re-prints the entire thought history.
          reasoningText = "";
          const args = formatToolArgs(call);
          appendEntry({
            kind: "tool",
            text: call.name,
            detail: args,
            toolArgs: args,
            turn: currentTurn,
          });
        },
        onToolResult: (call, result) => {
          flushStreamPatches();
          setRunningTool(null);
          if (!result.success) recordProblem("tool", result.error, call.name);
          // SETTLE the running row `onToolStart` appended IN PLACE rather than
          // appending a second row. Without this, the running row (success
          // undefined) never resolved, so it kept SHIMMERING until the turn
          // ended and the settled card printed as a duplicate beneath it. We
          // replace the last still-running tool row for this call (LIFO, matched
          // on name + turn), preserving its id/timestamp; if somehow none is
          // pending we append (old behaviour, so nothing is ever dropped).
          const settleRunningTool = (settled: Omit<ChatEntry, "id">) => {
            setEntries((current) => {
              for (let i = current.length - 1; i >= 0; i -= 1) {
                const e = current[i];
                if (
                  e.turn === currentTurn &&
                  e.kind === "tool" &&
                  e.success === undefined &&
                  e.text === call.name
                ) {
                  const next = [...current];
                  // Give every settled tool an honest measured wall span so the
                  // duration can ride the top of its card (command cards keep
                  // their precise meta.durationMs via `settled`; every other tool
                  // gets Date.now() - start). The append-fallback below has no
                  // start stamp and legitimately stays duration-less.
                  next[i] = { ...settled, id: e.id, at: e.at, wallMs: settled.wallMs ?? (e.at != null ? Date.now() - e.at : undefined) };
                  return next;
                }
              }
              return appendTranscriptEntry<ChatEntry>(current, {
                at: Date.now(),
                ...settled,
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              });
            });
          };
          if (call.name === "spawn_agent") {
            const card = parseSubagentCard(result.success, result.output, result.error);
            if (card) {
              settleRunningTool({
                kind: "subagent",
                text: call.name,
                success: result.success,
                turn: currentTurn,
                subagentOutcome: card.outcome,
                subagentTurns: card.turns,
                subagentFindings: card.findings,
                subagentSummary: card.summary,
                subagentError: card.error ?? "",
              });
              return;
            }
            // malformed output — fall through to generic tool card
          }
          // Preserve rich metadata and a bounded projection of the actual output.
          settleRunningTool({
            kind: "tool",
            text: call.name,
            detail: formatToolResult(call, result),
            toolArgs: formatToolArgs(call),
            toolPreview: projectToolPreview(call, result),
            success: result.success,
            turn: currentTurn,
            ...toolCardFieldsFromMeta(result.meta),
          });
        },
        onUsage: (usage) => {
          // Only explicit finite caps belong in the budget meter. Cumulative
          // usage remains accounted separately from current context occupancy.
          setTurnBudget(Number.isFinite(usage.turnTokenBudget)
            ? { used: usage.turnTokensUsed, limit: usage.turnTokenBudget }
            : null);
          if (usage.kind === "planner") {
            const planned = Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : undefined;
            setLastContext(planned);
            // Replace the estimated post-compaction count with measured
            // occupancy in the inline notice.
            const pending = pendingCompactionRef.current;
            if (pending && planned !== undefined) {
              pendingCompactionRef.current = undefined;
              setEntries((current) => current.map((entry) =>
                entry.compactionNumber === pending.compactionNumber && entry.kind === "notice"
                  ? { ...entry, text: compactionIndicatorText(pending.tokensBefore, planned) }
                  : entry));
            }
          }
        },
        onCompaction: (event) => {
          setLatestCompaction(event.compactionNumber);
          // A degraded compaction has no usable post size to back-fill.
          pendingCompactionRef.current = event.degraded ? undefined : {
            compactionNumber: event.compactionNumber,
            tokensBefore: event.tokensBefore,
          };
          appendEntry({
            kind: "notice",
            text: event.degraded
              ? "⊟ compacted · summary unavailable"
              : compactionIndicatorText(event.tokensBefore),
            turn: currentTurn,
            compactionNumber: event.compactionNumber,
          });
        },
        onNotice: (notice) => {
          setScopeRules(session.scope?.raw.in_scope ?? []);
          appendEntry({ kind: "notice", text: notice, turn: currentTurn });
        },

      }, { signal: controller.signal });
      onAuditActivity({
        outcome: outcome.stopReason === "cancelled" ? "stopped"
          : outcome.stopReason === "error" ? "failed"
          : outcome.stopReason === "max_turn_tokens" || outcome.stopReason === "max_tool_iterations" || outcome.stopReason === "output_cap" ? "waiting"
          : !assistantText && !outcome.assistantText && outcome.toolCalls.length === 0 ? "failed"
          : "completed",
      });

      if (!assistantText && outcome.assistantText) {
        appendEntry({ kind: "assistant", text: outcome.assistantText, turn: currentTurn });
      }
      setSessionTokens((prev) => ({
        input: prev.input + outcome.usage.inputTokens,
        output: prev.output + outcome.usage.outputTokens,
      }));
      // Context occupancy = the tokens the last planner call actually sent (the
      // whole conversation resent — a per-call measure). Some backends
      // (e.g. the ChatGPT/Codex wire) report usage only on the RETURN value,
      // not through the streaming `onUsage(kind:"planner")` callback above — so
      // without this the meter stayed at 0% for a full conversation.
      // Crucially, outcome.usage.inputTokens is the TURN-CUMULATIVE sum of
      // every model call; using it here would wrongly inflate context
      // occupancy toward 238% when a tool-using turn re-sends the growing
      // conversation multiple times. outcome.contextInputTokens is the
      // true per-call planner input token count.
      if (outcome.contextInputTokens !== undefined && outcome.contextInputTokens > 0) {
        setLastContext(outcome.contextInputTokens);
      }
      turnUsage = { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens };

      // A turn that fails must say so. The engine reports failure through
      // `stopReason`/`error`, and neither was surfaced before: a provider
      // rejection rendered as "0 tool calls · 0→0 tok" and nothing else,
      // which reads as the agent having simply ignored the operator.
      const producedText = Boolean(assistantText || outcome.assistantText);
      if (outcome.stopReason === "error") {
        const trimmed = outcome.error?.trim();
        const detail = trimmed
          ? trimmed
          : `The runtime reported an error but gave no message — see ${tuiLogPath()}.`;
        recordProblem("runtime", outcome.error);
        appendEntry({
          kind: "error",
          text: "Could not complete this message",
          detail: `${startupRecoveryText(detail)}\nUp recalls your message.`,
          turn: currentTurn,
        });
        const recovery = connectionRecoveryForError(detail);
        if (recovery) onConnectionFailure?.(recovery);
      } else if (outcome.stopReason === "max_turn_tokens") {
        // Report the real numbers: "paused" plus a budget the operator can
        // see is far more actionable than a bare limit message.
        const used = Math.round(outcome.budget.tokensUsed / 1000);
        const limit = Math.round(outcome.budget.tokenBudget / 1000);
        appendEntry({
          kind: "error",
          text: `paused — hit the token limit for this turn (${used}k of ${limit}k)`,
          detail: "Send another message to keep going.",
          turn: currentTurn,
        });
      } else if (outcome.stopReason === "max_tool_iterations") {
        appendEntry({
          kind: "error",
          text: `paused — hit the tool-call limit (${outcome.budget.iterations} of ${outcome.budget.maxToolIterations})`,
          detail: outcome.error
            ?? "Send another message to keep going.",
          turn: currentTurn,
        });
      } else if (outcome.stopReason !== "cancelled" && outcome.stopReason !== "output_cap" && !producedText && outcome.toolCalls.length === 0) {
        // Not an error, but silence is never a useful answer.
        appendEntry({
          kind: "error",
          text: "no response from the model",
          detail: outcome.usage.inputTokens === 0 && outcome.usage.outputTokens === 0
            ? "The provider likely rejected the request. Check /doctor and your credentials."
            : "The model returned an empty reply. Try rephrasing, or /model to switch.",
          turn: currentTurn,
        });
      }

      if (settings.showTurnSummary && outcome.stopReason !== "cancelled") {
        appendEntry({
          kind: "notice",
          text: `${outcome.toolCalls.length} tool call${outcome.toolCalls.length === 1 ? "" : "s"} · ${outcome.usage.inputTokens}→${outcome.usage.outputTokens} tok`,
          turn: currentTurn,
        });
      }
    } catch (error) {
      onAuditActivity({ outcome: controller.signal.aborted ? "stopped" : "failed" });
      recordProblem("runtime", error);
      // Never surface a bare "unknown"/empty: an Error with no message falls
      // back to its name + first stack frame and a pointer to the always-on log
      // (where recordProblem just wrote the full stack).
      const detail = describeErrorForSurface(error);
      appendEntry({
        kind: "error",
        text: "Could not complete this message",
        detail: `${startupRecoveryText(detail)}\nUp recalls your message.`,
        turn: currentTurn,
      });
      const recovery = connectionRecoveryForError(detail);
      if (recovery) onConnectionFailure?.(recovery);
      setTurnBudget(null);
    } finally {
      try {
      // Drop the controller before clearing `busy`, so Esc can never abort a
      // turn that has already returned.
      if (abortRef.current === controller) abortRef.current = null;
      flushStreamPatches();
      activeTurnStartedAt.current = null;
      setBusy(false);
      // Flush any model/provider/role-map selection that arrived mid-turn. The
      // turn boundary is the only safe point to reconfigure; busyRef still
      // reads true here (state has not re-rendered), so call the idle core
      // directly rather than the busy-aware handle.
      const pendingSelection = pendingSelectionRef.current;
      if (pendingSelection) {
        pendingSelectionRef.current = null;
        applyRuntimeSelectionRef.current?.(pendingSelection);
      }
      // The turn is over: stop the tool spinner and SETTLE any tool/subagent
      // rows still in flight when it ended (interrupt, error, or a budget stop).
      // `animationKind` reads `runningTool` BEFORE `busy`, so a stale runningTool
      // would keep the shimmer alive after the turn; and an unsettled row
      // (success/outcome undefined) reads as "running" forever. Clearing both
      // stops the shimmer the instant the turn exits. No-op on a clean turn —
      // onToolResult has already settled every row.
      setRunningTool(null);
      setEntries((current) =>
        current.some(
          (e) =>
            e.turn === currentTurn &&
            ((e.kind === "tool" && e.success === undefined) ||
              (e.kind === "subagent" && e.subagentOutcome === undefined)),
        )
          ? current.map((e) =>
              e.turn === currentTurn && e.kind === "tool" && e.success === undefined
                ? { ...e, success: false, detail: e.detail || "interrupted before it returned" }
                : e.turn === currentTurn && e.kind === "subagent" && e.subagentOutcome === undefined
                  ? {
                      ...e,
                      subagentOutcome: "failed" as const,
                      subagentError: e.subagentError || "interrupted before it returned",
                    }
                  : e,
            )
          : current,
      );
      // Stamp the turn's wall-clock duration onto its assistant answer(s) so
      // the AI footer can show a real elapsed. Done once the turn has settled,
      // and only for entries that do not already carry one, so a later repaint
      // never re-times an old answer.
      const turnDuration = Date.now() - turnStartedAt;
      const usage = turnUsage;
      setEntries((current) => current.some(
        (e) => e.kind === "assistant" && e.turn === currentTurn && e.durationMs === undefined,
      )
        ? current.map((e) =>
            e.kind === "assistant" && e.turn === currentTurn && e.durationMs === undefined
              ? {
                  ...e,
                  durationMs: turnDuration,
                  // Stamp per-turn usage alongside the elapsed so the footer's
                  // token/cost segments have a real figure to render.
                  ...(usage
                    ? { usageInput: usage.inputTokens, usageOutput: usage.outputTokens }
                    : {}),
                }
              : e)
        : current);
      // Persist in `finally`, not in the success path and not in `catch`:
      // a turn that failed is exactly the one an operator wants to resume,
      // and this previously sat inside `catch`, so a SUCCESSFUL turn saved
      // nothing at all and the session picker always reported an empty history.
      if (session) {
        const firstUser = entriesRef.current.find((entry) => entry.kind === "user");
        saveSession({
          id: session.scanId,
          savedAt: Date.now(),
          target: session.target || undefined,
          model: modelId ?? undefined,
          mode: modeLabel(mode),
          cwd: process.cwd(),
          messageCount: session.messages.length,
          preview: firstUser?.text ?? "",
          // The async objective ("what am I working on") is stored as the
          // session summary so the resume browser can say what each chat was
          // FOR, not just how it opened. Empty until the objective service
          // emits; session-store drops a blank one.
          summary: objectiveRef.current || undefined,
          messages: session.messages as unknown[],
        });
        pruneSessions(undefined, { protectedIds: protectedSessionIds });
      }
      } finally {
      settled.resolve();
      if (turnSettledRef.current === settled.promise) turnSettledRef.current = null;
      }
    }
  }, [
    appendEntry,
    busy,
    flushStreamPatches,
    queueStreamPatch,
    onConnectionFailure,
    onAuditActivity,
    protectedSessionIds,
    recordProblem,
    routeSlashCommand,
    setComposerText,
    showToast,
    session,
    settings.showTurnSummary,
  ]);
  submitRef.current = send;

  // Steer a running subagent from the chat composer while drilled into it: build
  // an `operator` messaging runtime pinned to the live roster (so a dead id is
  // refused) and hand it to `sendOperatorMessage`, which re-checks addressing and
  // spools into the hub mailbox the child drains. The console session IS "Main"
  // (the parent/operator), so `selfId` matches the parent identity children reply
  // to. Honors the same operator-channel setting the session was built with.
  const deliverToSubagent = useCallback(
    (agentId: string, body: string): { ok: boolean; reason?: string } => {
      if (!settingsRef.current.allowSubagentOperatorMessaging) {
        return { ok: false, reason: "messaging sub-agents is off (see /settings)" };
      }
      const runtime: MessagingRuntime = {
        selfId: "Main",
        selfRole: "operator",
        siblingChannelEnabled: false,
        operatorChannelEnabled: true,
        projectPath: process.cwd(),
        homeDir: messagingHomeDir,
        knownPeerIds: Object.keys(activeSubagents),
      };
      const result = sendOperatorMessage(runtime, agentId, body.trim(), Date.now());
      if (result.ok) {
        // sendOperatorMessage is pure (no bus), so surface the operator's steer in
        // the IRC log here — Main → the addressed agent — the same way an
        // agent↔agent send appears via the peer_message event.
        appendEntry({
          kind: "peer",
          text: body.trim(),
          peerFrom: "Main",
          peerTo: agentNamesRef.current.get(agentId) ?? "Unnamed sub-agent",
          at: Date.now(),
          turn: turn.current,
        });
      }
      return { ok: result.ok, reason: result.reason };
    },
    [settingsRef, activeSubagents, appendEntry, messagingHomeDir],
  );

  // The programmatic operator-submit path, exposed to the coordinator via
  // `submitHandle` (the finding-detail "Fix" action rides this). It takes the
  // EXACT disposition a typed Enter takes — a slash command routes, a message
  // sent while a turn is in flight is parked in the same queue, and an idle
  // console sends immediately — so a fix request never reaches into core tools
  // and never races the running turn. Not wired to composer history: it is not
  // something the operator typed.
  const submitOperatorMessage = useCallback((raw: string) => {
    const input = raw.trim();
    if (!input) return;
    if (!findCommand(input).isSlash && !runtimeReadyRef.current) {
      void send(raw);
      return;
    }
    const disposition = classifyComposerInput({
      input,
      isSlash: findCommand(input).isSlash,
      busy: busy || abortRef.current !== null,
      hasSession: Boolean(session),
    });
    if (disposition === "queue") {
      const { queue, accepted } = enqueueComposerInput(queuedRef.current, input);
      queuedRef.current = queue;
      setQueuedMessages(queue);
      // Steer interrupts only the main turn. Detached workers own their lifetime.
      // Queue mode waits unless the user explicitly presses empty Enter.
      const interrupting = accepted && settings.busyInputMode === "steer" && interruptTurn();
      if (!interrupting) {
        appendEntry({
          kind: accepted ? "notice" : "error",
          text: accepted
            ? `queued — will send when the current turn ends: ${input}`
            : `queue is full (${COMPOSER_QUEUE_LIMIT} messages); not queued: ${input}`,
          turn: turn.current,
        });
      }
      // The transient stopping status covers the wait until the idle drain.
    } else if (disposition === "send") {
      void send(input);
    }
  }, [appendEntry, busy, send, session, interruptTurn, settings.busyInputMode]);

  useEffect(() => {
    if (!submitHandle) return;
    submitHandle.current = submitOperatorMessage;
    return () => {
      submitHandle.current = null;
    };
  }, [submitHandle, submitOperatorMessage]);
  useEffect(() => {
    const prompt = initialPromptRef.current;
    if (!prompt || !session) return;
    initialPromptRef.current = null;
    submitOperatorMessage(prompt);
  }, [session, submitOperatorMessage]);

  // ── Command-menu pointer handlers (hover + click) ──────────────────────────
  // The shared `DialogSelectBody` reports a hovered row and a clicked row; both
  // reuse the SAME select/run path the keyboard already drives, so the mouse is
  // purely additive and steals nothing from the module keyboard handler.
  // Hover highlights (moves the cursor); a click activates the row exactly as
  // pressing Enter on it would.
  const hoverSlashCommand = useCallback((index: number) => {
    setSlashSelected(index);
  }, []);
  const scrollSlashCommand = useCallback((delta: number) => {
    setSlashSelected((current) =>
      Math.min(Math.max(0, current + delta), Math.max(0, menuCommands.length - 1)),
    );
  }, [menuCommands.length]);
  const activateSlashCommand = useCallback((index: number) => {
    const command = menuCommands[index];
    if (!command) return;
    setSlashSelected(index);
    const parsed = findCommand(composerRef.current);
    const input = completionFor(command, parsed.args);
    // A command whose usage still expects arguments and has none typed yet
    // completes into the composer (the Tab affordance) rather than running with
    // an empty argument; anything runnable submits, exactly like Enter.
    if (!parsed.args && completionFor(command).endsWith(" ")) {
      setComposerText(input);
      setCommandMenuVisible(true);
      return;
    }
    historyRef.current = pushHistory(historyRef.current, input);
    submitOperatorMessage(input);
    if (!restorePaletteDraft()) {
      composingRef.current = false;
      setComposerText("");
      setComposing(false);
      setCommandMenuVisible(false);
    }
  }, [menuCommands, submitOperatorMessage, setComposerText, setCommandMenuVisible, restorePaletteDraft]);


  // Deliver one parked message per idle transition. One at a time rather than a
  // loop: delivering makes the console busy again, so the NEXT idle drains the
  // one after it. That preserves FIFO order without the drain re-entering
  // itself, and it means a queued message never races the turn it was typed
  // during.
  useEffect(() => {
    if (busy || abortRef.current || stoppingAuditRef.current || !alive.current || !session || !runtimeReadyRef.current) return;
    const { next, rest } = dequeueComposerInput(queuedRef.current);
    if (next === undefined) return;
    queuedRef.current = rest;
    setQueuedMessages(rest);
    void submitRef.current?.(next);
  }, [busy, session, checkingModel]);

  // usePaste shares AppContext.keyHandler with useKeyboard, so an overlay
  // owns the paste exclusively while the persistent chat remains mounted.
  usePaste((event) => {
    if (!interactive || stoppingAuditRef.current) return;
    const text = sanitizeComposerText(decodePasteBytes(event.bytes).replace(/\r\n?/g, "\n"));
    if (!text) return;
    if (secretPrompt) {
      setSecretPrompt((prompt) => prompt ? { ...prompt, value: prompt.value + text } : prompt);
      return;
    }
    if (pendingOperatorQuestion) {
      setOperatorState((state) => state ? operatorAppend(state, text) : state);
      return;
    }
    if (approvalPrompt || picker) return;
    composingRef.current = true;
    setComposing(true);
    // OMP-style collapse: an image path or a long text paste becomes a compact
    // chip marker instead of dumping raw content into the composer; a short
    // paste appends inline as before. Length/shape are measured on the SANITIZED
    // text. The chip is literal text, so wrapping/history/slash-menu are intact;
    // Enter expands it back to the full payload before the message ships.
    const trimmed = text.trim();
    if (IMAGE_PATH_RE.test(trimmed) && existsSync(trimmed)) {
      const { marker } = addImage(pasteStoreRef.current, (pasteCounterRef.current += 1), trimmed);
      setComposerText(composerRef.current + marker);
    } else if (isLongPaste(text)) {
      const { marker } = addText(pasteStoreRef.current, (pasteCounterRef.current += 1), text);
      setComposerText(composerRef.current + marker);
    } else {
      setComposerText(composerRef.current + text);
    }
  });

  useKeyboard((key) => {
    if (!interactive || stoppingAuditRef.current) return;
    // While the right-click context menu is open it owns the keyboard (its own
    // handler moves the highlight / activates / closes); bail so the transcript
    // beneath does not also act on Up/Down/Enter/Esc.
    if (transcriptMenu.state.open) return;
    // The `ask_operator` modal takes precedence exactly like an approval prompt,
    // but it AUTHORIZES NOTHING — Esc resolves a `null` answer (the tool renders
    // that as "dismissed, nothing authorized"), Enter resolves the collected
    // selections + custom text. Space toggles the highlighted option (or types a
    // space into an active free-text field); other printable keys type into it.
    // Ctrl+C still exits, resolving null first so the awaiting turn is released.
    if (pendingOperatorQuestion) {
      if (key.ctrl && key.name === "c") {
        requestExitRef.current(() => pendingOperatorQuestion.resolve(null));
        return;
      }
      if (key.name === "escape") {
        pendingOperatorQuestion.resolve(null);
        setPendingOperatorQuestion(null);
        return;
      }
      if (key.name === "return") {
        pendingOperatorQuestion.resolve(operatorStateRef.current ? buildOperatorAnswer(operatorStateRef.current) : null);
        setPendingOperatorQuestion(null);
        return;
      }
      if (key.name === "up" || key.name === "down") {
        const dir = key.name;
        setOperatorState((s) => (s ? operatorMove(s, dir) : s));
        return;
      }
      if (key.name === "space" || key.sequence === " ") {
        setOperatorState((s) => {
          if (!s) return s;
          return operatorActiveRow(s)?.kind === "custom" ? operatorAppend(s, " ") : operatorToggle(s);
        });
        return;
      }
      if (key.name === "backspace") {
        setOperatorState((s) => (s ? operatorBackspace(s) : s));
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= " ") {
        const char = key.sequence;
        setOperatorState((s) => (s ? operatorAppend(s, char) : s));
        return;
      }
      return;
    }
    // Authorization prompts are modal and drive the SAME selector reducer the
    // command pickers use, so ↑↓/enter/esc mean one thing everywhere. Ctrl+C
    // still exits — a modal must never trap the operator — and takes the
    // declining path on the way out rather than dropping the promise.
    if (approvalPrompt) {
      if (key.ctrl && key.name === "c") {
        requestExitRef.current(() => approvalPrompt.decline());
        return;
      }
      if (key.name === "escape") {
        approvalPrompt.decline();
        return;
      }
      if (approvalPrompt.completeDetails && (key.name === "pageup" || key.name === "pagedown")) {
        const body = approvalDetailsScrollRef.current;
        if (body) body.scrollTop += (key.name === "pageup" ? -1 : 1) * Math.max(1, approvalBodyRows - 1);
        return;
      }
      if (key.name === "return") {
        const choice = approvalState ? highlighted(approvalState) : undefined;
        // No highlighted row (the filter matched nothing) is NOT a grant:
        // the prompt simply stays open.
        if (choice && !choice.disabled) approvalPrompt.decide(choice.id);
        return;
      }
      if (key.name === "up" || key.name === "down") {
        stepApproval(key.name);
        return;
      }
      return;
    }
    // The picker is modal: while it is open it owns navigation, typing and
    // Enter, so a stray keystroke cannot leak into the composer behind it.
    // Ctrl+C still exits, because a modal must never trap the operator.
    if (secretPrompt) {
      if (key.ctrl && key.name === "c") {
        requestExitRef.current();
        return;
      }
      if (key.name === "escape") {
        setSecretPrompt(null);
        return;
      }
      if (key.name === "return") {
        const entry = secretPrompt;
        setSecretPrompt(null);
        const secret = entry.value.trim();
        if (!secret) {
          appendEntry({ kind: "notice", text: "no credential entered; nothing was saved", turn: turn.current });
          return;
        }
        const stored = loadCredentials();
        const ok = saveCredentials({ ...stored, [entry.providerId]: secret });
        // The secret itself is never echoed back into the transcript.
        appendEntry({
          kind: ok ? "notice" : "error",
          text: ok
            ? `${entry.label} credential saved (${redactSecret(secret)})`
            : `could not save the ${entry.label} credential`,
          detail: ok
            ? `Stored owner-only and exported as ${entry.envVar}. Use /model to switch to one of its models.`
            : "The credentials file could not be written.",
          turn: turn.current,
        });
        if (ok) process.env[entry.envVar] = secret;
        return;
      }
      if (key.name === "backspace") {
        setSecretPrompt((p) => (p ? { ...p, value: p.value.slice(0, -1) } : p));
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= " ") {
        const char = key.sequence;
        setSecretPrompt((p) => (p ? { ...p, value: p.value + char } : p));
        return;
      }
      return;
    }
    if (picker) {
      if (key.ctrl && key.name === "c") {
        requestExitRef.current();
        return;
      }
      if (key.name === "escape") {
        picker.onCancel?.();
        setPicker(null);
        return;
      }
      if (key.name === "return") {
        const choice = highlighted(picker.state);
        const commit = picker.commit;
        setPicker(null);
        if (choice && !choice.disabled) commit(choice.id);
        return;
      }
      if (key.name === "up") {
        setPicker((p) => (p ? { ...p, state: reduceSelector(p.state, { type: "up" }) } : p));
        return;
      }
      if (key.name === "down") {
        setPicker((p) => (p ? { ...p, state: reduceSelector(p.state, { type: "down" }) } : p));
        return;
      }
      if (key.name === "backspace") {
        setPicker((p) => (p ? { ...p, state: reduceSelector(p.state, { type: "backspace" }) } : p));
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= " ") {
        const char = key.sequence;
        setPicker((p) => (p ? { ...p, state: reduceSelector(p.state, { type: "append", char }) } : p));
        return;
      }
      return;
    }
    if (key.ctrl && key.name === "c") {
      requestExitRef.current();
      return;
    }
    // The rebindable set resolves its chord through `matchesBinding` against the
    // operator's persisted overrides rather than a hard-coded `key.name` literal,
    // so `/keybindings` remaps actually take effect. `matchesBinding` falls back
    // to the registry default when there is no override. The protected set
    // Composer navigation and protected exit/scroll keys keep literal guards.
    const keybindingOverrides = settingsRef.current.keybindings;
    const chatShortcut = settings.showSubagents ? agentChatSwitcherShortcut(key) : null;
    if (chatShortcut) {
      key.preventDefault();
      key.stopPropagation();
      if (chatShortcut === "main") selectAgentChat(null);
      else selectAgentChat(adjacentAgentChatTab(activeAgentChatTabs(projectedHerdRef.current),
        focusAgentRef.current, chatShortcut === "previous" ? -1 : 1));
      return;
    }
    if (focusAgentId && key.name === "escape") {
      returnToConversation();
      return;
    }
    // Transcript scrolling lives on PageUp/PageDown (and Ctrl+Up/Ctrl+Down
    // where the terminal distinguishes them), NOT on plain Up/Down — those
    // recall composer history. The box is non-focusable, so it never grabs the
    // arrows itself; we drive it explicitly here. Sticky-bottom auto-scroll
    // keeps the newest evidence in view the rest of the time.
    // Main-transcript scrolling is rebindable (nav.scroll-up / nav.scroll-down).
    // The default answers PageUp/Ctrl+Up and PageDown/Ctrl+Down; an override
    // replaces those with the operator's chord. The focused worker view keeps
    // literal guards because it scrolls a different surface.
    if (matchesBinding(key, "nav.scroll-up", keybindingOverrides)) {
      transcriptRef.current?.scrollBy(-0.5, "viewport");
      return;
    }
    if (matchesBinding(key, "nav.scroll-down", keybindingOverrides)) {
      transcriptRef.current?.scrollBy(0.5, "viewport");
      return;
    }
    // The rebindable global chords, resolved through `matchesBinding` (see the
    // const above) so `/keybindings` remaps take effect. They are handled above
    // the composing block so a chord never reaches the composer's text catch-all
    // (which only appends non-ctrl sequences anyway).
    //
    // transcript-detail flips the whole transcript between collapsed and
    // expanded detail; both sidebars toggle their pane. All three persist via
    // the settings store (the same layer `/settings` writes), so the choice
    // survives the session and the store's subscribers repaint immediately.
    if (startupError && key.ctrl && key.name === "r") {
      if (!checkingModel) void checkRuntime();
      return;
    }
    if (matchesBinding(key, "view.transcript-detail", keybindingOverrides)) {
      updateSetting(
        "transcriptDetail",
        settingsRef.current.transcriptDetail === "collapsed" ? "expanded" : "collapsed",
      );
      return;
    }
    if (matchesBinding(key, "nav.jump-agents", keybindingOverrides)) {
      const tabs = activeAgentChatTabs(projectedHerdRef.current);
      if (tabs.length) selectAgentChat(adjacentAgentChatTab(tabs, focusAgentRef.current, 1));
      return;
    }
    // nav.open-comms (Ctrl+T) opens the agent comms view via the shell nav.
    if (matchesBinding(key, "nav.open-comms", keybindingOverrides)) {
      onNavigate("comms");
      return;
    }
    // Ctrl+Y pulls the most recently queued message back into the composer for
    // editing — which doubles as cancel: it leaves the queue, and dropping it
    // (Esc) or re-sending it (Enter, re-queued at the back while still busy) is
    // then just normal composer editing. Newest-first so a hurried operator can
    // fix the last thing they typed without disturbing earlier parked lines.
    if (matchesBinding(key, "composer.edit-queued", keybindingOverrides) && queuedRef.current.length > 0) {
      const queue = queuedRef.current;
      const last = queue[queue.length - 1];
      const rest = queue.slice(0, -1);
      queuedRef.current = rest;
      setQueuedMessages(rest);
      composingRef.current = true;
      setComposing(true);
      setComposerText(last);
      return;
    }
    // Shift+Tab cycles the autonomy mode. It is handled ABOVE the composing
    // block for two reasons: it should work while the operator is mid-sentence,
    // and the composing block's catch-all appends `key.sequence` for anything
    // without ctrl/meta — which meant Shift+Tab used to paste its own raw
    // escape sequence (`\x1b[Z`, or `\x1b[9;2u` under the kitty protocol) into
    // the composer.
    //
    // Shift+Tab applies the mode transition directly; autonomy is not a slash
    // command and stays out of the command chooser.
    if (isAutonomyCycleKey(key)) {
      if (!session) {
        showToast("Not ready yet — mode unchanged");
        return;
      }
      const next = nextAutonomyMode(modeRef.current);
      session.setAutonomyMode(next);
      modeRef.current = next;
      setMode(next);
      showToast(`${modeLabel(next)} mode${busy ? " · from the next tool call" : ""}`);
      return;
    }
    if (matchesBinding(key, "nav.palette", keybindingOverrides)) {
      if (restorePaletteDraft()) return;
      paletteDraftRef.current = { text: composerRef.current, composing: composingRef.current };
      composingRef.current = true;
      setComposing(true);
      setComposerText("/");
      return;
    }
    if (key.name === "escape") {
      if (restorePaletteDraft()) return;
      if (commandMenuOpenRef.current && composerRef.current.trimStart().startsWith("/")) {
        setCommandMenuVisible(false);
        return;
      }
      if (composingRef.current) {
        composingRef.current = false;
        setComposerText("");
        setComposing(false);
        return;
      }
      // Esc interrupts the main turn, not its independently running workers.
      // Overlay and draft dismissal keep precedence over turn interruption.
      if (interruptTurn()) return;
      onGoBack();
      return;
    }
    if (key.name === "return" && !key.shift && !focusAgentId) {
      const action = queuedInputAction({
        input: composerRef.current,
        busy: busy || abortRef.current !== null,
        hasSession: Boolean(session) && runtimeReadyRef.current,
        queuedCount: queuedRef.current.length,
      });
      if (action !== "none") {
        if (action === "interrupt") {
          // Keep the queue intact until the interrupted send has settled.
          interruptTurn();
        } else {
          const { next, rest } = dequeueComposerInput(queuedRef.current);
          queuedRef.current = rest;
          setQueuedMessages(rest);
          if (next !== undefined) void send(next);
        }
        composingRef.current = false;
        setComposerText("");
        setComposing(false);
        return;
      }
    }
    if (composingRef.current) {
      if (commandMenuOpenRef.current && composerRef.current.trimStart().startsWith("/")) {
        if (key.name === "left" && !key.ctrl && !key.meta && !key.option) {
          // Leave the completion menu and put the caret inside the draft;
          // this does not apply the command or discard its text.
          setCommandMenuVisible(false);
          moveComposerCursor(-1);
          return;
        }
        if (key.name === "up") {
          setSlashSelected((current) => Math.max(0, current - 1));
          return;
        }
        if (key.name === "down") {
          if (menuCommands.length <= 1) {
            // There is no next command. Leave the single-result menu instead
            // of pretending to move (or silently running its only command).
            setCommandMenuVisible(false);
          } else {
            setSlashSelected((current) => Math.min(menuCommands.length - 1, current + 1));
          }
          return;
        }
        if (key.name === "tab") {
          if (selectedSlashCommand) {
            setComposerText(completionFor(selectedSlashCommand, findCommand(composerRef.current).args));
            setCommandMenuVisible(true);
          }
          return;
        }
      }
      // Outside the command menu, Up/Down recall submitted-message history into
      // the composer (readline semantics) rather than scrolling the transcript.
      if (key.name === "up") {
        recallComposerHistory("up");
        return;
      }
      if (key.name === "down") {
        recallComposerHistory("down");
        return;
      }
      // The suggestion is accepted only at end-of-input; otherwise the arrow
      // moves the visible caret through the draft one grapheme at a time.
      if (key.name === "left" && !key.ctrl && !key.meta && !key.option) {
        moveComposerCursor(-1);
        return;
      }
      if (key.name === "right" && !key.ctrl && !key.meta && !key.option) {
        if (composerCursorRef.current < composerRef.current.length) {
          moveComposerCursor(1);
          return;
        }
        const suffix = settingsRef.current.composerSuggestions
          && !composerRef.current.trimStart().startsWith("/")
          ? suggestCompletion(composerRef.current, historyRef.current)
          : null;
        if (suffix) setComposerText(`${composerRef.current}${suffix}`);
        return;
      }
      // Shift+Enter inserts a newline; plain Enter submits. Terminals that
      // cannot distinguish the two (no kitty keyboard protocol) fall through to
      // submit, which is the safe default. The multi-line composer renders the
      // newlines and grows to fit.
      if (key.name === "return" && key.shift) {
        const at = composerCursorRef.current;
        setComposerText(`${composerRef.current.slice(0, at)}\n${composerRef.current.slice(at)}`, at + 1);
        return;
      }
      if (key.name === "return") {
        const currentComposer = composerRef.current;
        const parsed = findCommand(currentComposer);
        const useSelectedCommand = commandMenuOpenRef.current
          && composerRef.current.trimStart().startsWith("/")
          && selectedSlashCommand !== undefined
          && (!parsed.rawName || (!parsed.isKnown && commandMatchesPrefix(selectedSlashCommand, parsed.rawName)));
        const input = useSelectedCommand && selectedSlashCommand
          ? completionFor(selectedSlashCommand, parsed.args)
          : currentComposer;
        if (!input.trim()) {
          composingRef.current = false;
          setComposerText("");
          setComposing(false);
          return;
        }
        // Expand any paste chips back to their full payloads HERE, at the Enter
        // boundary — before pushHistory and submit. This must happen outside the
        // send path: submitOperatorMessage may QUEUE the raw string and the idle
        // drain replays it later, so expanding inside send would ship literal
        // markers. History stores the EXPANDED text so Up-arrow recall still
        // works after the store keys are cleared. A slash command has no markers,
        // so expansion is a no-op there.
        const { text: expandedInput, consumedIds: consumedPasteIds } = expandPasteMarkers(input, pasteStoreRef.current);
        // Drilled into a subagent: a plain message is steered straight to it via
        // the hub mailbox, not sent to the main agent. Slash commands still run
        // as commands (they fall through), so settings and tools remain usable.
        if (focusAgentId && !findCommand(input).isSlash) {
          const worker = herdAgents[focusAgentId];
          const terminalWorker = worker?.status === "completed" || worker?.status === "failed";
          if (terminalWorker) {
            const result = renderInboundMessage({ id: `${focusAgentId}-followup`, from: focusAgentId, to: "Main", ts: Date.now(), body: worker.summary ?? worker.error ?? "" }).text;
            submitOperatorMessage(`Follow up on ${worker.name ?? focusAgentId}.\nTask: ${worker.task}\n${result}\n\nOperator request: ${expandedInput}`);
            setFocusAgentId(null);
          } else {
            const res = deliverToSubagent(focusAgentId, expandedInput);
            setSubagentTranscripts((prev) => ({ ...prev, [focusAgentId]: [...(prev[focusAgentId] ?? []), { id: `${focusAgentId}-operator-${Date.now()}`, kind: res.ok ? "user" : "error", text: res.ok ? expandedInput : `${res.reason ?? "Message not delivered"}. Draft kept · esc returns to main.`, turn: worker?.turn ?? 0, at: Date.now() }] }));
            if (!res.ok) return;
          }
          historyRef.current = pushHistory(historyRef.current, expandedInput);
          clearConsumedPastes(consumedPasteIds);
          setCommandMenuVisible(false);
          if (terminalWorker) {
            returnToConversation();
          } else {
            composingRef.current = false;
            setComposerText("");
            setComposing(false);
          }
          return;
        }
        if (!findCommand(input).isSlash && !runtimeReadyRef.current) {
          showToast(checkingModel
            ? "Still checking the model — your draft is kept."
            : "Not connected — your draft is kept.");
          return;
        }
        // Remember every submitted message (sent or queued) for Up/Down recall.
        // Done before the setComposerText("") below, which re-bases the history
        // cursor onto the freshly-grown ring.
        historyRef.current = pushHistory(historyRef.current, expandedInput);
        const messagingWorker = Boolean(focusAgentId);
        submitOperatorMessage(expandedInput);
        clearConsumedPastes(consumedPasteIds);
        if (messagingWorker && workerDraftRef.current === null) return;
        if (!restorePaletteDraft()) {
          composingRef.current = false;
          setComposerText("");
          setComposing(false);
          setCommandMenuVisible(false);
        }
        return;
      }
      // Edit the text before the caret and keep the untouched suffix. The
      // existing tail-oriented transforms also work on that prefix.
      const at = composerCursorRef.current;
      const prefix = composerRef.current.slice(0, at);
      const suffix = composerRef.current.slice(at);
      if (key.ctrl && key.name === "u") {
        const next = deleteToLineStart(prefix);
        setComposerText(next + suffix, next.length);
        return;
      }
      if ((key.ctrl && key.name === "w") || (key.name === "backspace" && (key.meta || key.option || key.ctrl))) {
        const next = deletePreviousWord(prefix);
        setComposerText(next + suffix, next.length);
        return;
      }
      if (key.name === "backspace") {
        const next = deletePreviousCharacter(prefix);
        setComposerText(next + suffix, next.length);
        return;
      }
      if (key.sequence && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(key.sequence)) {
        setComposerText(`${prefix}${key.sequence}${suffix}`, at + key.sequence.length);
      }
      return;
    }
    if (!composingRef.current && composerRef.current.length === 0 && settings.showSubagents) {
      const workItems = agentChatWorkItems(projectedHerdRef.current);
      const currentIndex = workItems.findIndex((item) => item.id === focusAgentRef.current);
      if (key.name === "down") {
        const next = workItems[currentIndex < 0 ? 0 : currentIndex + 1];
        if (next) {
          selectAgentChat(next.id);
          return;
        }
        if (focusAgentRef.current) return;
      }
      if (key.name === "up" && focusAgentRef.current) {
        const previous = currentIndex > 0 ? workItems[currentIndex - 1] : undefined;
        selectAgentChat(previous?.id ?? null);
        return;
      }
    }
    if (key.name === "up") {
      recallComposerHistory("up");
      return;
    }
    if (key.name === "down") {
      recallComposerHistory("down");
      return;
    }
    if (key.sequence && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(key.sequence)) {
      composingRef.current = true;
      setComposing(true);
      setComposerText(key.sequence);
    }
  });

  const empty = entries.length === 0 && Object.keys(herdAgents).length === 0;
  // Parked messages are surfaced next to the working indicator, because that is
  // exactly where the operator is looking while they wait.
  const queueLabel = composerQueueLabel(queuedCount);
  // The header owns engagement posture: target, scope, session state, and the
  // optional objective. Autonomy mode belongs beside model and workspace state
  // in the bottom bar, where it is available without competing with the target.
  const focusedTelemetry = focusAgentId ? workerTelemetry[focusAgentId] : undefined;
  const activeModel = session ? runtimeInfoHandle.current?.model() : undefined;
  const activeProvider = session ? runtimeInfoHandle.current?.providerId() : undefined;
  const displayedContext = selectConversationContext(
    { modelId: activeModel, providerId: activeProvider, contextUsed: lastContext },
    focusAgentId,
    workerTelemetry,
  );
  const contextLimit = useMemo(() => settings.showContextMeter
    ? resolveContextLimit(displayedContext)
    : null, [settings.showContextMeter, displayedContext.modelId, displayedContext.providerId]);
  // Main compaction is independent of worker focus and meter visibility.
  const compactionContextWindow = useMemo(
    () => (activeModel && activeProvider)
      ? resolveContextLimit({ modelId: activeModel, providerId: activeProvider })?.tokens
      : undefined,
    [activeModel, activeProvider],
  );
  // Re-base the live session's compaction trigger after a model switch. An
  // unknown window clears the previous model's threshold rather than carrying
  // a stale limit into the next turn.
  useEffect(() => {
    sessionRef.current?.reconfigureRuntime({ contextWindowTokens: compactionContextWindow ?? null });
  }, [compactionContextWindow, activeModel, activeProvider]);
  // One bounded, display-only activity fact feeds the status pill, header,
  // composer and herdr. Never promote a past tool or thought to "current".
  const operatorQuestionOpen = Boolean(pendingOperatorQuestion && operatorState);
  const gateOpen = Boolean(pendingScope || pendingLocalScope || pendingEscalation || pendingToolApproval || secretPrompt || operatorQuestionOpen);
  const activeWorkers = Object.values(herdAgents).filter(
    (agent) => !agent.operatorStopped && (agent.status === "running" || agent.status === "queued"),
  );
  const runningWorkers = activeWorkers.filter((agent) => agent.status === "running").length;
  const queuedWorkers = activeWorkers.length - runningWorkers;
  const activeAgent = activeWorkers.find((agent) => agent.agentId === focusAgentId)
    ?? activeWorkers.find((agent) => agent.status === "running" && (agent.note || agent.tool))
    ?? activeWorkers.find((agent) => agent.status === "running")
    ?? activeWorkers[0];
  const agentDetail = activeAgent
    ? activeAgent.note
      ? activityExcerpt(activeAgent.note, 56)
      : activeAgent.tool
        ? `last tool ${activityExcerpt(activeAgent.tool, 40)}`
        : ""
    : "";
  const agentActivity = activeAgent
    ? activityExcerpt(
        `${agentTaskLabel(activeAgent.task, activeAgent.name)} · ` +
        (agentDetail || (activeAgent.status === "queued" ? "waiting to start" : "running")),
      )
    : "";
  const rootTail = busy ? entries.findLast((entry) => entry.turn === turn.current) : undefined;
  const runningEntry = runningTool
    ? entries.findLast((entry) => entry.kind === "tool" && entry.text === runningTool && entry.success === undefined)
    : undefined;
  const rootActivity = busy && !focusAgentId
    ? waitActivityLabel
      ? activityExcerpt(waitActivityLabel)
      : runningTool
        ? toolActivity(runningTool, runningEntry?.toolArgs)
        : rootTail?.kind === "reasoning"
          ? `thinking · ${reasoningExcerpt(rootTail.text) || "…"}`
          : rootTail?.kind === "assistant"
            ? "responding"
            : agentActivity || "working"
    : "";
  const activityLabel = startupError ? "" : gateOpen ? "waiting for you" : rootActivity || agentActivity || (busy ? "working" : "");
  const statusActivity = activityLabel || undefined;
  useEffect(() => {
    onAuditActivity({ activity: statusActivity ?? "" });
  }, [statusActivity, onAuditActivity]);
  const usageByModel = useMemo(() => {
    const entries: StatusBarUsageEntry[] = [];
    if (modelId && (sessionTokens.input > 0 || sessionTokens.output > 0)) {
      entries.push({
        model: modelId,
        inputTokens: sessionTokens.input,
        outputTokens: sessionTokens.output,
      });
    }
    for (const telemetry of Object.values(workerTelemetry)) {
      const usage = telemetry?.usage;
      if (!usage || usage.inputTokens <= 0 && usage.outputTokens <= 0) continue;
      entries.push({
        model: telemetry.usageModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
      });
    }
    return entries;
  }, [modelId, sessionTokens, workerTelemetry]);
  const aggregateUsage = usageByModel.reduce(
    (total, usage) => ({
      input: total.input + Math.max(0, usage.inputTokens),
      output: total.output + Math.max(0, usage.outputTokens),
      cached: total.cached + Math.max(0, usage.cachedInputTokens ?? 0),
    }),
    { input: 0, output: 0, cached: 0 },
  );
  const visibleModel = modelId ?? undefined;
  const statusSegments = buildStatusSegments({
    model: focusAgentId ? focusedTelemetry?.model : visibleModel,
    mode: autonomyFooterText(mode),
    turnElapsedMs: settings.elapsedTimer !== "off" && !focusAgentId && busy && activeTurnStartedAt.current !== null
      ? Date.now() - activeTurnStartedAt.current : undefined,
    evolution: evolutionStatus,
    cwd: process.cwd(),
    home: homedir(),
    branch: git?.isRepo ? git.branch ?? git.detachedSha : undefined,
    modified: git?.modified,
    untracked: git?.untracked,
    inputTokens: focusAgentId ? focusedTelemetry?.usage?.inputTokens : aggregateUsage.input,
    outputTokens: focusAgentId ? focusedTelemetry?.usage?.outputTokens : aggregateUsage.output,
    cachedInputTokens: focusAgentId ? focusedTelemetry?.usage?.cachedInputTokens : aggregateUsage.cached,
    usageByModel: focusAgentId
      ? focusedTelemetry?.usage
        ? [{ model: focusedTelemetry.usageModel, ...focusedTelemetry.usage }]
        : undefined
      : usageByModel,
    showTokenUsage: settings.showTokenUsage,
    // Telemetry toggles: where the model name is surfaced, whether the
    // context reading renders as a visual meter, and whether an estimated
    // dollar cost is appended. status-bar.ts honours each and invents no
    // number it was not given.
    modelDisplay: settings.modelDisplay,
    showContextMeter: settings.showContextMeter,
    contextWindow: contextLimit?.tokens,
    contextUsed: displayedContext.contextUsed,
    showCost: settings.showCost,
  });
  // The turn timer's leading glyph uses the smooth worker spinner.
  if (busy) {
    const elapsed = statusSegments.find((segment) => segment.kind === "elapsed");
    if (elapsed) elapsed.icon = spinnerGlyph(animTick, { reduceMotion: settings.reduceMotion });
  }
  // Herdr describes the coordinator's runtime even while a worker is focused.
  // Only the selected, visible audit owns the pane; off-herdr reporters are no-ops.
  const herdrContextPercent =
    compactionContextWindow && lastContext !== undefined && compactionContextWindow > 0
      ? (lastContext / compactionContextWindow) * 100
      : null;
  useEffect(() => {
    if (!interactive) return;
    reportHerdrModel(activeModel ?? null, activeProvider ?? null);
    reportHerdrContextPercent(herdrContextPercent);
    reportHerdrTarget(target || null);
    reportHerdrObjective(objective || null);
    reportHerdrActivity(statusActivity ?? null);
  }, [interactive, activeModel, activeProvider, herdrContextPercent, target, objective, statusActivity]);
  // A compaction just ran: surface it to herdr as a monotonic count token.
  // Fires once per new compaction (the effect only re-runs when the number
  // changes); guarded against the undefined initial value.
  useEffect(() => {
    if (latestCompaction === undefined) return;
    reportHerdrCompaction();
  }, [latestCompaction]);

  // The OMP-style pill row: the SAME segments, kept/dropped at the bar's real
  // width, each painted as its own coloured glyph+text with a subtle separator
  // between (rendered below via `renderStatusPills`). `statusBarText` remains as
  // the plain single-string fallback the bar degrades to if pills ever cannot
  // be drawn.
  // The picker reuses the menu's vertical budget: it occupies the same slot
  // above the composer, so it must obey the same "leave the transcript real
  // rows" rule rather than growing to the size of the model catalogue.
  //
  // The picker and an approval panel share that slot, so both are budgeted
  // the same way: ask the column what it can spare, then buy the optional
  // lines out of that budget rather than adding them on top of it.
  const selectorBudget = computeCommandMenuHeight({ height, compact, rowsPerCommand: 1 }).maxCommands;

  const pickerVisible = picker ? visibleItems(picker.state) : [];
  const pickerDetail = picker ? highlighted(picker.state)?.detail ?? "" : "";
  const pickerPlan = selectorPanelBudget({
    budget: selectorBudget,
    hasContext: false,
    hasDetail: Boolean(pickerDetail),
  });
  // The shared list body windows the full item list around the cursor itself,
  // so the picker no longer slices its own visible window — it passes the whole
  // filtered list and the absolute cursor. It still budgets the box height for
  // exactly the rows that will paint.
  const pickerVisibleRows = Math.min(pickerPlan.maxItemRows, pickerVisible.length);
  const pickerBoxHeight = selectorPanelHeight(pickerVisibleRows, false, pickerPlan.showDetail);

  // The approval card shows its choices in full (there are only ever two) and
  // spends the rest of its budget on READABLE argument rows. A long arg list is
  // truncated with a "+N more" tail rather than wrapped, so the card's height is
  // exactly what the column reserves for it.
  const approvalItems = approvalPrompt?.items ?? [];
  const approvalHasSubject = Boolean(approvalPrompt?.subject);
  const approvalBodyAll = approvalPrompt?.bodyLines ?? [];
  const approvalMaxBody = compact ? 2 : 5;
  const approvalBodyShown = !approvalPrompt?.completeDetails && approvalBodyAll.length > approvalMaxBody
    ? [
        ...approvalBodyAll.slice(0, Math.max(0, approvalMaxBody - 1)),
        `+${approvalBodyAll.length - Math.max(0, approvalMaxBody - 1)} more`,
      ]
    : approvalBodyAll;
  const approvalBodyRows = Math.min(approvalBodyShown.length, approvalMaxBody);
  const approvalBoxHeight = approvalPrompt
    ? approvalCardRows({
        hasSubject: approvalHasSubject,
        bodyRows: approvalBodyRows,
        choiceRows: approvalItems.length,
      })
    : 0;

  // ── The ask_operator modal: budget, body window, footer hint ───────────────
  // The body (headers + prose + option/custom rows) lives in a fixed-height
  // scrollbox, so it is bought out of the SAME column budget the picker/approval
  // use and can never over-subscribe the column, however many questions arrive.
  const operatorRows: OperatorDisplayRow[] = operatorState ? planOperatorRows(operatorState) : [];
  // Title + footer + two border rows on top of the body viewport.
  const OPERATOR_CHROME_ROWS = 4;
  const operatorBodyViewport = operatorQuestionOpen
    ? Math.max(1, Math.min(operatorRows.length, Math.max(1, selectorBudget - (OPERATOR_CHROME_ROWS - 2))))
    : 0;
  const operatorBoxHeight = operatorQuestionOpen ? operatorBodyViewport + OPERATOR_CHROME_ROWS : 0;
  const operatorHintPairs: KeyHint[] = [
    { key: "↑↓", label: "move" },
    ...(operatorState && operatorHasOptions(operatorState) ? [{ key: "space", label: "toggle" }] : []),
    { key: "enter", label: "confirm" },
    { key: "esc", label: "dismiss" },
  ];
  // The masked credential panel stays a typed field — a secret is entered,
  // not chosen — but it gets the same treatment that stops a panel from
  // collapsing: four content lines plus two border rows, stated explicitly.
  const SECRET_PANEL_HEIGHT = 6;
  // The live focus subject: the drilled-into agent's rich record and its roster
  // peer, both looked up from the SAME herd map. `focused` gates the inline
  // focus view and suppresses the rail / subagent block while it is open.
  const nowMs = Date.now();
  const focusRecord = focusAgentId ? projectedHerdAgents[focusAgentId] : undefined;
  const focusAgentName = focusRecord ? agentTaskLabel(focusRecord.task, focusRecord.name, Infinity) : "Sub-agent";
  const focused = Boolean(focusAgentId && focusRecord);
  const transcriptWidth = Math.max(1, contentWidth - 1);
  // "0" is 4 cells. The optional objective sits at the top-right; target,
  // scope, and readiness take the remaining header cells. Autonomy mode lives
  // in the bottom status bar rather than competing with engagement posture.
  const headerWidth = Math.max(0, width - 2);
  const headerEngagementWidth = Math.max(1, headerWidth - 5);
  // Relative ages need a clock, but the transcript must not repaint every
  // second just to age a label. Tick only while timestamps are enabled, and
  // only at the granularity the format actually shows.
  // Density stays the spacing knob; the three visual knobs are resolved
  // separately and are orthogonal to it. An env override lets a style be pinned
  // for a preview or a capture without touching the settings file.
  const transcriptStyleSettings = resolveTranscriptStyleSettings(settings, process.env);
  // The operator gate is expectant, not a busy spinner. The live tail
  // determines whether answer tokens are actually streaming.
  const animationKind: AnimationKind | null = startupError ? null : gateOpen
    ? "awaiting-operator"
    : runningTool
      ? "tool"
      : !session
        ? "connecting"
        : busy
          ? (rootTail?.kind === "assistant" ? "streaming" : "thinking")
          : null;
  // Reset before painting so a new activity never inherits the previous timer.
  const activitySince = useMemo(() => Date.now(), [animationKind]);
  // animTick is read only to make the frame recompute on each interval.
  void animTick;
  // A genuine running state shimmers unless reduced motion is enabled. An
  // operator gate is static because it is the human's turn, not the machine's.
  const shimmerActive =
    !settings.reduceMotion && !gateOpen && (animationKind !== null || runningWorkers > 0);
  const entryDisplay: EntryDisplay = {
    spacing: settings.density === "compact" ? 0 : 1,
    showTimestamps: settings.showTimestamps,
    now: clockTick,
    transcriptStyle: transcriptStyleSettings.transcriptStyle,
    roleLabelStyle: transcriptStyleSettings.roleLabelStyle,
    toolCardStyle: transcriptStyleSettings.toolCardStyle,
    richToolCards: settings.richToolCards,
    mode: modeLabel(mode),
    modeColor: modeColorFor(mode, theme),
    model: visibleModel ?? "",
    modelInFooter: settings.modelDisplay === "message",
    showTokenUsage: settings.showTokenUsage,
    showCost: settings.showCost,
    transcriptDetail: settings.transcriptDetail,
    // Only live rows shimmer; reduceMotion and settled rows remain static.
    shimmerFrame: shimmerActive ? shimmerFrame : undefined,
    activeTurn: busy ? turn.current : undefined,
    activeEntryId: busy ? rootTail?.id : undefined,
  };
  const animation = animationKind
    ? frameAt(animationKind, Date.now() - activitySince, {
        label: animationKind === "awaiting-operator" ? undefined : activityLabel,
        motion: !settings.reduceMotion && animationKind !== "awaiting-operator",
      })
: null;
  const loadingLabel = animation?.glyph ?? "";
  // The active-turn elapsed pill now carries the animated spinner; idle status
  // has no elapsed segment and therefore no spinner.
  const statusContentWidth = controlsWidth;
  const visibleStatusSegments = settings.showStatusBar ? statusSegments
    : statusSegments.filter((segment) => segment.kind === "mode" || segment.kind === "elapsed");
  const statusPills = fitStatusPills(visibleStatusSegments, statusContentWidth);
  const statusBarText = fitStatusSegments(visibleStatusSegments, statusContentWidth);

  // Drive the animation at the kind's own interval; stop entirely when
  // nothing is animating so an idle console costs no repaints.
  useEffect(() => {
    if (!interactive || (!animationKind && runningWorkers === 0)) return;
    const timer = setInterval(
      () => setAnimTick((n) => n + 1),
      settings.reduceMotion || animationKind === "awaiting-operator" ? 1000 : animationKind ? frameIntervalMs(animationKind) : 120,
    );
    return () => clearInterval(timer);
  }, [animationKind, settings.reduceMotion, runningWorkers, interactive]);

  // One shared ticker for every shimmering label, at the shimmer cadence. Only
  // runs while `shimmerActive`, so a settled or idle surface costs no repaints.
  useEffect(() => {
    if (!interactive || !shimmerActive) return;
    const timer = setInterval(() => setShimmerFrame((n) => n + 1), SHIMMER_TEXT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shimmerActive, interactive]);

  const menu = computeCommandMenuLayout({ width: contentWidth + (compact ? 4 : 6), compact });
  // Height is stated explicitly so the border is drawn where the content
  // actually ends, and flexShrink is disabled so the column cannot squeeze
  // the box out from under its own children. The no-match state still needs a
  // single content row for its "No command matches" line — without it the box
  // is one row short and the hint footer overprints the bottom border.
  const commandMenuHeight = menuCommands.length > 0
    ? commandMenuBoxHeight(visibleCommandRows, commandRowsPerCommand)
    : commandMenuBoxHeight(0, commandRowsPerCommand) + 1;

  const commandMenuVisible = composing && commandMenuOpen && isSlashComposer;

  const rootTask = entries.find((entry) => entry.kind === "user")?.text ?? "";
  const mainTask = useMemo(() => rootTask.trim()
    ? agentTaskLabel(rootTask, undefined, Infinity)
    : undefined, [rootTask]);
  const agentWorkItems = useMemo(() => agentChatWorkItems(projectedHerdAgents), [projectedHerdAgents]);
  const agentWorkCount = agentWorkItems.length;
  const showAgentWorkList = settings.showSubagents && (Boolean(focusAgentId) || agentWorkCount > 0);
  const agentWorkRows = showAgentWorkList
    ? agentWorkListHeight(agentWorkItems, focusAgentId, contentWidth,
        Math.min(12, Math.max(2, height - 16)), mainTask)
    : 0;

  // Every other region in the column is flexShrink={0}, so the transcript
  // absorbs all the pressure. Compute what it actually has left: a
  // scrollbox squeezed below its content still paints that content, and
  // the empty state then interleaves into itself.
  //
  // Each reservation below is the panel's REAL rendered height plus its
  // marginTop, not a guess. The approval slot used to be a fixed 6 while
  // the panel it stood for wrapped its text — a long tool name or reason
  // made the box taller than the rows reserved, the column over-subscribed,
  // and everything downstream of that (the fused approval card, the fused
  // subagent rows, the transcript that would not scroll to the bottom)
  // followed from the same miscount.
  const composerStyle: TuiSettings["composerStyle"] =
    settings.composerStyle === "border" ? "rail" : settings.composerStyle;
  const composerInnerTextWidth = Math.max(1, contentWidth - (composerStyle === "rail" ? 5 : 3));
  const composerInputRows = composing
    ? composerContentRows(sanitizeComposerText(composer).replace(/\t/g, "    "), composerInnerTextWidth).length : 1;
  const ledgerRows = computeLedgerRows({
    // The activity row uses this existing ticker and stays beside the composer.
    height,
    compact,
    composerRows: composerInputRows + (composerStyle === "plain" ? 0 : 2) + 1,
    // The picker and the command menu occupy the same slot and both carry a
    // marginTop, which computeLedgerRows adds for a non-zero menuRows.
    menuRows: commandMenuVisible ? commandMenuHeight : picker ? pickerBoxHeight : 0,
    subagentRows: agentWorkRows > 0 ? agentWorkRows + 1 : 0,
    approvalRows: (approvalPrompt ? approvalBoxHeight + 1 : 0)
      + (secretPrompt ? SECRET_PANEL_HEIGHT + 1 : 0)
      + (operatorQuestionOpen ? operatorBoxHeight + 1 : 0),
    hintRows: 1 + (busy || gateOpen || runningWorkers > 0 ? 1 : 0),
  });
  // Keep the brand visible when access needs repair; reserve the compact,
  // truthful connection notice before deciding whether the block mark fits.
  const heroRecoveryRows = startupError ? 4 : checkingModel ? 2 : 0;
  const showRepositorySuggestions = interactive && git?.isRepo === true
    && contentWidth >= 58 && height >= 24 && !composingRef.current;
  const heroBrandRows = Math.max(0, ledgerRows - heroRecoveryRows - (showRepositorySuggestions ? 3 : 0));
  const showTerminalMark =
    settings.showLogo && empty && heroBrandRows >= LEDGER_MARK_ROWS && contentWidth >= TERMINAL_BLOCK_LOGO_WIDTH;
  const activityGlyph = loadingLabel || spinnerGlyph(animTick, { reduceMotion: settings.reduceMotion });
  const activityRowText = gateOpen ? "Waiting for you"
    : busy ? waitActivityLabel || (runningTool ? toolActivity(runningTool, runningEntry?.toolArgs)
      : rootTail?.kind === "assistant" ? "Responding"
        : runningWorkers > 0 ? `Working · ${runningWorkers} ${runningWorkers === 1 ? "agent" : "agents"}` : "Working")
    : runningWorkers > 0 || queuedWorkers > 0
      ? [runningWorkers ? `${runningWorkers} working` : "", queuedWorkers ? `${queuedWorkers} queued` : ""].filter(Boolean).join(" · ")
      : "";
  const activityRow = activityRowText ? (
    <box width="100%" height={1} flexShrink={0} minWidth={0} overflow="hidden" flexDirection="row" gap={2}>
      <text width={GLYPH_CELLS} height={1} flexShrink={0} wrapMode="none" fg={gateOpen ? WARNING : MUTED}>
        {activityGlyph}
      </text>
      <text flexGrow={1} minWidth={0} height={1} wrapMode="none" truncate fg={gateOpen ? WARNING : MUTED}>
        {activityRowText}
      </text>
    </box>
  ) : null;
  const headerSegments: string[] = [];
  if (settings.showScope && session?.scopeEnforcement.enabled) headerSegments.push(`Scope: ${scopeLabel}`);
  // Version rides at the far left of the top bar, like the startup masthead,
  // carrying the build-channel badge right beside it: [dev] when launched from
  // a dev source checkout (the `0dev` wrapper exports ZERO_DEV_SOURCE_ROOT),
  // else [beta] for a published build. End fitting preserves the activity
  // prefix when a long scope label or objective constrains the header.
  const channelBadge = process.env["ZERO_DEV_SOURCE_ROOT"]?.trim() ? "[dev]" : "[beta]";
  const headerEngagement = [`v${VERSION} ${channelBadge}`, ...headerSegments].join(" · ");



  // ── The composer, single-sourced ──────────────────────────────────────────
  // ONE element, rendered in the centered hero when empty and pinned above the
  // status bar otherwise; the keyboard handler (composer text, submit, history,
  // slash menu) is the module-level `useKeyboard` above and does not move, so
  // the input wiring is identical in both positions — only this frame's
  // placement changes. The clean left-rail is the effective default in BOTH the
  // centered hero AND the pinned chat state (the start-screen look the operator
  // asked for everywhere): the stored "border" resolves to "rail", while an
  // explicit "plain" — or any deliberate non-border choice — is still honoured.
  const composerActive = composing || commandMenuVisible;
  // Real operator input is TEXT-bright; the placeholder and the parked-message
  // note are MUTED so neither reads as something typed. The working spinner is
  // deliberately NOT here — it lives once, in the transcript/hero — so the
  // composer never double-prints it.
  //
  // While composing, the input is MULTI-LINE and SOFT-WRAPS: `ComposerInput`
  // (chat/Composer.tsx) wraps the buffer on word boundaries to `textWidth`
  // cells and grows downward up to COMPOSER_MAX_ROWS, then scrolls the oldest
  // rows out to keep the tail cursor in view. The block cursor is FILLED when
  // the composer is focused (`composerActive`) and HOLLOW when it is not.
  // Autosuggestions appear only at the tail, never after an interior caret.
  const composerSuggestion = settings.composerSuggestions && composing && composerCursor === composer.length && !isSlashComposer
    ? suggestCompletion(composer, historyRef.current)
    : null;
  const composerInput = (textWidth: number) => {
    const placeholder = focusAgentId
      ? `to ${focusAgentName} · [Esc] restores Main draft`
      : checkingModel
      ? "checking service · you can keep drafting"
      : startupError
      ? "draft here · restore access to send"
      : queueLabel
        ? queueLabel
        : busy
          ? settings.busyInputMode === "queue"
            ? "type a follow-up · [⏎] queues"
            : "type a follow-up · [⏎] steers main"
          : !session
            ? "connecting · type to queue a message"
            : "type to chat or / for commands";
    return (
      <ComposerInput
        composing={composing}
        active={composerActive}
        text={composer}
        textWidth={textWidth}
        cursorIndex={composerCursor}
        placeholder={placeholder}
        placeholderTone={startupError ? ERROR : MUTED}
        theme={theme}
        suggestion={composerSuggestion}
      />
    );
  };
  // ONE composer builder, two call sites: full-width at the bottom of a chat,
  // and a constrained, centered card under the hero logo. `outerWidth` omitted
  // means width:"100%" (the pinned chat composer); a number gives the hero its
  // fixed card width. `textWidth` is always budgeted against that outer width so
  // the input can never overrun the frame. The keyboard handler is untouched by
  // either — placement is the only thing that changes.
  const buildComposer = ({
    textWidth,
    outerWidth,
    padY = 0,
  }: {
    textWidth: number;
    outerWidth?: number;
    padY?: number;
  }) => (
    <box flexDirection="row" width={outerWidth ?? "100%"} flexShrink={0} marginTop={1} minWidth={0}>
      <ComposerFrame style={composerStyle} theme={theme} padY={padY}>
        <box flexDirection="row" width="100%" minWidth={0}>
          <text width={1} flexShrink={0} fg={composing ? PRIMARY : MUTED}>›</text>
          <text width={1} flexShrink={0} fg={MUTED}> </text>
          <box width={textWidth} flexShrink={0} minWidth={0}>
            {composerInput(textWidth)}
          </box>
        </box>
      </ComposerFrame>
    </box>
  );
  const composerNode = buildComposer({
    textWidth: composerInnerTextWidth,
    outerWidth: contentWidth,
  });

  // ── Sticky context above the composer ──────────────────────────────────────
  // Only messages the operator has PARKED for the next round stay pinned
  // directly above the composer (flexShrink={0}), so the transcript (flexGrow)
  // absorbs the scroll and nothing overflows. Bounded on purpose — capped at a
  // few rows with a "+N more" tail — so it can never crowd out the transcript.
  // The "request · …" echo of the in-flight turn used to sit here too, but it
  // just restated the transcript's own last user turn, so it was removed.
  const STICKY_QUEUE_ROWS = 3;
  const stickyWidth = Math.max(1, contentWidth - 2);
  const stickyNode =
    queuedMessages.length > 0 ? (
      <box flexDirection="column" width="100%" flexShrink={0} minWidth={0} marginTop={1}>
        {queuedMessages.length > 0 ? (
          <box flexDirection="column" minWidth={0}>
            <text fg={WARNING}>
              {fitTuiText(
                `${composerQueueLabel(queuedMessages.length)} · [⏎] sends next · [⌃Y] edit`,
                contentWidth,
              )}
            </text>
            {queuedMessages.slice(0, STICKY_QUEUE_ROWS).map((message, index) => (
              <box key={`queued-${index}`} flexDirection="row" minWidth={0}>
                <box width={2} flexShrink={0} minWidth={0}>
                  <text fg={MUTED}>{`${index + 1} `}</text>
                </box>
                <box flexGrow={1} minWidth={0}>
                  <text fg={MUTED}>{fitTuiText(message, stickyWidth)}</text>
                </box>
              </box>
            ))}
            {queuedMessages.length > STICKY_QUEUE_ROWS ? (
              <text fg={MUTED}>
                {fitTuiText(`+${queuedMessages.length - STICKY_QUEUE_ROWS} more`, contentWidth)}
              </text>
            ) : null}
          </box>
        ) : null}
      </box>
    ) : null;
  // The hero composer is a centered card, not a full-bleed bar: ~60% of the
  // content column, clamped to a comfortable 40..72 cells and never wider than
  // the column itself. Four cells of chrome (rail + its gap + the "› " prefix)
  // come off the width for the input field.
  const heroContentWidth = contentWidth;
  const repoSuggestionItems = heroContentWidth >= 78
    ? REPOSITORY_STARTERS
    : COMPACT_REPOSITORY_STARTERS;
  const heroComposerWidth = Math.min(heroContentWidth, Math.max(40, Math.min(72, Math.floor(heroContentWidth * 0.6))));
  const heroComposerTextWidth = Math.max(1, heroComposerWidth - (composerStyle === "rail" ? 5 : 3));
  const heroComposerNode = buildComposer({
    textWidth: heroComposerTextWidth,
    outerWidth: heroComposerWidth,
    padY: 1,
  });
  // Centre the whole welcome group, not just the composer. Measure the actual
  // masthead, optional repository suggestions and composer instead of assuming
  // a fixed hero height. Keep measuring that block while overlays replace it,
  // so filtering the slash menu cannot move the input.
  const [heroMastheadRows, setHeroMastheadRows] = useDevUiState(devUi, "heroMastheadRows", 0);
  const [heroComposerRows, setHeroComposerRows] = useDevUiState(devUi, "heroComposerRows", 0);
  // Four rows belong to the outer header/footer; two to the shortcut line and
  // its margin. Keep enough room above the input for the tallest command menu.
  const heroMenuMaxRows = commandMenuBoxHeight(commandMenuLimit, commandRowsPerCommand);
  const heroBottomSpacer = Math.max(
    1,
    Math.min(Math.floor((height - 4 - heroMastheadRows - heroComposerRows - heroRecoveryRows - 2) / 2), height - 12 - heroMenuMaxRows),
  );

  devUi.safe = () => !busyRef.current && !busy && !fixWorking && !checkingModel &&
    !abortRef.current && !turnSettledRef.current && !sourceFixAbortRef.current &&
    !sourceFixPromiseRef.current && !stoppingAuditRef.current && !closingRef.current &&
    !stopAuditPromiseRef.current && !closePromiseRef.current && !pendingSelectionRef.current &&
    queuedRef.current.length === 0 && pendingStreamPatches.current.length === 0 &&
    pendingCancellationsRef.current.size === 0 && !pendingScope && !pendingLocalScope &&
    !pendingEscalation && !pendingToolApproval && !pendingOperatorQuestion && !secretPrompt &&
    !picker && !transcriptMenu.state.open && !pendingFeedback &&
    !problemReview && !firstProblemConsent;

  // ── Overlays that share the slot directly above the composer ───────────────
  // Extracted so the SAME nodes render whether the composer is centered (hero)
  // or pinned (chat). Each is already height-budgeted and flexShrink={0}.
  // ONE command-menu builder, sized by whichever CommandMenuLayout it is handed:
  // the full-width `menu` for the pinned chat composer, and a narrower layout for
  // the hero so the menu aligns to the centered composer card above it. `boxWidth`
  // matches the layout — "100%" in chat, the card width in the hero.
  const buildCommandMenu = (ml: typeof menu, boxWidth: number | "100%") => (
    <CommandMenu
      layout={ml}
      boxWidth={boxWidth}
      height={commandMenuHeight}
      commands={menuCommands}
      selectedIndex={slashSelected}
      visibleRows={visibleCommandRows}
      query={slashQuery}
      theme={theme}
      onActivateRow={activateSlashCommand}
      onHoverRow={hoverSlashCommand}
      onScroll={scrollSlashCommand}
    />
  );
  const commandMenuNode = commandMenuVisible ? buildCommandMenu(menu, "100%") : null;
  // The hero menu is sized so its box is exactly the composer card's width: the
  // layout's inner width is `boxWidth - chrome`, so we ask computeCommandMenuLayout
  // for a width that yields the same inner span the card border/padding leaves.
  const heroMenu = computeCommandMenuLayout({ width: heroComposerWidth + (compact ? 4 : 6), compact });
  const heroCommandMenuNode = commandMenuVisible ? buildCommandMenu(heroMenu, heroComposerWidth) : null;

  const secretNode = secretPrompt ? (
    <box flexDirection="column" width="100%" minWidth={0} height={SECRET_PANEL_HEIGHT} flexShrink={0} marginTop={1} border borderColor={WARNING} backgroundColor={PANEL_ALT} paddingX={1}>
      <box width={approvalWidth} flexShrink={0} minWidth={0}>
        <text fg={WARNING}>{fitTuiText(`${secretPrompt.label} credential`, approvalWidth)}</text>
      </box>
      <box width={approvalWidth} flexShrink={0} minWidth={0}>
        <text fg={TEXT}>{fitTuiText(`${"•".repeat(Math.min(secretPrompt.value.length, 40))}█`, approvalWidth)}</text>
      </box>
      <box width={approvalWidth} flexShrink={0} minWidth={0}>
        <text fg={MUTED}>{fitTuiText(`Saved locally as ${secretPrompt.envVar}. Never sent anywhere by 0.`, approvalWidth, { mode: "middle" })}</text>
      </box>
      <box width={approvalWidth} flexShrink={0} minWidth={0}>
        <text fg={MUTED}>{fitLegend(approvalWidth, "[⏎] save · [esc] cancel")}</text>
      </box>
    </box>
  ) : null;

  const pickerNode = picker ? (
    <SelectorPanel
      title={picker.state.title}
      subtitle={picker.state.query ? picker.state.query : `${pickerVisible.length} available`}
      items={pickerVisible}
      activeIndex={picker.state.index}
      visibleRows={pickerVisibleRows}
      detail={pickerPlan.showDetail ? pickerDetail : undefined}
      hint="[↑↓] select · type to filter · [⏎] apply · [esc] cancel"
      emptyText={`no match for "${picker.state.query}"`}
      borderColor={MUTED}
      titleColor={PRIMARY}
      contentWidth={contentWidth}
      height={pickerBoxHeight}
      theme={theme}
    />
  ) : null;

  const approvalNode = approvalPrompt && approvalState ? (
    <ApprovalCard
      title={approvalPrompt.title}
      progress={`${approvalState.index + 1}/${approvalItems.length}`}
      subject={approvalPrompt.subject}
      body={approvalBodyShown}
      choices={approvalItems}
      activeIndex={approvalState.index}
      hint={approvalPrompt.completeDetails ? "[Pg↑↓] details · [↑↓] choose · [⏎] confirm · [esc] deny" : "[↑↓] choose · [⏎] confirm · [esc] deny"}
      accent={approvalPrompt.borderColor}
      severity={approvalPrompt.severity}
      contentWidth={contentWidth}
      height={approvalBoxHeight}
      theme={theme}
      scrollBody={approvalPrompt.completeDetails ? { rows: approvalBodyRows, ref: approvalDetailsScrollRef } : undefined}
    />
  ) : null;

  const operatorQuestionNode = operatorQuestionOpen && operatorState ? (
    <OperatorQuestionCard
      rows={operatorRows}
      cursor={operatorState.index}
      hintPairs={operatorHintPairs}
      bodyViewportRows={operatorBodyViewport}
      scrollRef={operatorScrollRef}
      contentWidth={contentWidth}
      height={operatorBoxHeight}
      theme={theme}
    />
  ) : null;

  const overlaysNode = (
    <>
      {commandMenuNode}
      {secretNode}
      {pickerNode}
      {approvalNode}
      {operatorQuestionNode}
    </>
  );
  // The hero overlays match the centered composer's width (the slash menu) and
  // sit in the anchored region directly above it, so opening the menu never
  // shifts the composer or the logo group.
  const heroOverlaysNode = (
    <>
      {heroCommandMenuNode}
      {secretNode}
      {pickerNode}
      {approvalNode}
      {operatorQuestionNode}
    </>
  );


  const workerDisplay: EntryDisplay = {
    ...entryDisplay,
    model: focusedTelemetry?.model ?? "",
    shimmerFrame: focusRecord?.status === "running" && !settings.reduceMotion ? Math.floor(nowMs / 120) : undefined,
    activeTurn: focusRecord?.status === "running" ? focusedTelemetry?.turn : undefined,
    activeEntryId: focusRecord?.status === "running" ? focusEntries?.[focusEntries.length - 1]?.id : undefined,
  };
  // Per-agent LIVE telemetry for the Task launch card's sub-report rows, keyed
  // by the fleet-unique agent NAME (the card's `subReports` carry `name`, not an
  // `agent_id`). Every value is the SAME truthful producer the AGENTS rail reads
  // — final/last tokens (usage in+out+cached) and durationMs from
  // `workerTelemetry`, status + latest tool/report_status note from
  // `herdAgents`. It NEVER reads the whole-turn timer. Missing fields stay
  // undefined so the card shows only what is real.
  const taskAgentTelemetryByName = useMemo(() => {
    const byName = new Map<
      string,
      {
        id: string;
        status: string;
        tokens?: number;
        contextTokens?: number;
        durationMs?: number;
        model?: string;
        tool?: string;
        note?: string;
        assistant?: string;
        toolInput?: Record<string, unknown> | null;
        toolRunning?: boolean;
        turn?: number;
        maxTurns?: number;
      }
    >();
    for (const id in herdAgents) {
      const rec = herdAgents[id];
      const name = rec.name ?? agentNamesRef.current.get(id);
      if (!name) continue;
      const tel = workerTelemetry[id];
      const usage = tel?.usage;
      byName.set(name, {
        id,
        status: operatorStopped.has(id) ? "cancelled" : rec.status,
        tokens: usage ? usage.inputTokens + usage.outputTokens + usage.cachedInputTokens : undefined,
        contextTokens: tel?.contextTokens,
        durationMs: tel?.durationMs,
        model: tel?.model,
        tool: rec.tool,
        note: rec.note,
        turn: rec.turn,
        maxTurns: rec.maxTurns,
        // The child's latest prose + current tool (with args + in-flight flag),
        // spread LAST so the fresher message tool/args win over the coarse
        // herd `tool`. Identical to what the AGENTS rail feeds
        // `summarizeAgentActivity`; the Task card derives the same live line.
        ...summaryInputFromMessage(tel),
      });
    }
    return byName;
  }, [herdAgents, workerTelemetry, operatorStopped]);
  const renderTranscriptEntries = (transcript: readonly ChatEntry[], width: number, display: EntryDisplay) => {
    // A scrollbox keeps its entire child tree mounted. Spend rich Markdown's
    // native text-buffer budget from the tail backward, so the newest answer
    // remains styled while older rows degrade gracefully to plain previews.
    const richMarkdownEntryIds = new Set<string>();
    let remainingRichChars = MAX_RICH_TRANSCRIPT_CHARS;
    for (let index = transcript.length - 1; index >= 0; index--) {
      const entry = transcript[index];
      if (entry.kind !== "assistant" && entry.kind !== "reasoning") continue;
      const chars = Math.min(entry.text.length, MAX_TRANSCRIPT_PREVIEW_CHARS);
      if (chars > remainingRichChars) continue;
      richMarkdownEntryIds.add(entry.id);
      remainingRichChars -= chars;
    }
    // Deduplicate settled reasoning headings per turn, but a fresh live
    // reasoning event after a tool still identifies its current work.
    const reasoningShownForTurn = new Set<number>();
    const tail = transcript[transcript.length - 1];
    const liveReasoningId =
      tail && tail.id === display.activeEntryId && tail.kind === "reasoning" ? tail.id : undefined;
    return planTranscript(transcript, display.transcriptDetail, expandedTurns).map((item) => {
      if (item.type === "fold") {
        const hasReasoning = item.entries.some((entry) => entry.kind === "reasoning");
        const containsLiveReasoning = item.entries.some((entry) => entry.id === liveReasoningId);
        const hideReasoningLabel =
          hasReasoning && reasoningShownForTurn.has(item.turn) && !containsLiveReasoning;
        if (hasReasoning) reasoningShownForTurn.add(item.turn);
        return renderFold(
          item,
          width,
          display,
          theme,
          {
            hovered: hoveredTurn === item.turn,
            onToggle: () => toggleTurnExpanded(item.turn),
            onHover: (hovered) => setHoveredTurn(hovered ? item.turn : null),
          },
          { hideReasoningLabel },
        );
      }
      const rawEntry = item.entry;
      // Join the live per-agent telemetry onto a Task card's sub-report rows so
      // the launch card shows each child's real tokens / duration / model +
      // status + intent (matching the AGENTS rail). Additive and lossless: an
      // agent with no telemetry (or a restored session with none) keeps its
      // static launch row untouched.
      const entry =
        rawEntry.kind === "tool" && rawEntry.metaKind === "task" && rawEntry.subReports?.length
          ? {
              ...rawEntry,
              subReports: rawEntry.subReports.map((sr) => {
                const tel = taskAgentTelemetryByName.get(sr.name);
                return tel ? { ...sr, ...tel } : sr;
              }),
            }
          : rawEntry;
      const expanded = expandedTurns.has(entry.turn);
      const rowDisplay = richMarkdownEntryIds.has(entry.id)
        ? display
        : { ...display, richMarkdown: false };
      const interactive =
        entry.kind === "tool" || entry.kind === "subagent" || entry.kind === "reasoning";
      let reasoningLabel: "shimmer" | "static" | "none" = "static";
      if (entry.kind === "reasoning") {
        const isLiveReasoning = entry.id === liveReasoningId;
        if (reasoningShownForTurn.has(entry.turn) && !isLiveReasoning) {
          reasoningLabel = "none";
        } else {
          reasoningShownForTurn.add(entry.turn);
          reasoningLabel =
            isLiveReasoning && typeof display.shimmerFrame === "number" ? "shimmer" : "static";
        }
      }
      const node = renderEntry(
        entry,
        width,
        expanded ? { ...rowDisplay, transcriptDetail: "expanded" } : rowDisplay,
        theme,
        interactive ? {
          expanded,
          hovered: hoveredTurn === entry.turn,
          onToggle: () => toggleTurnExpanded(entry.turn),
          onHover: (hovered) => setHoveredTurn(hovered ? entry.turn : null),
        } : undefined,
        reasoningLabel,
      );
      // A right-click on an operator/model message pops its actions at the
      // cursor. The wrapper is a layout-neutral column and its handler fires
      // ONLY for a right press (button 2), so left-click / drag-select / the
      // fold-toggle handlers inside `node` are all untouched. Gated on
      // `mouseSupport`, matching every other mouse affordance.
      const isMessage = entry.kind === "user" || entry.kind === "assistant";
      if (settings.mouseSupport && isMessage && (entry.text ?? "").length > 0) {
        return (
          <box
            key={entry.id}
            flexDirection="column"
            flexShrink={0}
            minWidth={0}
            onMouseDown={(event) => {
              if (!isRightClick(event)) return;
              event.stopPropagation?.();
              event.preventDefault?.();
              transcriptMenu.open(event.x, event.y, buildMessageMenuItems(entry));
            }}
          >
            {node}
          </box>
        );
      }
      return node;
    });
  };

  // ── The conversation region ────────────────────────────────────────────────
  // Only the center owns transcript/focus content; its composer and status share
  // the same rectangle. Sidebars and their collapsed rails are root siblings.
  const recoveryPanel = (
    <box flexDirection="column" width="100%" minWidth={0} flexShrink={0} padding={1} backgroundColor={PANEL}>
      <text fg={checkingModel ? MUTED : WARNING}>
        {checkingModel ? "Checking model availability…" : "Connect a provider to start chatting"}
      </text>
      {startupError ? <text fg={MUTED} wrapMode="word">{startupError.text}</text> : null}
      <text fg={MUTED} wrapMode="word">Your draft is kept.</text>
      <box flexDirection="row" flexWrap="wrap" minWidth={0} marginTop={1} gap={1}>
        <box onMouseDown={() => onNavigate("connect")}><text fg={PRIMARY}>[Connect provider]</text></box>
        {session && !checkingModel ? (
          <box onMouseDown={() => { void checkRuntime(); }}><text fg={PRIMARY}>[Check again]</text></box>
        ) : null}
      </box>
      <text fg={MUTED} wrapMode="word">{session ? "ctrl+r retry · ctrl+p commands" : "ctrl+p commands"}</text>
    </box>
  );
  const heroRecoveryNotice = (
    <box flexDirection="column" width={heroComposerWidth} minWidth={0} flexShrink={0} marginTop={1}>
      <Cells width={heroComposerWidth} fg={checkingModel ? MUTED : WARNING}>
        {checkingModel ? "Checking model availability…" : "Provider unavailable"}
      </Cells>
      {startupError ? (
        <>
          <Cells width={heroComposerWidth} fg={MUTED} fit="middle">{startupError.text}</Cells>
          <box flexDirection="row" width={heroComposerWidth} minWidth={0} flexShrink={0} gap={2}>
            <text fg={PRIMARY} onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); onNavigate("connect"); } }}>[/connect]</text>
            {session && !checkingModel ? (
              <text fg={PRIMARY} onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); void checkRuntime(); } }}>[Ctrl+R retry]</text>
            ) : null}
          </box>
        </>
      ) : null}
    </box>
  );

  const conversationRegion = (
    <box key={`chat-${focusAgentId ?? "main"}`}
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      minWidth={0}
      backgroundColor={CANVAS}
      paddingY={1}
    >
      <scrollbox ref={transcriptRef} focusable={false} width="100%" flexGrow={1} minHeight={0} backgroundColor={CANVAS} stickyScroll stickyStart="bottom" verticalScrollbarOptions={sleekScrollbar(theme, CANVAS)}>
        <box flexDirection="column" width="100%" flexShrink={0} onSizeChange={function () {
          // Wrapped Markdown can grow after the scrollbox first measures its
          // child. Repair the current root/worker extent so sticky-bottom follows.
          if (transcriptRef.current) transcriptRef.current.content.height = this.height;
        }}>
          {renderTranscriptEntries(focused ? focusedTranscript : entries, transcriptWidth, focused ? workerDisplay : entryDisplay)}
          {!focused && todos && todos.total > 0 ? (
            <Todos payload={todos} width={transcriptWidth} theme={theme} />
          ) : null}
          {startupError || checkingModel ? recoveryPanel : null}
        </box>
      </scrollbox>
    </box>
  );


  // Keep first-use actions visible without opening a second navigation surface.
  const heroHintPairs: KeyHint[] = [
    { key: "/connect", label: "connect" },
    settings.onboardingCompleted
      ? { key: "/sessions", label: "sessions" }
      : { key: "/onboard", label: "setup" },
    { key: "ctrl+p", label: "commands" },
  ];
  // Any overlay open in the hero (slash menu, picker, an approval, the secret
  // prompt): the masthead is hidden so the tall menu + logo cannot overflow
  // upward into the header. The composer stays put — it is anchored by the
  // fixed bottom spacer regardless of what the region above it holds.
  const heroOverlayOpen = commandMenuVisible || Boolean(picker) || Boolean(approvalPrompt) || Boolean(secretPrompt) || operatorQuestionOpen;
  const showMasthead = !heroOverlayOpen;

  // The command menu now renders through the shared `DialogSelectBody`, which
  // windows the list around the cursor internally (see dialog-select-layout's
  // `dialogWindow`) exactly as every other picker does — so it needs no external
  // scrollbox and no scroll effect of its own.

  // ── ask_operator body scroll ───────────────────────────────────────────────
  // Scroll the active answerable row into view within the fixed-height body.
  useEffect(() => {
    const box = operatorScrollRef.current;
    if (!box || !operatorQuestionOpen || !operatorState) return;
    const activeY = operatorActiveDisplayIndex(operatorRows, operatorState.index);
    box.scrollTop = commandMenuWindowStart(activeY, operatorBodyViewport, operatorRows.length);
  }, [operatorQuestionOpen, operatorState, operatorRows, operatorBodyViewport]);

  // ── Logo intro ticker ──────────────────────────────────────────────────────
  // computeLogoFrame is pure; this only advances the frame counter. A one-shot
  // style stops once it settles (frame >= count-1); a looping style (shimmer)
  // keeps ticking. reduceMotion / "off" never start a ticker — the frame is
  // rendered statically as finalLogoFrame by computeLogoFrame regardless.
  const logoStyle = settings.logoAnimation;
  const logoAnimating =
    interactive && showMasthead && showTerminalMark && !settings.reduceMotion && logoStyle !== "off";
  useEffect(() => {
    if (!logoAnimating) return;
    setLogoFrame(0);
    const count = logoAnimationFrameCount(logoStyle);
    const loops = logoAnimationLoops(logoStyle);
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      if (!loops && frame >= count - 1) {
        setLogoFrame(count - 1);
        clearInterval(timer);
        return;
      }
      setLogoFrame(frame);
    }, LOGO_FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [logoAnimating, logoStyle]);
  // The per-cell frame the masthead paints. computeLogoFrame folds reduceMotion
  // and "off" into the settled final frame internally, so this one call covers
  // both the animated and the static case.
  const logoFrameGrid = computeLogoFrame(TERMINAL_BLOCK_LOGO, logoStyle, logoFrame, {
    reduceMotion: settings.reduceMotion,
  });

  return (
    <box flexDirection="column" width="100%" height="100%" paddingTop={1} backgroundColor={CANVAS}>
      {/*
        * flexShrink is disabled because this box is two stacked rows with
        * no explicit height: when the column is over-subscribed Yoga
        * collapses it to one row and the two lines overlap, which is how
        * "0 / chat" bled into "target: none" as "target:cnone".
        */}
      {/*
        * ONE header row. It carries identity plus the two facts that are
        * security-relevant at a glance — the engagement target and the
        * scope state — and the autonomy mode on the right. Everything
        * environmental (model, cwd, branch, counters) moved to the bottom
        * bar, where it sits next to the input the operator is looking at.
        */}
      <box flexDirection="row" width="100%" minWidth={0} flexShrink={0} marginBottom={1} gap={1} paddingLeft={1} paddingRight={1} backgroundColor={PRIMARY}>
        <box flexDirection="row" flexShrink={0} minWidth={0}>
          <text fg={headerFg}>0</text>
        </box>
        <box width={headerEngagementWidth} flexShrink={0} minWidth={0}>
          <text fg={headerFg}>{fitTuiText(headerEngagement, headerEngagementWidth)}</text>
        </box>
      </box>

      <box flexDirection="row" height={bodyHeight} flexShrink={0} minHeight={0} width="100%" minWidth={0} overflow="hidden">
        <box flexDirection="column" width="100%" height={bodyHeight}
          flexShrink={0} minHeight={0} minWidth={0} overflow="hidden"
          paddingX={compact ? 1 : 2} backgroundColor={CANVAS}>
      {empty ? (
        /*
         * The centered start screen: logo + captions + the COMPOSER + a dim
         * hint line render as ONE vertically-centered group (OpenCode's clean
         * hero). The composer here is the very same `composerNode` used at the
         * bottom in a real conversation — only its placement moves; the input
         * wiring is single-sourced in the module-level keyboard handler. Any
         * open overlay (slash menu, picker, an approval) sits directly above it,
         * exactly where it sits above the pinned composer. The bottom status bar
         * stays pinned below, outside this group.
         */
          <box flexDirection="column" flexGrow={1} minHeight={0} width={heroContentWidth} minWidth={0} alignItems="center">
            <box flexDirection="column" flexGrow={1} minHeight={0} width="100%" minWidth={0} justifyContent="flex-end" alignItems="center">
              {showMasthead ? (
                <box flexDirection="column" width="100%" minWidth={0} flexShrink={0} alignItems="center"
                  onSizeChange={function () { setHeroMastheadRows(this.height); }}>
                <Masthead
                  showTerminalMark={showTerminalMark && heroContentWidth >= TERMINAL_BLOCK_LOGO_WIDTH}
                  showMascot={heroBrandRows >= LEDGER_MARK_ROWS + ZERO_HEIGHT + 1}
                  contentWidth={heroContentWidth}
                  logoFrameGrid={logoFrameGrid}
                  theme={theme}
                />
                {showRepositorySuggestions ? (
                  <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}
                    marginTop={1} alignItems="center" gap={1}>
                    <Cells width={heroContentWidth} align="center" fg={MUTED}>
                      {"Git repository detected · review for security issues?"}
                    </Cells>
                    <box flexDirection="row" width="100%" minWidth={0} flexShrink={0}
                      justifyContent="center" gap={1}>
                      {repoSuggestionItems.map((suggestion, index) => (
                        <DialogActionButton key={suggestion.label} label={suggestion.label}
                          onPress={() => draftRepositorySuggestion(suggestion.prompt)}
                          variant={index === 0 ? "primary" : "secondary"} />
                      ))}
                    </box>
                  </box>
                ) : null}
                </box>
              ) : null}
              {(startupError || checkingModel) && !heroOverlayOpen ? (
                heroRecoveryNotice
              ) : null}
              {heroOverlaysNode}
            </box>
            <box flexDirection="column" width={heroComposerWidth} minWidth={0} flexShrink={0}
              onSizeChange={function () { setHeroComposerRows(this.height); }}>
              {activityRow}
              {heroComposerNode}
            </box>
            <box flexShrink={0} minWidth={0} marginTop={1}>
              {keyHintsLength(heroHintPairs, " · ") <= heroContentWidth ? (
                <KeyHints pairs={heroHintPairs} theme={theme} />
              ) : (
                <text fg={MUTED}>{fitLegend(heroContentWidth, settings.onboardingCompleted ? "/connect · /sessions · [⌃P]" : "/connect · /onboard · [⌃P]")}</text>
              )}
            </box>
            <box height={heroBottomSpacer} flexShrink={0} minWidth={0} />
          </box>
      ) : (
        <>
          <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
            {conversationRegion}
          </box>

          {overlaysNode}
          {stickyNode}
          {activityRow}
          {composerNode}
          {showAgentWorkList ? (
            <box width="100%" minWidth={0} flexShrink={0} marginTop={1}>
              <AgentWorkList agents={projectedHerdAgents} selectedAgentId={focusAgentId}
                width={contentWidth} height={agentWorkRows} theme={theme} runningGlyph={activityGlyph}
                mainTask={mainTask}
                interactive={interactive && !gateOpen && !picker && !transcriptMenu.state.open && !stoppingAuditRef.current}
                onSelect={selectAgentChat} />
            </box>
          ) : null}
        </>
      )}

      {/*
        * The shared bottom row keeps permission mode visible in both hero and
        * conversation layouts. showStatusBar controls the extra environmental
        * telemetry, not the only indicator of the operator's approval mode.
        */}
        <box flexDirection="row" width={controlsWidth} height={1} flexShrink={0} minWidth={0} overflow="hidden">
          {statusPills.length > 0 ? (
            <box flexDirection="row" flexShrink={0} minWidth={0}>
              {statusPills.map((segment, index) => (
                <React.Fragment key={segment.kind}>
                  {index > 0 ? <text fg={MUTED}> · </text> : null}
                  <text fg={statusRoleColor(segment.colorRole, theme, mode)}>{pillText(segment)}</text>
                </React.Fragment>
              ))}
            </box>
          ) : <text fg={MUTED}>{fitTuiText(statusBarText, statusContentWidth)}</text>}
        </box>
      </box>
      </box>
      {/*
        * The copy-on-highlight toast. Positioned absolutely with a high
        * zIndex (see toast.tsx), so it floats over the transcript without
        * participating in — or shifting — the column layout above.
        */}
      {interactive ? <Toast frame={toastFrame} /> : null}
      {interactive && transcriptMenu.state.open ? (
        <ContextMenu
          items={transcriptMenu.state.items}
          x={transcriptMenu.state.x}
          y={transcriptMenu.state.y}
          onClose={transcriptMenu.close}
        />
      ) : null}
    </box>
  );
}
