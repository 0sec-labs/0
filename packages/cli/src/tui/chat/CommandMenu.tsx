/** @jsxImportSource @opentui/react */
import React from "react";
import { fitHint, fitTuiText } from "../text.js";
import { operatorIcon } from "../operator-icons.js";
import { textCells } from "../primitives.js";
import type { CommandMenuLayout } from "../chat-layout.js";
import type { SlashCommand } from "../slash-commands.js";
import type { Theme } from "../theme-context.js";
import { useSymbols } from "../symbol-context.js";
import { DialogSelectBody } from "../dialog-select.js";
import { computeDialogPanel, type DialogItem } from "../dialog-select-layout.js";

/**
 * The slash-command menu, a background-contrast popup stacked directly above
 * the composer (borderless, delineated by its PANEL_ALT ground).
 *
 * This is the IN-PLACE palette, not a route: it is rendered inside the chat
 * composer area, so it deliberately registers NO keyboard handler of its own.
 * Navigation, completion, Enter and Esc all stay with `chat-screen.tsx`'s
 * single handler, which is what keeps the menu from stealing a keystroke from
 * the composer beneath it or from a dialog opened above it. Do not add a
 * `useKeyboard` here.
 *
 * The rows themselves are drawn by the SAME `DialogSelectBody` the model and
 * theme pickers use, in its inline `bodyRows` mode, so the palette is visually
 * identical to every other picker: one row per command, the PRIMARY-background
 * active-row highlight, the shared column layout, hover-to-select and the same
 * colours. The list windows around the cursor internally, so a filtered set
 * longer than the visible band is still fully reachable by arrowing.
 *
 * The rows list the REAL registered commands the caller filtered — their
 * canonical name, their registry description (the muted description column) and
 * their aliases/category (the right-aligned meta column). Nothing is invented.
 */
export function CommandMenu({
  layout,
  boxWidth,
  height,
  commands,
  selectedIndex,
  visibleRows,
  query,
  theme,
  onActivateRow,
  onHoverRow,
  onScroll,
}: {
  layout: CommandMenuLayout;
  boxWidth: number | "100%";
  height: number;
  commands: SlashCommand[];
  selectedIndex: number;
  visibleRows: number;
  query: string;
  theme: Theme;
  onActivateRow: (index: number) => void;
  onHoverRow: (index: number) => void;
  onScroll: (rowDelta: number) => void;
}) {
  const symbols = useSymbols();
  const { PANEL_ALT, MUTED, ERROR } = theme;
  const innerWidth = layout.innerWidth;

  // One DialogItem per command: the label is the canonical `/name`, the muted
  // description column carries the registry description (ONE row), and the
  // right-aligned meta column carries the aliases (or the category when a
  // command has none) — the same three-column shape the model picker uses.
  const items: DialogItem[] = commands.map((command) => ({
    id: `/${command.name}`,
    label: `/${command.name}`,
    description: command.description,
    meta: command.aliases.length > 0
      ? command.aliases.map((alias) => `/${alias}`).join(" ")
      : command.category,
  }));

  // Inline (`bodyRows`) geometry: the popup box supplies the border/padding, so
  // the body spends none of its own width on chrome and sizes its list from the
  // row budget rather than the terminal. `visibleRows` list rows + the one row
  // the body reserves for its (hidden) search line = the bodyRows budget.
  const panel = computeDialogPanel({
    width: Math.max(1, innerWidth),
    height: visibleRows,
    totalRows: items.length,
    bodyRows: visibleRows + 1,
  });

  // Header: a short title that always FITS (never the truncated "Com…"), with
  // the live count/query right-aligned beside it. The title width is whatever
  // the count does not claim, so the two leaves can never be handed overlapping
  // cells.
  const titleText = `${operatorIcon("commands", symbols)} Commands`;
  const countText = query ? `/${query} · ${commands.length}` : `all commands · ${commands.length}`;
  const countWidth = Math.min(
    Math.max(0, innerWidth - textCells(titleText) - 1),
    textCells(countText),
  );
  const titleWidth = Math.max(1, innerWidth - countWidth - (countWidth > 0 ? 1 : 0));

  return (
    // Borderless popup: the drawn box border is replaced by the PANEL_ALT
    // background contrast (raised over the chat's PANEL/CANVAS ground). The two
    // border columns become paddingX={2} and the two border rows become
    // paddingY={1}, so `commandMenuBoxHeight`'s MENU_CHROME_ROWS (2 padding rows
    // + the header + the hint footer = 4) still holds.
    <box flexDirection="column" width={boxWidth} minWidth={0} height={height} flexShrink={0} marginTop={1} backgroundColor={PANEL_ALT} paddingX={2} paddingY={1}>
      <box flexDirection="row" width={innerWidth} height={1} flexShrink={0} minWidth={0}>
        <box width={titleWidth} flexShrink={0} minWidth={0}>
          <text fg={MUTED}>{fitTuiText(titleText, titleWidth)}</text>
        </box>
        {countWidth > 0 ? (
          <box width={countWidth} flexShrink={0} minWidth={0} marginLeft={1} alignItems="flex-end">
            <text fg={MUTED}>{fitTuiText(countText, countWidth, { mode: "middle" })}</text>
          </box>
        ) : null}
      </box>
      {commands.length > 0 ? (
        <DialogSelectBody
          items={items}
          cursor={selectedIndex}
          panel={panel}
          query={query}
          hideSearch
          onActivateRow={onActivateRow}
          onHoverRow={onHoverRow}
          onScroll={onScroll}
          emptyText={`No command matches /${query}`}
        />
      ) : (
        <box width={innerWidth} flexShrink={0} minWidth={0}>
          <text fg={ERROR}>{fitTuiText(`No command matches /${query}`, Math.max(1, innerWidth))}</text>
        </box>
      )}
      <box width={innerWidth} flexShrink={0} minWidth={0}>
        <text fg={MUTED}>{fitHint(Math.max(1, innerWidth), [
          "[↑↓] select · [⇥] complete · [⏎] run · [esc] close",
          "[↑↓] select · [⇥] · [⏎] run · [esc]",
          "[↑↓] · [⇥] · [⏎] · [esc]",
        ])}</text>
      </box>
    </box>  );
}
