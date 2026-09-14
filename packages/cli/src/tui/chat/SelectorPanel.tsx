/** @jsxImportSource @opentui/react */
import React from "react";
import { TextAttributes } from "@opentui/core";
import { fitLegend, fitTuiText } from "../text.js";
import { commandMenuBoxHeight } from "../chat-layout.js";
import { DialogSelectBody } from "../dialog-select.js";
import { computeDialogPanel, type DialogItem } from "../dialog-select-layout.js";
import type { SelectorItem } from "../selector.js";
import type { Theme } from "../theme-context.js";

/**
 * How many rows a selector panel may spend, and on what.
 *
 * The panel is a background-contrast popup stacked above the composer with an
 * EXPLICIT height, so whatever it claims here is exactly what it paints.
 * `budget` is
 * the number of content rows the column can spare (from
 * `computeCommandMenuHeight`, which already reserves the composer, the
 * header and a minimum transcript).
 *
 * The optional lines are bought in priority order out of that budget rather
 * than added on top of it: at least one item row always survives, then the
 * context line (which says WHAT is being decided), then the detail line for
 * the highlighted item. A panel that cannot afford them drops them instead
 * of growing past its budget and over-subscribing the column — which is the
 * exact failure that painted four `<text>` children onto one another and
 * through the box border.
 */
export function selectorPanelBudget({
  budget,
  hasContext,
  hasDetail,
}: {
  budget: number;
  hasContext: boolean;
  hasDetail: boolean;
}): { maxItemRows: number; showContext: boolean; showDetail: boolean } {
  const total = Math.max(1, budget);
  let remaining = total - 1; // one item row is non-negotiable
  const showContext = hasContext && remaining > 0;
  if (showContext) remaining -= 1;
  const showDetail = hasDetail && remaining > 0;
  if (showDetail) remaining -= 1;
  return { maxItemRows: 1 + remaining, showContext, showDetail };
}

/**
 * Total rows a selector panel occupies for the rows it actually renders.
 * `commandMenuBoxHeight` covers the two chrome rows (now paddingY, formerly
 * the border), the header and the hint footer; the optional lines are added
 * explicitly.
 */
export function selectorPanelHeight(itemRows: number, showContext: boolean, showDetail: boolean): number {
  return commandMenuBoxHeight(Math.max(itemRows, 1), 1)
    + (showContext ? 1 : 0)
    + (showDetail ? 1 : 0);
}

/**
 * THE decision surface.
 *
 * The in-chat picker (`/mode`, `/scope` and every inline `SelectorState`-driven
 * choice) renders through this one component, driven by the same reducer and
 * the same key bindings. Its item list is now drawn by the SAME
 * `DialogSelectBody` the model/theme pickers use, in inline `bodyRows` mode, so
 * the rows are byte-for-byte the same style as every other picker: one row per
 * item, the PRIMARY-background active-row highlight, the shared column layout
 * and the current-value gutter dot. Only the surrounding chrome (the title /
 * context / detail / footer lines) is this component's own, and it keeps the
 * explicit-height + `flexShrink={0}` discipline that stops Yoga from squeezing
 * the box under its own contents.
 */
