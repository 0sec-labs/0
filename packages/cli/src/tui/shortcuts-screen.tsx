/** @jsxImportSource @opentui/react */
/**
 * The console's help palette (`/shortcuts`), as a pop-up dialog.
 *
 * A searchable, grouped reference of everything the console binds: every chord
 * in the shared `keybindings.ts` registry (itself a hand-verified mirror of the
 * real `useKeyboard` guards in `chat-screen.tsx`) and every slash command in
 * `slash-commands.ts`, with a detail column for the highlighted entry whenever
 * the surface is wide enough to hold one.
 *
 * Three properties are load-bearing:
 *
 * 1. **Nothing is invented.** Every row comes off one of the two registries.
 *    There is no aspirational chord, no placeholder command and no "coming
 *    soon" entry; a field a registry does not carry produces no line.
 *
 * 2. **It is a reference, not an executor.** The palette cannot run a command
 *    from here — this route has no composer — so Enter is deliberately inert
 *    and the footer never claims otherwise. Commands are named so an operator
 *    can type them in the chat composer.
 *
 * 3. **It does no arithmetic and owns no picker.** Filtering, grouping,
 *    windowing and every width come off the shared `dialog-select` layout, the
 *    same one the model picker and the settings screen use, so the body cannot
 *    overflow the box the host reserved (Yoga shrinks siblings rather than
 *    clipping them — see PRIMITIVES.md).
 */

