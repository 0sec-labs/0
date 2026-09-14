/**
 * Right-click context-menu state and the pure geometry/navigation logic behind
 * it.
 *
 * The interactive surface (the bordered popup, its keyboard and its mouse) is
 * `context-menu.tsx`; this module is deliberately React-light so the parts that
 * are worth testing — where the popup lands on screen, and which row the
 * keyboard moves to — are ordinary pure functions with no renderer.
 *
 * `useContextMenu` is the only React-touching export: a tiny open/close state
 * holder a screen keeps and points its right-click handlers at. `isRightClick`
 * is the single predicate every wired surface uses to tell a menu-summoning
 * right press (OpenTUI's `MouseEvent.button === 2`) apart from an ordinary
 * left-click, so the existing left-click / drag / keyboard paths are never
 * disturbed.
 */

import { useCallback, useState } from "react";

/** One row of a context menu. */
export interface ContextMenuItem {
  /** The row's visible text. */
  label: string;
  /** Invoked when the row is activated (click or Enter). */
  onSelect: () => void;
  /** A greyed, non-activatable row (kept for context, e.g. "no fix"). */
  disabled?: boolean;
  /** A destructive action — tinted with the ERROR token when not highlighted. */
  danger?: boolean;
}

/** The open/closed state of a single context menu. */
export interface ContextMenuState {
  /** Whether the menu is currently shown. */
  open: boolean;
  /** Absolute cell column the menu is anchored at (the cursor). */
  x: number;
  /** Absolute cell row the menu is anchored at (the cursor). */
  y: number;
  /** The rows to render. Empty only while closed. */
  items: ContextMenuItem[];
}

const CLOSED: ContextMenuState = { open: false, x: 0, y: 0, items: [] };

/** Imperative handle a screen keeps to drive one context menu. */
export interface UseContextMenu {
  /** The current state — feed straight to `<ContextMenu />` when `open`. */
  state: ContextMenuState;
  /** Open the menu at absolute cell (x, y) with `items`. A no-op if empty. */
  open: (x: number, y: number, items: ContextMenuItem[]) => void;
  /** Dismiss the menu. */
  close: () => void;
}

/**
 * Hold the open/close state of a single context menu. Pure-ish: it owns nothing
 * but a state cell, so a screen can keep one and open it from any right-click
 * handler. Opening with no items is ignored, so a caller can build items
 * unconditionally and let an empty list mean "no menu here".
 */
export function useContextMenu(): UseContextMenu {
  const [state, setState] = useState<ContextMenuState>(CLOSED);
  const open = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    if (!items || items.length === 0) return;
    setState({ open: true, x, y, items });
  }, []);
  const close = useCallback(() => setState(CLOSED), []);
  return { state, open, close };
}

/**
 * True when a mouse event is a right-button press — the gesture that summons a
 * context menu. OpenTUI reports the right button as `2` on `MouseEvent.button`
 * (see `@opentui/core`'s `RawMouseEvent`). Anything else (a left-click, a
 * missing event) is false, so this can gate a new handler without ever
 * swallowing the ordinary left-click / drag path.
 */
export function isRightClick(event: { button?: number } | null | undefined): boolean {
  return Boolean(event) && event!.button === 2;
}

/** A menu's rendered footprint in cells. */
export interface MenuBox {
  width: number;
  height: number;
}

/** The terminal's usable cell grid. */
export interface Viewport {
  width: number;
  height: number;
}

/** A clamped top-left cell position for the menu box. */
export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * Place a `menu`-sized box anchored at the cursor `(anchorX, anchorY)` so it
 * stays fully inside a `viewport`-sized terminal.
 *
 * Preference is down-and-right of the cursor (the popup grows from where the
 * click landed). When it would overflow the right edge it flips LEFT — the
 * cursor becomes the menu's right edge; when it would overflow the bottom it
 * flips UP — the cursor becomes the menu's bottom edge. After flipping, the
 * result is clamped into `[0, viewport - size]` so a menu taller or wider than
 * the whole screen still pins to the top-left rather than rendering off-grid.
 *
 * Pure: no terminal, no state. Unit-tested.
 */
export function clampMenuPosition(
  anchorX: number,
  anchorY: number,
  menu: MenuBox,
  viewport: Viewport,
): MenuPosition {
  const width = Math.max(0, Math.floor(menu.width));
  const height = Math.max(0, Math.floor(menu.height));
  const vw = Math.max(0, Math.floor(viewport.width));
  const vh = Math.max(0, Math.floor(viewport.height));

  // Horizontal: prefer opening rightward; flip left if it would overflow.
  let x = anchorX;
  if (x + width > vw) x = anchorX - width;
  x = Math.max(0, Math.min(x, Math.max(0, vw - width)));

  // Vertical: prefer opening downward; flip up if it would overflow.
  let y = anchorY;
  if (y + height > vh) y = anchorY - height;
  y = Math.max(0, Math.min(y, Math.max(0, vh - height)));

  return { x, y };
}

/**
 * The first activatable (non-disabled) row index, or -1 when every row is
 * disabled. The context menu opens with this row highlighted so Enter is
 * immediately meaningful.
 */
export function firstEnabledIndex(items: readonly ContextMenuItem[]): number {
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i].disabled) return i;
  }
  return -1;
}

/**
 * The next activatable row index moving by `dir` (+1 down, -1 up) from
 * `current`, skipping disabled rows and wrapping around the ends. Returns
 * `current` when there is no other enabled row to move to (so a menu of one
 * enabled row holds still), or -1 when the list has no enabled row at all.
 *
 * Pure: unit-tested.
 */
export function nextEnabledIndex(
  items: readonly ContextMenuItem[],
  current: number,
  dir: 1 | -1,
): number {
  const n = items.length;
  if (n === 0) return -1;
  if (firstEnabledIndex(items) === -1) return -1;
  let idx = current;
  for (let step = 0; step < n; step += 1) {
    idx = (idx + dir + n) % n;
    if (!items[idx].disabled) return idx;
  }
  return current;
}