export function SelectorPanel({
  title,
  subtitle,
  context,
  contextColor,
  items,
  activeIndex,
  visibleRows,
  detail,
  hint,
  emptyText,
  borderColor,
  titleColor,
  contentWidth,
  height,
  theme,
}: {
  title: string;
  subtitle: string;
  context?: string;
  contextColor?: string;
  /** The FULL filtered item list; the body windows it around `activeIndex`. */
  items: SelectorItem[];
  /** Highlighted position within `items` (absolute, not a window offset). */
  activeIndex: number;
  /** List rows the body may paint — the item region the caller budgeted. */
  visibleRows: number;
  detail?: string;
  hint: string;
  emptyText: string;
  borderColor: string;
  titleColor: string;
  contentWidth: number;
  height: number;
  theme: Theme;
}) {
  const { PANEL_ALT, MUTED, TEXT, ERROR } = theme;
  // Deliberately conservative: the real inner width is 2 (compact) to 4
  // (wide) cells more than this, so every explicit allocation below fits
  // with room to spare and can never reach the border.
  const innerWidth = Math.max(1, contentWidth - 4);
  const headerGap = innerWidth > 12 ? 1 : 0;
  const headerTitleWidth = Math.max(1, Math.min(innerWidth - headerGap, Math.floor(innerWidth * 0.55)));
  const headerSubtitleWidth = Math.max(0, innerWidth - headerTitleWidth - headerGap);

  // One DialogItem per selector row. `detail` is NOT mapped to the row's
  // description column — it stays the single detail line below the list, as
  // before — so each row shows label + right-aligned meta, plus the shared
  // gutter dot for the current value.
  const dialogItems: DialogItem[] = items.map((item) => ({
    id: item.id,
    label: item.label,
    meta: item.meta,
    current: item.current,
    disabled: item.disabled,
  }));
  const hasGutter = items.some((item) => item.current);
  // Inline geometry: the panel supplies the chrome, so the body spends none of
  // its width on it and sizes its list from `visibleRows` (+ the one row the
  // body reserves for its hidden search line).
  const panel = computeDialogPanel({
    width: innerWidth,
    height: Math.max(1, visibleRows),
    totalRows: dialogItems.length,
    bodyRows: Math.max(1, visibleRows) + 1,
  });

  return (
    // Inline, NOT a dialog: no scrim, no absolute positioning, no centring —
    // it sits in the composer's column and shares its vertical budget.
    // Borderless like the restyled dialogs/screens: the drawn rounded outline
    // is replaced by the PANEL_ALT background contrast that now delineates the
    // popup. The two former border columns become paddingX={2} and the two
    // border rows become paddingY={1}, so the inner width/height budget is
    // unchanged and `commandMenuBoxHeight`'s two chrome rows still hold. The
    // `borderColor` prop stays in the public interface (callers pass it) but no
    // longer draws a box; identity now rides the bold `titleColor` title text.
    <box flexDirection="column" width="100%" minWidth={0} height={height} flexShrink={0} marginTop={1} backgroundColor={PANEL_ALT} paddingX={2} paddingY={1}>
      <box flexDirection="row" width={innerWidth} height={1} flexShrink={0} minWidth={0}>
        <box width={headerTitleWidth} height={1} flexShrink={0} minWidth={0}>
          <text width={headerTitleWidth} height={1} wrapMode="none" truncate fg={titleColor} attributes={TextAttributes.BOLD}>{fitTuiText(title, headerTitleWidth)}</text>
        </box>
        {headerSubtitleWidth > 0 ? (
          <box width={headerSubtitleWidth} height={1} flexShrink={0} minWidth={0} marginLeft={headerGap} alignItems="flex-end">
            <text width={headerSubtitleWidth} height={1} wrapMode="none" truncate fg={MUTED}>{fitTuiText(subtitle, headerSubtitleWidth, { mode: "middle" })}</text>
          </box>
        ) : null}
      </box>
      {context ? (
        <box width={innerWidth} height={1} flexShrink={0} minWidth={0}>
          {/* Truncated, never wrapped: a wrapping line has an unpredictable
              height, and an unpredictable height is what over-subscribes the
              column in the first place. */}
          <text width={innerWidth} height={1} wrapMode="none" truncate fg={contextColor ?? TEXT}>{fitTuiText(context, innerWidth, { mode: "middle" })}</text>
        </box>
      ) : null}
      {dialogItems.length > 0 ? (
        // The shared list body: identical highlight, columns and gutter as every
        // other picker. The search line is hidden — this picker filters through
        // the composer above, exactly as it did before.
        <DialogSelectBody
          items={dialogItems}
          cursor={activeIndex}
          panel={panel}
          query=""
          hideSearch
          gutter={hasGutter}
          emptyText={emptyText}
        />
      ) : (
        <box width={innerWidth} height={1} flexShrink={0} minWidth={0}>
          <text width={innerWidth} height={1} wrapMode="none" truncate fg={ERROR}>{fitTuiText(emptyText, innerWidth)}</text>
        </box>
      )}
      {detail ? (
        <box width={innerWidth} height={1} flexShrink={0} minWidth={0}>
          <text width={innerWidth} height={1} wrapMode="none" truncate fg={MUTED}>{fitTuiText(detail, innerWidth, { mode: "middle" })}</text>
        </box>
      ) : null}
      {/* The footer hint row — the inline equivalent of a dialog's action
          footer, and the last row the precomputed `height` accounts for. */}
      <box width={innerWidth} height={1} flexShrink={0} minWidth={0}>
        <text width={innerWidth} height={1} wrapMode="none" truncate fg={MUTED}>{fitLegend(innerWidth, hint)}</text>
      </box>
    </box>
  );
}
