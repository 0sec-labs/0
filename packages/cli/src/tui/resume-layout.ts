/**
 * Layout, grouping and detail-pane arithmetic for the "resume a saved audit"
 * pop-up dialog.
 *
 * The screen is a dialog body — an icon+title row, the shared grouped and
 * searchable picker with a detail column beside it, a status line and a footer
 * of action hints, inside a panel someone else drew. Every width and row count
 * it renders comes out of `computeResumeDialogLayout` below, measured against
 * the *surface* box (`useSurfaceDimensions`) rather than the terminal, so the
 * same arithmetic serves the dialog and a bare full-screen route.
 *
 * This is `model-layout.ts` / `settings-layout.ts` for the resume screen, and it
 * exists for the same reason spelled out in `PRIMITIVES.md`: OpenTUI lays rows
 * out with Yoga, and Yoga *shrinks* siblings rather than clipping them. Two
 * `<text>` nodes that together want more cells than their row has are both
 * painted in full into boxes now too small, and the terminal shows the two
 * strings interleaved character by character; the same failure on the vertical
 * axis makes a bordered box paint its own border through its last content row.
 * So the component reads widths and row counts off this module and never
 * computes one, and a sweep hammers every number in here across widths and
 * heights.
 *
 * What is domain-specific and lives here:
 *
 *   - the category split, "This project" before "Other projects", so the
 *     operator sees at a glance which stored engagements ran in the directory
 *     they are standing in;
 *   - the list projection (`resumeItems`) — label, compact meta, category and
 *     current-session dot — plus the AND-over-terms filter, scoped to the
 *     `summary` and `preview` because those are the two lines that say what a
 *     session was *about*;
 *   - the detail pane (`resumeDetailLines`): the objective/preview in full,
 *     then a metadata block, as flat tone-tagged lines the component only has
 *     to colour;
 *   - the pending-resume protection marker, which rides on the row label and
 *     on the detail pane so a live audit's history reads as protected before
 *     the delete key is pressed, not only after it refuses.
 *
 * `shellChromeRows` and `wrapCells` are imported from `settings-layout.ts`
 * rather than copied — the honest long-term home for both is a shared
 * `shell-geometry.ts`, and this import is the marker for that move. Nothing here
 * imports React, OpenTUI, or touches I/O.
 */

import { computeDialogPanel, type DialogItem, type DialogPanel } from "./dialog-select-layout.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { relativeAge, type StoredSessionMeta } from "./session-store.js";
import { shellChromeRows, wrapCells } from "./settings-layout.js";
import { sanitizeTuiText } from "./text.js";

export { shellChromeRows, wrapCells };

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------
//
// The dialog's own title glyph and label come from the shared
// `operator-icons.ts` registry, and the label is always rendered beside the
// glyph — there is no icon font behind these code points. The field markers
// below share the plain-text vocabulary used by the other operator screens.

/** A live audit whose history cannot be deleted. */
export const ICON_PROTECTED = "⊘";
export const ICON_SEARCH = "⌕";
export const ICON_CWD = "⌂";
export const ICON_WARN = "!";

// ---------------------------------------------------------------------------
// Numeric hygiene
// ---------------------------------------------------------------------------

/**
 * Cell and row counts are non-negative integers.
 *
 * Terminal geometry arrives from `useTerminalDimensions`, which reports 0 on a
 * detached tty and can report a fractional or `NaN` size mid-resize. Yoga
 * accepts all of those and lays out sub-cell boxes that round inconsistently
 * between siblings, which is itself an overlap.
 */
function cells(value: unknown, fallback = 0): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const truncated = Math.trunc(raw);
  return truncated > 0 ? truncated : 0;
}

// ---------------------------------------------------------------------------
// Category split
// ---------------------------------------------------------------------------

/** Heading for sessions saved in the directory the console is running in. */
export const CATEGORY_THIS = "This project";
/** Heading for sessions saved in any other working directory. */
export const CATEGORY_OTHER = "Other projects";

/**
 * The group heading a session sits under, or `undefined` when the list should
 * not be split at all.
 *
 * The split is only meaningful when the caller knows its own working directory:
 * with no `currentCwd` there is no "here" to contrast against, so every session
 * is uncategorised and the list renders flat (no headings). With a `currentCwd`
 * the sessions that ran there sort under "This project" and the rest under
 * "Other projects", which is the one distinction an operator resuming work
 * actually cares about.
 */
