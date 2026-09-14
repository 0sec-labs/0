/**
 * Mouse-support helpers for the interactive console.
 *
 * OpenTUI already enables terminal mouse reporting by default and a
 * `<scrollbox>` scrolls itself when a wheel event bubbles up to it, so most of
 * the wheel/click behaviour needs no code here — it needs only NOT to be
 * suppressed. Two pieces of shared logic remain and both live in this module so
 * they can be reused and, for the pure part, unit-tested:
 *
 *  1. `wheelOffsetStep` / `clampScrollOffset` — mapping a wheel notch to a
 *     change in a "distance from the tail" scrollback offset, for the one
 *     transcript surface that windows an offset in React state instead of
 *     delegating to a real `<scrollbox>` (the drilled-in agent activity ring).
 *
 *  2. `useMouseSupport` — the single global gate. It mirrors the operator's
 *     `mouseSupport` setting onto `renderer.useMouse`, so turning the setting
 *     off returns the terminal to keyboard-only mode (and hands native text
 *     selection back to the terminal) without touching a single event handler.
 */

import { useEffect } from "react";
import { useRenderer } from "@opentui/react";

import { useSettings } from "./settings-store.js";

/** The shape OpenTUI hands us on `MouseEvent.scroll` for a wheel event. */
export interface WheelScrollInfo {
  direction: "up" | "down" | "left" | "right";
  delta: number;
}

/**
 * The signed change to apply to a scrollback offset for one wheel event, where
 * a LARGER offset means "further back from the newest row". Wheel-up scrolls
 * back (positive), wheel-down scrolls toward the tail (negative), and
 * horizontal notches contribute nothing to a vertical offset. `rowsPerNotch`
 * scales a single notch to a comfortable number of rows (a bare wheel notch
 * reports `delta: 1`); an accelerated `delta` is honoured proportionally.
 */
export function wheelOffsetStep(
  scroll: WheelScrollInfo | undefined,
  rowsPerNotch = 3,
): number {
  if (!scroll) return 0;
  const magnitude = Math.max(1, Math.round(Math.abs(scroll.delta || 1))) * rowsPerNotch;
  if (scroll.direction === "up") return magnitude;
  if (scroll.direction === "down") return -magnitude;
  return 0;
}

/**
 * The signed change to apply to a list CURSOR (an index into the rows) for one
 * wheel event, for a windowed picker whose highlight is its only scroll
 * position (so the wheel moves the selection exactly as the arrow keys do).
 * Wheel-down advances toward later rows (positive), wheel-up retreats toward
 * earlier rows (negative). One notch moves `rowsPerNotch` rows.
 */
export function wheelRowDelta(scroll: WheelScrollInfo | undefined, rowsPerNotch = 1): number {
  return -wheelOffsetStep(scroll, rowsPerNotch);
}

/**
 * Clamp a scrollback offset into `[0, max]`. The tail is offset 0; `max`
 * (default unbounded) is the oldest reachable row.
 */
export function clampScrollOffset(offset: number, max = Number.POSITIVE_INFINITY): number {
  if (Number.isNaN(offset)) return 0;
  return Math.max(0, Math.min(offset, max));
}

/**
 * Global on/off switch for terminal mouse reporting, driven by the
 * `mouseSupport` setting. Call once from an always-mounted component. When the
 * setting is off, `renderer.useMouse = false` stops OpenTUI from putting the
 * terminal into mouse-reporting mode, so no wheel/click event reaches any
 * handler and the terminal's own click-drag text selection works again. Every
 * keyboard path is independent of this and is never affected.
 */
export function useMouseSupport(): void {
  const renderer = useRenderer();
  const { mouseSupport } = useSettings();
  useEffect(() => {
    if (!renderer) return;
    renderer.useMouse = mouseSupport;
  }, [renderer, mouseSupport]);
}
