import type { TodoStatus } from "@0sec/core";
import type { PanelData } from "../panels.js";
import type { ToolPreview, ToolPreviewImage } from "../tool-format.js";
import type {
  RoleLabelStyle,
  ToolCardStyle,
  TranscriptDetail,
  TranscriptStyle,
} from "../transcript-style.js";

/**
 * An inline image as the transcript holds it.
 *
 * This is exactly {@link ToolPreviewImage} — the projection produced by
 * `projectToolPreview` from the tool result's own bytes — plus an optional note
 * of which tool produced it. Nothing is added by the view layer: the pixel
 * dimensions, media type and byte size all originate in the payload, and are
 * absent when the payload did not carry them.
 */
export type ChatImageAttachment = ToolPreviewImage & {
  /** Name of the tool whose result carried this image, when it is known. */
  origin?: string;
};

export type ChatEntry = {
  id: string;
  /**
   * The transcript speaks in distinct voices, because a slash-command
   * listing is not conversation and reasoning is not an answer. Rendering
   * them all as the same muted bullet is what made command output read as
   * an undifferentiated dump.
   */
  kind: "user" | "assistant" | "reasoning" | "tool" | "subagent" | "notice" | "panel" | "error" | "peer";
  text: string;
  /**
   * Inter-agent (IRC) message endpoints — display names, present only on a
   * `peer` entry. The renderer colours each by its stable agent accent; `peerTo`
   * === "all" is a broadcast (rendered `#all`).
   */
  peerFrom?: string;
  peerTo?: string;
  detail?: string;
  success?: boolean;
  turn: number;
  subagentOutcome?: "completed" | "failed";
  subagentTurns?: number;
  subagentFindings?: number;
  subagentSummary?: string;
  subagentError?: string;
  panel?: PanelData;
  /**
   * A concise, human one-liner of the call's arguments (from `formatToolArgs`),
   * so a compact tool card can read `run_command · npm test · ok` instead of
   * just the bare tool name.
   */
  toolArgs?: string;
  /** Bounded and redacted actual output, projected before transcript insertion. */
  toolPreview?: ToolPreview;
  /**
   * Inline images this entry carried, in the order the result presented them.
   *
   * Deliberately a FIELD rather than a new `kind`: `ChatEntry` is handed
   * straight to shared's `createTranscriptDocument`, whose kind union this
   * package does not own, so widening the union here would break that call.
   * A `tool` entry renders these beneath its card (the usual case, since
   * `projectToolPreview` also surfaces them on `toolPreview.images`), and any
   * other entry renders them as standalone image cards.
   *
   * Every field inside is optional and present only when the result actually
   * supplied it — the card omits any element it has no datum for.
   */
  images?: readonly ChatImageAttachment[];
  /** Epoch ms the entry was appended, for relative timestamps. */
  at?: number;
  /**
   * Wall-clock duration of the turn this assistant answer belongs to, stamped
   * when the turn ends. Rendered as the elapsed in the AI turn's footer.
   */
  durationMs?: number;
  /**
   * Per-turn model usage, stamped onto the turn's assistant answer(s) when the
   * turn settles. Drives the optional in→out token and cost segments on the AI
   * footer (gated by `showTokenUsage` / `showCost`).
   */
  usageInput?: number;
  usageOutput?: number;
  /**
   * How many consecutive identical entries this row stands for; see
   * `appendTranscriptEntry`. Rendered as a trailing "(xN)".
   */
  repeat?: number;
  /**
   * Rich tool-card fields, mirroring `ToolResult.meta` (core). Populated for a
   * bash / run_command / apply_patch tool entry so both a LIVE turn and a
   * RESTORED/serialized turn can render a bordered card. All optional: a tool
   * entry without them renders as the existing rail/compact line.
   *
   * `metaKind` selects the card: "command" (a `$ cmd` + output + wall/exit
   * footer), "edit" (a `✎ Edit: path (+A/-R)` header + diff), "web" (a
   * `⌕ Web Search` header + query + answer + sources list), "task" (a
   * subagent-launch card: Goal/Constraints/Contract sections + sub-report
   * bullets + the phase/checkbox TODO tree), or "image" (an inline screenshot
   * — the browser tool: the actual bytes ride on {@link images}, so the card
   * renders it via `ImageCard` beneath the usual tool header).
   */
  metaKind?: "command" | "edit" | "web" | "task" | "image";
  // ── command card ──
  /** The command that was run (header `$ <command>`). */
  command?: string;
  /** The command's combined stdout/stderr, for the card body. */
  commandOutput?: string;
  /** Process exit code; `null`/undefined when unknown (timed out / signal). */
  exitCode?: number | null;
  /** Wall-clock duration of the call, in milliseconds. */
  wallMs?: number;
  /** The timeout ceiling that was applied, in milliseconds. */
  timeoutMs?: number;
  /** True when the call was killed by the wallclock timeout. */
  timedOut?: boolean;
  // ── edit card ──
  /** Path(s) edited (header `✎ Edit: <path>`). */
  editPath?: string;
  /** Lines added by the edit. */
  editAdded?: number;
  /** Lines removed by the edit. */
  editRemoved?: number;
  /** A diff body (hunk lines) for the edit card, when available. */
  editDiff?: string;
  // ── web card ──
  /** Search provider name (header `⌕ Web Search: <provider>`). */
  webProvider?: string;
  /** The search query that was run. */
  webQuery?: string;
  /** A short answer/summary, when the provider returns one. */
  webAnswer?: string;
  /** The result sources: title (optional), url, and an optional relative age. */
  webSources?: Array<{ title?: string; url: string; age?: string }>;
  // ── task card (subagent launch: spawn_agents) ──
  /** Card title suffix (`Task • <label>`) — e.g. the batch agent count. */
  taskLabel?: string;
  /**
   * Batch shared-context Markdown (the model-authored `# Goal / # Constraints /
   * # Contract`). The card splits it on those H1 headings into sections.
   */
  taskContext?: string;
  /** Pre-split `# Goal` section (core `goal`), when a producer parsed it out. */
  taskGoal?: string;
  /** Pre-split `# Constraints` section (core `constraints`). */
  taskConstraints?: string;
  /** Pre-split `# Contract` section (core `contract`). */
  taskContract?: string;
  /** Per-agent assignment brief Markdown (single-agent, core `assignment`). */
  taskAssignment?: string;
  /** The dispatched sub-report bullets (one row each). */
  subReports?: Array<{ name: string; agent?: string; brief?: string; isolated?: boolean }>;
  /** Phase/checkbox plan snapshot, fed straight into `buildTodoTreeRows`. */
  taskTodos?: Array<{ id: string; content: string; status: TodoStatus; group?: string }>;
};

