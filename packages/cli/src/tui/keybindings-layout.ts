/**
 * Layout geometry and row model for the full-screen keyboard-shortcuts
 * reference (`shortcuts-screen.tsx`).
 *
 * This is `usage-layout.ts` for `/shortcuts`, and it exists for the same reason
 * spelled out there and in `PRIMITIVES.md`: OpenTUI lays rows out with Yoga,
 * and Yoga *shrinks* siblings rather than clipping them. Two `<text>` nodes that
 * together want more cells than their row has are painted on top of each other,
 * and a bordered box asked to hold one row more than its column has paints its
 * own bottom border through its last line of content. So the component reads
 * every width, height, row count and column split off a `ShortcutsLayout` and
 * never computes one; a sweep hammers every number here across widths 0..200 and
 * heights 0..80.
 *
 * The content is derived entirely from `keybindings.ts` — the shared registry —
 * so a binding added there appears here (and on screen) with no change to this
 * file. `shellChromeRows` is reused from `settings-layout.ts` (the corrected
 * mirror of `run.tsx`'s shell-chrome height), exactly as `usage-layout.ts` does.
 */

import {
  KEYBINDINGS,
  keybindingsByCategory,
  effectiveChords,
  parseChord,
  type Keybinding,
  type KeybindingCategory,
} from "./keybindings.js";
import type { DialogItem } from "./dialog-select-layout.js";
import { shellChromeRows } from "./settings-layout.js";
import { SLASH_COMMANDS, type SlashCommand } from "./slash-commands.js";
import { sanitizeTuiText, wrapText } from "./text.js";

export { shellChromeRows };

// ---------------------------------------------------------------------------
// Numeric hygiene (mirrors usage-layout.ts)
// ---------------------------------------------------------------------------

/**
 * Cell and row counts are non-negative integers. Terminal geometry arrives from
 * `useTerminalDimensions`, which reports 0 on a detached tty and can report a
 * fractional or `NaN` size mid-resize; everything entering the allocator is
 * normalised here first.
 */
function cells(value: unknown, fallback = 0): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const truncated = Math.trunc(raw);
  return truncated > 0 ? truncated : 0;
}

// ---------------------------------------------------------------------------
// Row model — tone-tagged rows, decided here so the component draws no logic
// ---------------------------------------------------------------------------

export type ShortcutsTone = "heading" | "keys" | "description" | "blank";

export type ShortcutsRowKind = "heading" | "binding" | "blank";

export interface ShortcutsRow {
  kind: ShortcutsRowKind;
  /** The whole line for `heading`, unused for `binding`/`blank`. */
  label?: string;
  /** The chord column for `binding`. */
  keys?: string;
  /** The description column for `binding`. */
  description?: string;
  tone?: ShortcutsTone;
}

/**
 * The whole reference as flat rows: one heading per category, one row per
 * binding, and a blank between groups. Built from the shared registry via
 * `keybindingsByCategory`, so the order and grouping match the source of truth
 * and nothing is hand-listed here.
 */