export function sessionCategory(
  session: StoredSessionMeta,
  currentCwd?: string,
): string | undefined {
  if (currentCwd === undefined || currentCwd.length === 0) return undefined;
  return session.cwd === currentCwd ? CATEGORY_THIS : CATEGORY_OTHER;
}

// ---------------------------------------------------------------------------
// List projection
// ---------------------------------------------------------------------------

/**
 * The row label: the objective if the caller recorded one, else the opening
 * prompt, else an explicit placeholder so a session with neither is still a
 * selectable, named row rather than a blank line.
 */
export function sessionLabel(session: StoredSessionMeta): string {
  const summary = sanitizeTuiText(session.summary ?? "");
  if (summary.length > 0) return summary;
  const preview = sanitizeTuiText(session.preview ?? "");
  if (preview.length > 0) return preview;
  return "(no prompt)";
}

/**
 * The compact right-aligned meta: `age · N msgs · model`.
 *
 * A blank age (an unorderable or future `savedAt`, per `relativeAge`) is
 * dropped rather than printed as a dangling separator, and the model is dropped
 * when the session never recorded one. The full, unabbreviated facts live in
 * the detail pane; this line is only the glance.
 */
export function sessionMeta(session: StoredSessionMeta, now: number): string {
  const parts: string[] = [];
  const age = relativeAge(session.savedAt, now);
  if (age.length > 0) parts.push(age);
  const count = cells(session.messageCount);
  parts.push(`${count} msg${count === 1 ? "" : "s"}`);
  const model = sanitizeTuiText(session.model ?? "");
  if (model.length > 0) parts.push(model);
  return parts.join(" · ");
}

export interface ResumeItemsInput {
  /** Sessions to project, newest-first as the caller supplies them. */
  sessions: readonly StoredSessionMeta[];
  /** The session currently on screen, marked with the gutter dot. */
  currentId?: string;
  /** The console's working directory; drives the "This project" split. */
  currentCwd?: string;
  /** Injected clock for `relativeAge`. Never an ambient `Date.now()`. */
  now: number;
  /** AND-over-terms filter, matched against `summary` + `preview` only. */
  filter?: string;
  /**
   * Sessions whose transcript is protected because their audit is still live.
   *
   * They stay in the list and stay resumable — protection is about deletion,
   * not about reach — but their row carries the lock marker so the operator
   * can see the state before pressing a destructive key, not only after the
   * screen refuses. The screen enforces the refusal itself; this flag only
   * makes the same fact visible.
   */
  protectedSessionIds?: ReadonlySet<string>;
}

/**
 * Projects sessions onto `DialogItem`s, filtered and grouped.
 *
 * The filter is AND-over-terms across the objective and the opening prompt —
 * the two fields that say what a session was for — so typing a target host or a
 * bug class reaches the right engagement without matching an incidental model
 * id or timestamp. Surviving sessions keep their newest-first order within each
 * category, and "This project" is emitted before "Other projects" so
 * `buildDialogRows` draws that heading first.
 */
