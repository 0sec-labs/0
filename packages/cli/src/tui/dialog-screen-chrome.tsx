/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useTheme, type Theme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { Cells, textCells } from "./primitives.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import type { DialogItem } from "./dialog-select.js";
import { SCROLLBAR_COLUMN } from "./shell-geometry.js";
import { sleekScrollbar } from "./scrollbar.js";

// ---------------------------------------------------------------------------
// Dialog-interior helpers (presentation only)
//
// The launcher, mission control and doctor screens mount inside `DialogSurface`
// when the console navigates to them, so their interiors speak the same
// language as every other converted screen: an `operatorIcon`+`operatorTitle`
// row, the shared `DialogSelectBody` picker for the choices, and a detail
// column beside it while the surface is wide enough. These helpers are the
// small pieces those three interiors share; they own no domain logic.
// ---------------------------------------------------------------------------

/**
 * Full-width forms take two terminal cells but count as one character, and
 * every fitting helper here measures characters. The launcher's ＋ is one of
 * them, so a title row budgets the overhang explicitly instead of letting the
 * glyph paint a cell into its neighbour (OpenTUI does not clip).
 */
const DIALOG_FULLWIDTH_GLYPH = /[！-｠￠-￦]/g;

function dialogTitleOverhang(text: string): number {
  return (text.match(DIALOG_FULLWIDTH_GLYPH) ?? []).length;
}

/**
 * Display rows `buildDialogRows` will emit for these items — the item rows plus
 * one heading per category change. `computeDialogPanel` needs the total to
 * decide whether the list scrolls.
 */
export function dialogTotalRows(items: readonly DialogItem[]): number {
  let count = 0;
  let last: string | undefined;
  for (const item of items) {
    const category = item.category ?? "";
    if (category !== last) {
      last = category;
      if (category.length > 0) count += 1;
    }
    count += 1;
  }
  return count;
}

export interface DialogDetailLine {
  text: string;
  fg?: string;
}

/** Greedy word-wrap into `width`-cell lines, breaking words longer than a line. */
export function wrapDialogLines(value: unknown, width: number, fg?: string): DialogDetailLine[] {
  const cells = Math.max(1, Math.trunc(width));
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  const out: DialogDetailLine[] = [];
  let line = "";
  const flush = () => {
    if (line.length > 0) {
      out.push({ text: line, fg });
      line = "";
    }
  };
  for (const word of words) {
    let rest = word;
    while (rest.length > cells) {
      flush();
      out.push({ text: rest.slice(0, cells), fg });
      rest = rest.slice(cells);
    }
    if (rest.length === 0) continue;
    if (line.length === 0) line = rest;
    else if (line.length + 1 + rest.length <= cells) line = `${line} ${rest}`;
    else {
      flush();
      line = rest;
    }
  }
  flush();
  return out;
}

/** Icon + label on the left, live metadata right-aligned, fitted to `width`. */
export function DialogTitleRow({ screenKey, width, meta }: { screenKey: string; width: number; meta?: string }) {
  const theme = useTheme();
  const symbols = useSymbols();
  const title = `${operatorIcon(screenKey, symbols)} ${operatorTitle(screenKey)}`;
  const overhang = dialogTitleOverhang(title);
  const titleCells = textCells(title) + overhang;
  const metaCells = meta ? textCells(meta) : 0;
  const room = width - titleCells - 1;
  const metaWidth = metaCells > 0 && room >= 4 ? Math.min(metaCells, room) : 0;
  const gap = metaWidth > 0 ? 1 : 0;
  const titleWidth = Math.max(0, width - metaWidth - gap);
  return (
    <box flexDirection="row" width={width} flexShrink={0} minWidth={0}>
      <Cells width={Math.max(0, titleWidth - overhang)} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
        {title}
      </Cells>
      {metaWidth > 0 ? <Cells width={gap}>{""}</Cells> : null}
      {metaWidth > 0 ? (
        <Cells width={metaWidth} align="right" fg={theme.MUTED}>
          {meta}
        </Cells>
      ) : null}
    </box>
  );
}

/**
 * The detail column beside a picker list.
 *
 * Bounded to exactly the box the shared body handed over, and scrolled rather
 * than clipped: a diagnostic or a run summary too long for the pane stays
 * reachable with the wheel instead of being deleted. One column is left for
 * the scrollbar the moment the content overflows.
 */
export function DialogDetailColumn({
  lines,
  pane,
}: {
  lines: readonly DialogDetailLine[];
  pane: { width: number; height: number };
}) {
  const theme = useTheme();
  const inner = Math.max(1, pane.width - SCROLLBAR_COLUMN);
  return (
    <scrollbox width={pane.width} height={pane.height} flexShrink={0} scrollX={false} verticalScrollbarOptions={sleekScrollbar(theme)}>
      <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>
        {lines.map((line, index) => (
          <Cells key={`detail-${index}`} width={inner} fg={line.fg ?? theme.MUTED}>
            {line.text}
          </Cells>
        ))}
      </box>
    </scrollbox>
  );
}

/**
 * Colour for a run's lifecycle status, and only for a status this recognises:
 * an unfamiliar value renders uncoloured rather than being guessed into a
 * pass/fail bucket it may not belong to.
 */
export function scanStatusTone(theme: Theme, status: string | undefined | null): string | undefined {
  const value = (status ?? "").toLowerCase();
  if (value.length === 0) return undefined;
  if (value.includes("fail") || value.includes("error") || value.includes("abort") || value.includes("cancel")) return theme.ERROR;
  if (value.includes("running") || value.includes("pending") || value.includes("queued") || value.includes("start")) return theme.PRIMARY;
  if (value.includes("complete") || value.includes("finished") || value.includes("success") || value.includes("done")) return theme.SUCCESS;
  return undefined;
}