export function buildShortcutsRows(
  bindings: readonly Keybinding[] = KEYBINDINGS,
): ShortcutsRow[] {
  const rows: ShortcutsRow[] = [];
  const grouped = keybindingsByCategory(bindings);
  let first = true;
  for (const [category, entries] of grouped) {
    if (!first) rows.push({ kind: "blank", tone: "blank" });
    first = false;
    rows.push({ kind: "heading", label: category.toUpperCase(), tone: "heading" });
    for (const binding of entries) {
      rows.push({
        kind: "binding",
        keys: sanitizeTuiText(binding.keys),
        description: sanitizeTuiText(binding.description),
        tone: "description",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** The keys column never grows past this, however long a chord label is. */
const KEYS_MAX_WIDTH = 22;
/** The description keeps at least this many cells before the keys column may grow. */
const DESCRIPTION_MIN_WIDTH = 12;
/** Below this a binding row cannot afford two columns and shows keys alone. */
const COLUMNS_MIN_ROOM = 16;

export interface ShortcutsColumns {
  /** Total cells a binding row occupies; equals the pane's inner width. */
  width: number;
  /** The chord column, sized to the widest chord (capped). */
  keysWidth: number;
  gap: number;
  /** The description column. 0 when the row can only afford the keys. */
  descriptionWidth: number;
}

/** The widest chord label across the rendered bindings, for column alignment. */
export function widestKeys(rows: readonly ShortcutsRow[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.kind === "binding" && typeof row.keys === "string") {
      max = Math.max(max, row.keys.length);
    }
  }
  return max;
}

/**
 * Splits a binding row into a left keys column and a right description column.
 *
 * The keys column is sized to the widest chord (so the chords align down the
 * page) but capped at `KEYS_MAX_WIDTH` and never allowed to starve the
 * description below `DESCRIPTION_MIN_WIDTH`. Below `COLUMNS_MIN_ROOM` the row
 * keeps the keys and drops the description column — a truncated chord beside a
 * truncated sentence helps no one. The two columns plus the gap always sum to
 * exactly `innerWidth`, so a row can never overflow or fuse under pressure.
 */
export function computeShortcutsColumns(
  innerWidth: number,
  maxKeysLength: number,
): ShortcutsColumns {
  const width = cells(innerWidth);
  if (width <= 0) return { width: 0, keysWidth: 0, gap: 0, descriptionWidth: 0 };
  if (width < COLUMNS_MIN_ROOM) return { width, keysWidth: width, gap: 0, descriptionWidth: 0 };

  const wanted = cells(maxKeysLength);
  // The keys column may take what the widest chord needs, but never more than
  // the cap, and never so much that the description falls below its floor.
  const keysWidth = Math.max(
    1,
    Math.min(wanted, KEYS_MAX_WIDTH, width - DESCRIPTION_MIN_WIDTH - 1),
  );
  const gap = 1;
  const descriptionWidth = Math.max(0, width - keysWidth - gap);
  return { width, keysWidth, gap, descriptionWidth };
}

// ---------------------------------------------------------------------------
// Geometry (mirrors usage-layout.ts)
// ---------------------------------------------------------------------------

/** Below this the pane drops its border rather than a row of content. */
const BORDERED_MIN_ROWS = 10;
/** A pane narrower than this cannot afford a border and its padding. */
const BORDERED_MIN_WIDTH = 24;

export interface ShortcutsPane {
  /** Outer cells, borders included. 0 when the pane is not rendered. */
  width: number;
  /** Cells available to text inside the pane. */
  innerWidth: number;
  /** Outer rows, borders included. 0 when the pane is not rendered. */
  height: number;
  /** Rows available to content, below the title row. */
  bodyRows: number;
  /** The pane spends a row on a title. */
  hasTitle: boolean;
}

export interface ShortcutsLayoutInput {
  width: number;
  height: number;
  /**
   * Rows the HOST frame spends around this screen's body, when the host is not
   * the legacy full-screen shell. Inside a `DialogSurface` the shell renders
   * with `dialogContent`: no outer header and no padding, and the surface
   * dimensions are the panel interior, so the only row the host still spends is
   * its one-row footer. Omit it and the legacy `shellChromeRows(width)` applies.
   */
  hostRows?: number;
  /**
   * Cells the HOST frame pads on EACH side. The legacy shell pads two; a dialog
   * pads none. Omit it and the legacy padding applies.
   */
  hostPaddingX?: number;
}

export interface ShortcutsLayout {
  /** The pane draws a border. False on a short terminal, where rows cost more. */
  bordered: boolean;
  /** Usable cells across, inside the shell's padding. */
  contentWidth: number;
  /** Rows the reference body may share, after the shell has taken its chrome. */
  bodyRows: number;
  pane: ShortcutsPane;
  columns: ShortcutsColumns;
  /** Reference rows that fit in the pane's body. */
  visibleRows: number;
}

function makePane(width: number, height: number, chromeH: number, chromeV: number): ShortcutsPane {
  const outerWidth = cells(width);
  const outerHeight = cells(height);
  const verticalChrome = chromeV + 1; // always a title row
  if (outerWidth <= chromeH || outerHeight <= verticalChrome) {
    return { width: 0, innerWidth: 0, height: 0, bodyRows: 0, hasTitle: true };
  }
  return {
    width: outerWidth,
    innerWidth: outerWidth - chromeH,
    height: outerHeight,
    bodyRows: outerHeight - verticalChrome,
    hasTitle: true,
  };
}

/**
 * The full geometry of the shortcuts screen.
 *
 * One pane fills the content column. It gives up its border before it gives up
 * rows of content, and is dropped entirely rather than rendered at a height that
 * would push its own border through its text. The keys column is sized from the
 * widest chord the caller passes so the chords align down the page.
 */
export function computeShortcutsLayout(
  { width, height, hostRows, hostPaddingX }: ShortcutsLayoutInput,
  maxKeysLength = 0,
): ShortcutsLayout {
  const terminalWidth = cells(width);
  // The legacy shell pads two cells either side and spends a header; a dialog
  // host pads none and spends only its footer row.
  const padding = hostPaddingX === undefined ? 2 : cells(hostPaddingX);
  const chromeRows = hostRows === undefined ? shellChromeRows(terminalWidth) : cells(hostRows);
  const contentWidth = Math.max(0, terminalWidth - padding * 2);
  const bodyRows = Math.max(0, cells(height) - chromeRows);

  const bordered = bodyRows >= BORDERED_MIN_ROWS && contentWidth >= BORDERED_MIN_WIDTH;
  const chromeH = bordered ? 4 : 0;
  const chromeV = bordered ? 2 : 0;
  const pane = makePane(contentWidth, bodyRows, chromeH, chromeV);

  return {
    bordered,
    contentWidth,
    bodyRows,
    pane,
    columns: computeShortcutsColumns(pane.innerWidth, maxKeysLength),
    visibleRows: pane.bodyRows,
  };
}

// ---------------------------------------------------------------------------
// Clipping, titles and hints (mirrors usage-layout.ts)
// ---------------------------------------------------------------------------

/**
 * Trims reference rows to the rows the pane actually has, marking the cut.
 *
 * Rendering more rows than the box holds is what pushes a border through the
 * content, so the overflow is cut — but the last surviving row is replaced with
 * a marker rather than dropped silently, because a reference that stops
 * mid-section with no sign it was truncated reads as a crash.
 */
export function clipShortcutsRows(rows: readonly ShortcutsRow[], visible: number): ShortcutsRow[] {
  const limit = cells(visible);
  if (limit <= 0) return [];
  if (rows.length <= limit) return [...rows];
  const kept = rows.slice(0, limit);
  const hidden = rows.length - limit + 1;
  kept[limit - 1] = { kind: "heading", label: `… ${hidden} more`, tone: "blank" };
  return kept;
}

/** The pane title. */
export function shortcutsTitle(): string {
  return "KEYBOARD SHORTCUTS";
}

/** The footer hint: a read-only palette — search, move, leave. */
export function shortcutsFooterHint(): string {
  return ["type to search", "↑/↓ move", "ctrl+u clear", "esc back", "ctrl+c exit"].join(" · ");
}

// ===========================================================================
// COMMAND PALETTE — the searchable, grouped projection of the two registries
// ===========================================================================
//
// `/shortcuts` is the route form of the console's help palette. It lists two
// kinds of thing, and INVENTS NEITHER:
//
//   1. every chord in `keybindings.ts`, which is itself a hand-verified mirror
//      of the real `useKeyboard` guards in `chat-screen.tsx`; and
//   2. every slash command registered in `slash-commands.ts`.
//
// No aspirational binding, no "coming soon" row, no chord that is not in the
// registry. A command's alias list, usage string and TUI-only flag are shown
// only when the registry actually carries them. The palette is a REFERENCE: it
// runs nothing, so it never implies Enter will.

/** Title-case a slash-command category for a group heading. */
function commandCategoryLabel(category: string): string {
  const text = sanitizeTuiText(category);
  return text.length === 0 ? "Commands" : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

export interface PaletteInput {
  bindings?: readonly Keybinding[];
  commands?: readonly SlashCommand[];
}

/**
 * The palette rows, as `DialogItem`s for the shared picker.
 *
 * Keybindings come first, grouped by their registry category with the chord in
 * the right-aligned meta column; slash commands follow, grouped by their own
 * category, with their aliases as meta. Group order and within-group order are
 * the registries' own, so the palette reads the same way the source of truth
 * does.
 */
export function buildPaletteItems({
  bindings = KEYBINDINGS,
  commands = SLASH_COMMANDS,
}: PaletteInput = {}): DialogItem[] {
  const items: DialogItem[] = [];
  for (const [category, entries] of keybindingsByCategory(bindings)) {
    for (const binding of entries) {
      items.push({
        id: `key:${binding.id}`,
        label: sanitizeTuiText(binding.description),
        meta: sanitizeTuiText(binding.keys),
        category: `${category} keys`,
      });
    }
  }
  for (const command of commands) {
    const aliases = command.aliases.map((alias) => `/${sanitizeTuiText(alias)}`).join(" ");
    items.push({
      id: `cmd:${command.name}`,
      label: `/${sanitizeTuiText(command.name)}`,
      description: sanitizeTuiText(command.description),
      ...(aliases.length > 0 ? { meta: aliases } : {}),
      category: `${commandCategoryLabel(command.category)} commands`,
    });
  }
  return items;
}

export interface PaletteDetailLine {
  text: string;
  tone: ShortcutsTone;
}

/**
 * The detail column for one palette row, wrapped to `width`.
 *
 * Every line is read off the registry entry the row was built from. A field the
 * registry does not carry produces no line at all — there is no placeholder
 * chord, no invented usage string, and the maintainer-only `handler` provenance
 * is never shown to an operator.
 */
export function paletteDetailLines(
  id: string,
  width: number,
  { bindings = KEYBINDINGS, commands = SLASH_COMMANDS }: PaletteInput = {},
): PaletteDetailLine[] {
  const room = cells(width);
  if (room <= 0 || typeof id !== "string") return [];
  const lines: PaletteDetailLine[] = [];
  const push = (text: string, tone: ShortcutsTone) => {
    for (const line of wrapText(sanitizeTuiText(text), room)) lines.push({ text: line, tone });
  };

  if (id.startsWith("key:")) {
    const binding = bindings.find((entry) => `key:${entry.id}` === id);
    if (!binding) return [];
    push(binding.keys, "heading");
    push(binding.category, "keys");
    lines.push({ text: "", tone: "blank" });
    push(binding.description, "description");
    lines.push({ text: "", tone: "blank" });
    push("Bound in the chat console.", "blank");
    return lines;
  }

  if (id.startsWith("cmd:")) {
    const command = commands.find((entry) => `cmd:${entry.name}` === id);
    if (!command) return [];
    push(`/${command.name}`, "heading");
    if (command.aliases.length > 0) {
      push(`Also: ${command.aliases.map((alias) => `/${alias}`).join(" ")}`, "keys");
    }
    lines.push({ text: "", tone: "blank" });
    push(command.description, "description");
    if (command.usage) {
      lines.push({ text: "", tone: "blank" });
      push(command.usage, "keys");
    }
    if (command.tuiOnly) {
      lines.push({ text: "", tone: "blank" });
      push("Console only: the readline client cannot run this one.", "blank");
    }
    lines.push({ text: "", tone: "blank" });
    push("Type it in the chat composer to run it.", "blank");
    return lines;
  }

  return [];
}

/**
 * Fit detail lines to the rows the column actually has, marking the cut.
 *
 * Same contract as {@link clipShortcutsRows}: the overflow is cut rather than
 * painted through the box below it, and the cut is visible rather than silent.
 */
export function clipPaletteLines(
  lines: readonly PaletteDetailLine[],
  limit: number,
): PaletteDetailLine[] {
  const room = cells(limit);
  if (room <= 0) return [];
  if (lines.length <= room) return [...lines];
  const kept = lines.slice(0, room);
  kept[room - 1] = { text: "…", tone: "blank" };
  return kept;
}

/** The right-aligned count on the palette's title row. Never a rounded guess. */
export function paletteCountMeta(shown: number, total: number): string {
  const visible = cells(shown);
  const all = cells(total);
  if (visible === all) return `${all} entr${all === 1 ? "y" : "ies"}`;
  return `${visible}/${all}`;
}

// ===========================================================================
// KEYBINDINGS EDITOR — the editable projection of the rebindable set
// ===========================================================================
//
// `/keybindings` is the write side of `/shortcuts`: the same registry, but the
// rebindable View toggles can be re-captured and persisted. This module owns
// the row model and the display formatting; the screen (`keybindings-editor-
// screen.tsx`) draws it and captures keys, and `keybindings.ts` owns the chord
// model, the resolver and the conflict rules. Nothing here is invented — every
// row is a registry binding, and every chord shown is the effective one
// (override ?? default).

/** Human-facing names for the OpenTUI key names the chord model stores. */
const CHORD_NAME_LABELS: Readonly<Record<string, string>> = {
  return: "Enter",
  escape: "Esc",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  space: "Space",
};

/** Human-facing labels for the chord modifiers, in canonical display order. */
const CHORD_MODIFIER_LABELS: readonly ["ctrl" | "shift" | "meta" | "option", string][] = [
  ["ctrl", "Ctrl"],
  ["shift", "Shift"],
  ["meta", "Meta"],
  ["option", "Alt"],
];

/**
 * Render a canonical chord string ("ctrl+b", "pageup") as a display label
 * ("Ctrl+B", "PageUp"). The inverse of the parser's normalisation, for the
 * editor and any effective-chord reference. An unparseable string is shown
 * verbatim rather than dropped, so the operator always sees what is stored.
 */
export function chordDisplay(chord: string): string {
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  const parts: string[] = [];
  for (const [flag, label] of CHORD_MODIFIER_LABELS) {
    if (parsed[flag]) parts.push(label);
  }
  const name = parsed.name;
  const labelled =
    CHORD_NAME_LABELS[name] ?? (name.length === 1 ? name.toUpperCase() : `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`);
  parts.push(labelled);
  return parts.join("+");
}

/**
 * The effective chords of a binding, joined for display (" / " between
 * alternates), applying any override. Used by the editor and — so the
 * cheat-sheet reflects reality — the reference view when it is given the
 * overrides map.
 */
export function effectiveKeysDisplay(
  binding: Keybinding,
  overrides?: Record<string, string>,
): string {
  return effectiveChords(binding, overrides).map(chordDisplay).join(" / ");
}

export interface KeybindingEditorRow {
  kind: "heading" | "binding";
  /** Heading text (category) for `heading` rows. */
  label?: string;
  /** Binding id for `binding` rows. */
  id?: string;
  description?: string;
  category?: KeybindingCategory;
  /** The effective chord label (override applied) for `binding` rows. */
  chord?: string;
  /** Whether the operator may remap this row. */
  rebindable?: boolean;
  /** Whether an override is currently active for this row. */
  overridden?: boolean;
}

/**
 * The editor's flat row model: one heading per category, one row per binding,
 * with the effective chord and the rebindable / overridden flags decided here
 * so the screen draws no logic. Built from the shared registry via
 * `keybindingsByCategory`, so order and grouping match the source of truth.
 */
export function buildKeybindingEditorRows(
  overrides: Record<string, string> = {},
  bindings: readonly Keybinding[] = KEYBINDINGS,
): KeybindingEditorRow[] {
  const rows: KeybindingEditorRow[] = [];
  for (const [category, entries] of keybindingsByCategory(bindings)) {
    rows.push({ kind: "heading", label: category.toUpperCase(), category });
    for (const binding of entries) {
      rows.push({
        kind: "binding",
        id: binding.id,
        description: sanitizeTuiText(binding.description),
        category,
        chord: sanitizeTuiText(effectiveKeysDisplay(binding, overrides)),
        rebindable: binding.rebindable,
        overridden: binding.rebindable && typeof overrides[binding.id] === "string",
      });
    }
  }
  return rows;
}

/** The indices of the editable (rebindable) binding rows, in row order. */
export function rebindableRowIndices(rows: readonly KeybindingEditorRow[]): number[] {
  const indices: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "binding" && row.rebindable) indices.push(index);
  });
  return indices;
}

/** The editor's footer hint, depending on whether a chord is being captured. */
export function keybindingsEditorFooterHint(capturing: boolean): string {
  return capturing
    ? ["press a chord to bind", "esc cancel"].join(" · ")
    : ["↑/↓ move", "enter rebind", "r reset", "esc back", "ctrl+c exit"].join(" · ");
}

/** The editor's pane title. */
export function keybindingsEditorTitle(): string {
  return "KEYBINDINGS";
}