export function resumeItems({
  sessions,
  currentId,
  currentCwd,
  now,
  filter = "",
  protectedSessionIds,
}: ResumeItemsInput): DialogItem[] {
  const terms = sanitizeTuiText(filter).toLowerCase().split(" ").filter(Boolean);
  const matched = sessions.filter((session) => {
    if (terms.length === 0) return true;
    const haystack = `${session.summary ?? ""} ${session.preview ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  // Partition stably so "This project" leads. With no `currentCwd` every
  // category is undefined and the input order is preserved untouched.
  const here: StoredSessionMeta[] = [];
  const elsewhere: StoredSessionMeta[] = [];
  for (const session of matched) {
    if (sessionCategory(session, currentCwd) === CATEGORY_THIS) here.push(session);
    else elsewhere.push(session);
  }
  const ordered = currentCwd ? [...here, ...elsewhere] : matched;

  return ordered.map((session) => {
    // The lock leads the label rather than riding in the meta column: the meta
    // is right-aligned and capped at a share of the row, so on a narrow list
    // it is the first thing to be truncated, and a protection marker that
    // disappears when the panel narrows is worse than none at all.
    const locked = protectedSessionIds?.has(session.id) === true;
    return {
      id: session.id,
      label: locked ? `${ICON_PROTECTED} ${sessionLabel(session)}` : sessionLabel(session),
      meta: sessionMeta(session, now),
      category: sessionCategory(session, currentCwd),
      current: currentId !== undefined && session.id === currentId,
    };
  });
}

// ---------------------------------------------------------------------------
// Absolute timestamp
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The absolute save time as `YYYY-MM-DD HH:MM UTC`, or "" for an unorderable
 * timestamp.
 *
 * UTC on purpose: the whole store is deterministic (its ordering and its
 * `relativeAge` take an injected clock), and a local-time render would make the
 * detail pane depend on the machine's timezone, which no test could pin. The
 * relative age beside it in the pane carries the "how long ago" the operator
 * reads at a glance; this is the stable anchor.
 */
export function formatSavedAt(savedAt: number): string {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return "";
  const date = new Date(savedAt);
  const day = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  const time = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  return `${day} ${time} UTC`;
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

export type ResumeDetailTone = "title" | "text" | "muted" | "accent" | "blank";

export interface ResumeDetailLine {
  readonly text: string;
  readonly tone: ResumeDetailTone;
}

export interface ResumeDetailInput {
  session?: StoredSessionMeta;
  /** Injected clock for the relative-age line. */
  now: number;
  /** Omit the blank separator rows. Set when the pane is short of rows. */
  compact?: boolean;
  /**
   * Whether this session's history is protected because its audit is live.
   *
   * Stated only when the caller passed the protected set — the pane never
   * infers protection from the record, because a stored session file says
   * nothing about whether its audit is still running.
   */
  isProtected?: boolean;
}

/**
 * The detail pane's body, as flat tone-tagged lines: the objective/preview in
 * full, then a metadata block.
 *
 * Content is decided here and colour is decided by the component, so the pane
 * can be asserted on without a renderer. Every value is wrapped to `width` by
 * `wrapCells`, so no line can overhang the pane; optional fields (target, mode,
 * model) are simply absent when the session never recorded them rather than
 * printed as "none". `": "` separators, never alignment columns:
 * `sanitizeTuiText` collapses whitespace, so a padded literal would be trimmed
 * away and the label would fuse to its value.
 */
export function resumeDetailLines(
  { session, now, compact = false, isProtected = false }: ResumeDetailInput,
  width: number,
): ResumeDetailLine[] {
  const limit = cells(width);
  if (!session || limit <= 0) return [];

  const lines: ResumeDetailLine[] = [];
  const push = (value: string, tone: ResumeDetailTone) => {
    for (const text of wrapCells(value, limit)) lines.push({ text, tone });
  };
  const separate = () => {
    if (!compact) lines.push({ text: "", tone: "blank" });
  };

  // What the session was about / did. When the objective and the opening
  // prompt differ, show both — the objective as the headline, the prompt as the
  // muted "how it opened" beneath — since together they are the "what's what"
  // the operator opened this screen to read.
  const summary = sanitizeTuiText(session.summary ?? "");
  const preview = sanitizeTuiText(session.preview ?? "");
  if (summary.length > 0) {
    push(summary, "text");
    if (preview.length > 0 && preview !== summary) {
      separate();
      push(`Opened with: ${preview}`, "muted");
    }
  } else if (preview.length > 0) {
    push(preview, "text");
  } else {
    push("(no prompt recorded)", "muted");
  }

  // The protection notice leads the metadata rather than trailing it. A short
  // pane clips from the bottom, and "this history cannot be deleted" is the
  // one line that must survive the cut — an operator who never sees it reads
  // the refusal as a bug. It states the rule the screen enforces and nothing
  // more: the audit has to close on its own before the history can be removed,
  // and this screen has no power to close it.
  if (isProtected) {
    separate();
    push(
      `${ICON_PROTECTED} Protected: this audit is still live. Its history cannot be deleted until the audit closes. Opening it is unaffected.`,
      "accent",
    );
  }

  separate();

  const count = cells(session.messageCount);
  push(`Messages: ${count}`, "muted");
  const model = sanitizeTuiText(session.model ?? "");
  if (model.length > 0) push(`Model: ${model}`, "muted");
  const mode = sanitizeTuiText(session.mode ?? "");
  if (mode.length > 0) push(`Mode: ${mode}`, "muted");
  const target = sanitizeTuiText(session.target ?? "");
  if (target.length > 0) push(`Target: ${target}`, "muted");
  const cwd = sanitizeTuiText(session.cwd ?? "");
  if (cwd.length > 0) push(`Cwd: ${cwd}`, "muted");

  const absolute = formatSavedAt(session.savedAt);
  const age = relativeAge(session.savedAt, now);
  if (absolute.length > 0 && age.length > 0) push(`Saved: ${absolute} (${age} ago)`, "muted");
  else if (absolute.length > 0) push(`Saved: ${absolute}`, "muted");
  else if (age.length > 0) push(`Saved: ${age} ago`, "muted");

  return lines;
}

/**
 * Trims detail lines to the rows the pane actually has, marking the cut.
 *
 * Rendering more rows than the box holds is what pushes a border through the
 * content, so the overflow has to be cut — but it is marked rather than cut
 * silently. Given a width, the marker is appended to the last surviving line
 * instead of taking a row of its own, because on the terminals where clipping
 * happens the pane has only a few rows and a lone `...` throws away real text to
 * say text was thrown away. Mirrors `clipModelDetailLines`; kept local because
 * this module's tone union is its own.
 */
export function clipResumeDetailLines(
  lines: readonly ResumeDetailLine[],
  rows: number,
  width = 0,
): ResumeDetailLine[] {
  const limit = cells(rows);
  if (limit <= 0) return [];
  if (lines.length <= limit) return [...lines];

  const kept = lines.slice(0, limit);
  const last = kept[limit - 1];
  const room = cells(width);
  if (room >= 8 && last && last.text.length > 0) {
    const head = last.text.slice(0, Math.max(0, room - 4)).trimEnd();
    kept[limit - 1] = { text: `${head} ...`, tone: last.tone };
  } else {
    kept[limit - 1] = { text: "...", tone: "muted" };
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Dialog geometry
// ---------------------------------------------------------------------------

export interface ResumeDialogLayoutInput {
  /** The surface's inner width — the dialog panel's box, or the terminal. */
  width: number;
  /** The surface's inner height. */
  height: number;
  /** Display rows (category headings interleaved) the list would render. */
  totalRows: number;
  /** True when the screen is mounted inside a `DialogSurface` panel. */
  inDialog?: boolean;
  /** Whether the confirm/error line is currently showing. */
  hasStatus?: boolean;
}

export interface ResumeDialogLayout {
  /** Cells every row of the body may occupy. */
  contentWidth: number;
  /** 1 when there is room for the icon+title row, else 0. */
  titleRows: number;
  /** 1 when the confirm/error line is showing and there is room for it. */
  statusRows: number;
  /** 1 when there is room for the footer hint row, else 0. */
  footerRows: number;
  /** Rows the picker body (search line + list + detail) may occupy. */
  bodyRows: number;
  /** Rows of stacked detail below the list when the pane could not sit beside it. */
  stackedRows: number;
  /** Geometry for `DialogSelectBody`, in inline `bodyRows` mode. */
  panel: DialogPanel;
}

/** A picker body narrower than this cannot host a stacked detail block. */
const STACKED_MIN_WIDTH = 24;
/** Rows the list keeps for itself before a stacked detail block is affordable. */
const STACKED_MIN_LIST_ROWS = 6;
/** A stacked detail block never grows past this. */
const STACKED_MAX_ROWS = 8;

/**
 * Every width and row count the resume dialog renders, from the surface box.
 *
 * Unlike `/model`, this screen draws its own footer — the route hands it no
 * `frame` — so inside a dialog panel the whole inner box is its own and there
 * is no host chrome to reserve. Rows go to the picker first and to the title
 * last, so a very short surface degrades to "just the list" rather than to
 * "chrome with no list", and the parts sum to at most the rows available,
 * which is what keeps the body from painting through the panel border
 * (PRIMITIVES.md: Yoga shrinks siblings rather than clipping them).
 */
export function computeResumeDialogLayout({
  width,
  height,
  totalRows,
  inDialog = false,
  hasStatus = false,
}: ResumeDialogLayoutInput): ResumeDialogLayout {
  const surfaceWidth = cells(width);
  const surfaceHeight = cells(height);
  // Inside a dialog the panel already paid for its border and padding; on a
  // bare terminal the shell's own horizontal padding still has to come off.
  const contentWidth = Math.max(0, surfaceWidth - (inDialog ? 0 : 4));
  const available = Math.max(0, surfaceHeight - (inDialog ? 0 : shellChromeRows(surfaceWidth)));

  const footerRows = available >= 3 ? 1 : 0;
  const statusRows = hasStatus && available >= 4 ? 1 : 0;
  const titleRows = available >= 6 ? 1 : 0;
  const bodyRows = Math.max(0, available - footerRows - statusRows - titleRows);

  const panelFor = (rows: number): DialogPanel =>
    computeDialogPanel({
      width: contentWidth,
      height: surfaceHeight,
      size: "large",
      totalRows,
      withDetail: true,
      bodyRows: rows,
    });

  let panel = panelFor(bodyRows);
  let stackedRows = 0;
  if (
    !panel.showDetail &&
    contentWidth >= STACKED_MIN_WIDTH &&
    bodyRows >= STACKED_MIN_LIST_ROWS + 3
  ) {
    stackedRows = Math.min(STACKED_MAX_ROWS, bodyRows - STACKED_MIN_LIST_ROWS);
    panel = panelFor(bodyRows - stackedRows);
  }

  return { contentWidth, titleRows, statusRows, footerRows, bodyRows, stackedRows, panel };
}

// ---------------------------------------------------------------------------
// Title and counter
// ---------------------------------------------------------------------------

/**
 * The dialog's title row: the shared glyph, the shared label, then the scope
 * the list is currently showing.
 *
 * The glyph and label come from `operator-icons.ts` so this dialog is stamped
 * exactly like every other one, and the label is always beside the glyph.
 * "This project" is named only when the screen actually knows its working
 * directory — with no `currentCwd` the list is not split, and claiming a scope
 * it did not apply would be a lie about what is on screen.
 */
export function resumeDialogTitle(scope: "project" | "all", scoped: boolean): string {
  const head = `${operatorIcon("resume")} ${operatorTitle("resume")}`;
  if (!scoped) return head;
  return `${head} · ${scope === "project" ? "this project" : "all projects"}`;
}

/** The right-aligned counter beside the title: rows actually on screen. */
export function resumeDialogCount(matched: number, protectedCount = 0): string {
  const count = cells(matched);
  const locked = cells(protectedCount);
  const head = `${count} audit${count === 1 ? "" : "s"}`;
  return locked > 0 ? `${head} · ${ICON_PROTECTED} ${locked} live` : head;
}

// ---------------------------------------------------------------------------
// Hints and keys
// ---------------------------------------------------------------------------

export type ResumeMode = "browse" | "filter" | "confirm-delete";

/**
 * The footer hint, per mode.
 *
 * `d` is named as the delete key in browse mode and, once armed, the confirm
 * key — a second press is what actually deletes, so the destructive action is
 * never one tap. Esc unwinds one step at a time, which the hint reflects: it
 * cancels an armed delete, then clears a filter, then leaves.
 */
export function resumeFooterHint(
  mode: ResumeMode,
  hasFilter = false,
  hasSessions = true,
  scope: "project" | "all" = "project",
  sessionCount?: number,
  /**
   * Whether the highlighted row is protected. The delete key is then named as
   * what it will actually do — refuse — rather than as an action that works.
   * The screen still enforces the refusal; this only stops the footer from
   * advertising a deletion that cannot happen.
   */
  highlightProtected = false,
): string {
  const count = sessionCount !== undefined ? `${sessionCount} audit${sessionCount === 1 ? "" : "s"}` : undefined;

  switch (mode) {
    case "filter":
      return "type to filter · enter open · esc cancel · backspace delete a character";
    case "confirm-delete":
      return "del confirm delete · esc cancel";
    default:
      return [
        "↑↓",
        hasSessions ? "enter open" : undefined,
        highlightProtected ? `${ICON_PROTECTED} del protected` : "del delete",
        "/ filter",
        `tab ${scope === "project" ? "all" : "project"}`,
        count,
        hasFilter ? "esc clear" : "esc back",
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · ");
  }
}

/**
 * Every printable character can start a filter — except the keys browse mode
 * reserves, which the caller checks first (`d` for delete). This only decides
 * "is this a character that types", exactly as the model and settings screens'
 * own `isFilterKey` does; kept local so this module has no cross-screen import.
 */
export function isFilterKey(sequence: unknown): boolean {
  if (typeof sequence !== "string" || sequence.length !== 1) return false;
  const code = sequence.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}