export interface EntryDisplay {
  /** "comfortable" separates entries with a blank line; "compact" does not. */
  spacing: number;
  showTimestamps: boolean;
  now: number;
  /** Framing of a speaking turn (bubble / rail / plain / compact / document). */
  transcriptStyle: TranscriptStyle;
  /** How the "who said this" label is drawn (full / short / glyph / off). */
  roleLabelStyle: RoleLabelStyle;
  /** How a tool / subagent call is drawn (rail / inline / compact / hidden). */
  toolCardStyle: ToolCardStyle;
  /**
   * Draw bash / run_command / apply_patch results as rich bordered cards (a
   * `$ cmd` + output + wall/exit footer, or a `✎ Edit` header + diff) instead
   * of the plain rail/compact line. Optional and defaults to ON when undefined,
   * so a caller that does not set it still gets the cards. `toolCardStyle:
   * "hidden"` still hides a SUCCESSFUL card (a failure always shows).
   */
  richToolCards?: boolean;
  /** Current autonomy mode label, for the AI turn footer ("Standard · …"). */
  mode: string;
  /**
   * The autonomy mode's colour (from `modeColorFor`), so the AI turn footer can
   * paint the mode name in the SAME colour as the header and the status bar
   * instead of a flat muted grey.
   */
  modeColor: string;
  /** Resolved model id, for the AI turn footer ("… · gpt-…"). */
  model: string;
  /** Show the model name on the AI footer (settings.modelDisplay === "message"). */
  modelInFooter: boolean;
  /** Show the per-turn "in→out tok" segment on the AI footer. */
  showTokenUsage: boolean;
  /** Show the estimated per-turn dollar cost on the AI footer. */
  showCost: boolean;
  /** How the transcript folds turn detail; drives the fold planner. */
  transcriptDetail: TranscriptDetail;
  /**
   * The shared shimmer frame for RUNNING rows (tool / subagent still in flight),
   * driven by chat-screen's `SHIMMER_TEXT_INTERVAL_MS` ticker. A number means
   * "shimmer running rows this frame"; `undefined` means render them static
   * (settled, failed, or reduceMotion) — the pre-shimmer behaviour, so existing
   * callers are unaffected.
   */
  shimmerFrame?: number;
  /**
   * The turn number that is CURRENTLY in flight, or `undefined` when the console
   * is idle. Rows that have no per-entry "settled" marker of their own — a
   * reasoning ("thinking") row and a collapsed FOLD — use this to tell whether
   * they belong to the working turn: a reasoning row or a fold whose turn equals
   * `activeTurn` shimmers (in phase with `shimmerFrame`), while every past turn's
   * reasoning/fold stays static. Tool and subagent rows do NOT need this: they
   * carry their own running state (`success`/`subagentOutcome` undefined). Paired
   * with `shimmerFrame`: shimmer only when BOTH `activeTurn` matches and
   * `shimmerFrame` is a number, so reduceMotion / settled turns stay static.
   */
  activeTurn?: number;
  /**
   * Id of the transcript's LAST (tail) entry while a turn is in flight, else
   * `undefined`. A reasoning row shimmers only when it is this live tail — so a
   * working turn shows ONE shimmering "thinking", not every past thinking block
   * in the turn lighting up at once. (Folds still key on `activeTurn`; they only
   * appear collapsed and there is at most one for the active turn.)
   */
  activeEntryId?: string;
}

export interface KeyHint {
  key: string;
  label: string;
}