import React, { useMemo, useRef, useState } from "react";
import { TextAttributes, decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";

import { useTheme, type Theme } from "./theme-context.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { Cells } from "./primitives.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import {
  buildDialogRows,
  clampDialogSelection,
  computeDialogPanel,
  filterDialogItems,
  moveDialogSelection,
} from "./dialog-select-layout.js";
import { paneTitleColumns } from "./pane-layout.js";
import { sanitizeTuiText } from "./text.js";
import {
  buildPaletteItems,
  clipPaletteLines,
  computeShortcutsLayout,
  paletteCountMeta,
  paletteDetailLines,
  shortcutsFooterHint,
  type ShortcutsTone,
} from "./keybindings-layout.js";

export interface ShortcutsFrameInput {
  /** The screen body, already sized to the rows the frame left it. */
  body: React.ReactNode;
  /** Footer text naming the bindings that actually work. */
  hint: string;
}

export interface ShortcutsScreenProps {
  /**
   * Wraps the body in the console shell. Injected rather than imported so this
   * module does not depend on `run.tsx`, which owns `ShellFrame`.
   */
  frame: (input: ShortcutsFrameInput) => React.ReactNode;
  /** Leave the screen — Esc. */
  onBack: () => void;
  /** Leave the console entirely — ctrl+c. */
  onExit: () => void;
}

/** How many rows page-up and page-down move. */
const PAGE_STEP = 5;
/** The dialog's own icon+title row, budgeted out of the body. */
const HEADER_ROWS = 1;

function toneColor(theme: Theme, tone: ShortcutsTone | undefined): string | undefined {
  switch (tone) {
    case "heading":
      return theme.PRIMARY;
    case "keys":
      return theme.ACCENT;
    case "description":
      return theme.TEXT;
    case "blank":
      return theme.MUTED;
    default:
      return theme.TEXT;
  }
}

export function ShortcutsScreen({ frame, onBack, onExit }: ShortcutsScreenProps) {
  const theme = useTheme();
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();

  const items = useMemo(() => buildPaletteItems(), []);
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  const [rawCursor, setRawCursor] = useState(0);
  const cursorRef = useRef(0);

  const filtered = useMemo(() => filterDialogItems(items, query), [items, query]);
  const cursor = clampDialogSelection(filtered, rawCursor);
  const totalRows = useMemo(() => buildDialogRows(filtered).length, [filtered]);

  // The shell's own chrome budget, reused rather than re-derived, less the one
  // row this dialog spends on its title.
  const shell = computeShortcutsLayout({
    width,
    height,
    // One host row (the footer) inside a dialog; the legacy shell otherwise.
    ...(inDialog ? { hostRows: 1, hostPaddingX: 0 } : {}),
  });
  const bodyRows = Math.max(1, shell.bodyRows - HEADER_ROWS);
  const panel = computeDialogPanel({
    width: shell.contentWidth,
    height,
    size: "large",
    totalRows,
    withDetail: true,
    bodyRows,
  });

  const moveTo = (next: number) => {
    cursorRef.current = next;
    setRawCursor(next);
  };
  const move = (step: number) => {
    const visible = filterDialogItems(items, queryRef.current);
    if (visible.length === 0) return;
    const dir: 1 | -1 = step >= 0 ? 1 : -1;
    let next = clampDialogSelection(visible, cursorRef.current);
    for (let i = 0; i < Math.abs(step); i += 1) next = moveDialogSelection(visible, next, dir);
    moveTo(next);
  };
  const setFilter = (next: string) => {
    queryRef.current = next;
    setQuery(next);
    moveTo(0);
  };

  usePaste((event) => {
    const text = sanitizeTuiText(decodePasteBytes(event.bytes));
    if (text) setFilter(queryRef.current + text);
  });

  useKeyboard((key) => {
    const seq = typeof key.sequence === "string" ? key.sequence : "";
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    if (key.ctrl && key.name === "u") return setFilter("");
    if (key.ctrl || key.meta || key.option) return;
    if (key.name === "escape") {
      // Esc unwinds one step: clear the search first, leave second.
      if (queryRef.current) return setFilter("");
      onBack();
      return;
    }
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "pageup") return move(-PAGE_STEP);
    if (key.name === "pagedown") return move(PAGE_STEP);
    if (key.name === "home") return moveTo(0);
    if (key.name === "end") {
      const visible = filterDialogItems(items, queryRef.current);
      return moveTo(clampDialogSelection(visible, visible.length - 1));
    }
    if (key.name === "backspace") {
      setFilter(Array.from(queryRef.current).slice(0, -1).join(""));
      return;
    }
    // Enter is deliberately inert: this route is a reference and has no
    // composer to run a command in. Nothing here pretends to execute.
    if (key.name === "return") return;
    if (seq.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(seq)) {
      setFilter(queryRef.current + seq);
    }
  });

  const title = `${operatorIcon("shortcuts")} ${operatorTitle("shortcuts")}`;
  const meta = paletteCountMeta(filtered.length, items.length);
  const titleCols = paneTitleColumns(panel.innerWidth, meta.length);

  // The detail column: the highlighted entry's own registry record, wrapped to
  // the pane and clipped to its rows so it can never paint through the footer.
  const renderDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const lines = clipPaletteLines(paletteDetailLines(item.id, pane.width), pane.height);
    return (
      <>
        {lines.map((line, index) => (
          <Cells
            key={`detail-${index}`}
            width={pane.width}
            fg={toneColor(theme, line.tone)}
            attributes={index === 0 ? TextAttributes.BOLD : undefined}
          >
            {line.text}
          </Cells>
        ))}
      </>
    );
  };

  const body = (
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
      <box flexDirection="row" width={panel.innerWidth} flexShrink={0} minWidth={0}>
        <Cells width={titleCols.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
          {title}
        </Cells>
        <Cells width={titleCols.gap}>{""}</Cells>
        <Cells width={titleCols.metaWidth} align="right" fg={theme.MUTED}>
          {meta}
        </Cells>
      </box>
      <DialogSelectBody
        items={filtered}
        cursor={cursor}
        panel={panel}
        query={query}
        placeholder="search keys and commands"
        gutter={false}
        emptyText="no shortcut or command matches"
        renderDetail={renderDetail}
      />
    </box>
  );

  return <>{frame({ body, hint: shortcutsFooterHint() })}</>;
}
