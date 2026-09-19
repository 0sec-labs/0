/** @jsxImportSource @opentui/react */
/**
 * The right-click context menu: a small borderless popup that appears at the
 * cursor with the actions for whatever was clicked, matching the herdr-style
 * gesture ("right-click a thing → its actions, where you clicked").
 *
 * It is a pure presentation of a {@link ContextMenuState} from
 * `use-context-menu.ts` — the screen owns the open/close state and hands this a
 * position and a list of items. All the geometry that is worth testing (where
 * the popup lands, which row the keyboard moves to) lives as pure functions in
 * that module; this file is just the OpenTUI surface.
 *
 * Chrome is theme-token only: a raised `PANEL` ground (color contrast, no drawn outline), `TEXT`
 * rows, `ACCENT` behind the highlighted row (with `CANVAS` as its readable
 * inverse, the same pairing the pickers use), `MUTED` for disabled rows and
 * `ERROR` for a danger action.
 *
 * Dismissal is the usual three ways: Esc, a click on the full-screen
 * transparent backdrop behind it (click-outside), or activating a row. It
 * floats above normal content on a high `zIndex` and never participates in the
 * transcript's or the list's layout.
 */

import { useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { TextAttributes } from "@opentui/core";

import { useTheme } from "./theme-context.js";
import { fitTuiText, sanitizeTuiText } from "./text.js";
import { Popup } from "./popup.js";
import {
  firstEnabledIndex,
  nextEnabledIndex,
  type ContextMenuItem,
} from "./use-context-menu.js";

/** Stacking order for the backdrop; the menu sits one above it. Both clear normal content. */
const BACKDROP_ZINDEX = 300;
/** Longest label the popup will render before the viewport clamp trims it further. */
const MAX_LABEL = 40;
/** Two cells of horizontal padding each side — the surface is borderless and
 * reads as a raised layer through its `PANEL` ground, not a drawn outline. */
const CHROME_CELLS = 4;

export interface ContextMenuProps {
  /** The rows to show. */
  items: readonly ContextMenuItem[];
  /** Absolute cell column the menu is anchored at (the cursor). */
  x: number;
  /** Absolute cell row the menu is anchored at (the cursor). */
  y: number;
  /** Dismiss the menu (Esc, click-outside, or after a row activates). */
  onClose: () => void;
}

/**
 * Render the context menu. Returns `null` when there is nothing to show, so a
 * caller can mount it unconditionally and let an empty list mean "closed".
 */
export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const theme = useTheme();
  const { width: termWidth } = useTerminalDimensions();
  const [highlight, setHighlight] = useState(() => firstEnabledIndex(items));

  // A fresh open (new items identity) re-seeds the highlight onto the first
  // activatable row so Enter is immediately meaningful.
  useEffect(() => {
    setHighlight(firstEnabledIndex(items));
  }, [items]);

  useKeyboard((key) => {
    // The summoning screen bails out of its own keyboard handler while the menu
    // is open, so the menu owns the keys; stop/prevent here too, defensively.
    key.stopPropagation?.();
    key.preventDefault?.();
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      onClose();
      return;
    }
    if (key.name === "up") {
      setHighlight((cur) => nextEnabledIndex(items, cur, -1));
      return;
    }
    if (key.name === "down") {
      setHighlight((cur) => nextEnabledIndex(items, cur, 1));
      return;
    }
    if (key.name === "return") {
      const item = items[highlight];
      if (item && !item.disabled) {
        onClose();
        item.onSelect();
      }
      return;
    }
  });

  if (items.length === 0) return null;

  // Budget the popup width off the widest (sanitised) label, capped and then
  // clamped to the viewport so it can never render wider than the screen.
  const labels = items.map((item) => sanitizeTuiText(item.label));
  const widest = labels.reduce((max, label) => Math.max(max, label.length), 1);
  const innerWidth = Math.max(
    1,
    Math.min(widest, MAX_LABEL, Math.max(1, termWidth - CHROME_CELLS)),
  );
  const boxWidth = innerWidth + CHROME_CELLS;
  const boxHeight = items.length + 2; // one row per item + top/bottom padding

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };

  return (
    <Popup
      variant="anchored"
      backdrop="transparent"
      anchor={{ x, y }}
      width={boxWidth}
      height={boxHeight}
      onClose={onClose}
      zIndex={BACKDROP_ZINDEX}
    >
      {items.map((item, i) => {
          const active = i === highlight && !item.disabled;
          const fg = active
            ? theme.CANVAS
            : item.disabled
              ? theme.MUTED
              : item.danger
                ? theme.ERROR
                : theme.TEXT;
          return (
            <box
              key={`${i}:${labels[i]}`}
              width={innerWidth}
              height={1}
              flexShrink={0}
              minWidth={0}
              backgroundColor={active ? theme.ACCENT : undefined}
              onMouseDown={(event) => {
                event.stopPropagation?.();
                activate(item);
              }}
              onMouseOver={item.disabled ? undefined : () => setHighlight(i)}
            >
              <text
                width={innerWidth}
                height={1}
                wrapMode="none"
                truncate
                fg={fg}
                attributes={active ? TextAttributes.BOLD : undefined}
              >
                {fitTuiText(labels[i], innerWidth)}
              </text>
            </box>
          );
        })}
    </Popup>
  );
}
