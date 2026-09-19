/** @jsxImportSource @opentui/react */
/**
 * The transient toast — a small borderless pill that appears, holds for ~1.5s,
 * and fades out, driven entirely by the pure envelope in `toast-logic.ts`.
 *
 * It wears the same chrome as the rest of the redesigned surfaces: no drawn
 * outline, a raised `PANEL_ALT` ground that reads as a distinct layer through
 * color contrast alone, and — when the caller states one — a severity tone that
 * colours the leading status glyph from the shared vocabulary
 * (`✓` success, `!` warning, `×` error). A caller that states no tone gets a
 * neutral pill; the component never infers a severity from the message text.
 *
 * Two exports:
 *
 *   - `Toast` renders a single {@link ToastFrame}. It is pure: given a frame it
 *     draws the pill (or nothing when the frame is hidden). No timers, no
 *     state — hand it a frame from `toastFrameAt` and it paints.
 *
 *   - `useToast` is the driver the chat surface will actually call: it holds
 *     the current show, ticks the clock while a toast is on screen, and hands
 *     back `{ showToast, frame }`. Point `useSelectionCopy({ onCopied })` at
 *     `showToast` and render `<Toast frame={frame} />` and copy-on-highlight
 *     has its feedback.
 *
 * Layout invariants (see `primitives.tsx`): every box is `flexShrink={0}` and
 * width-bounded, and the label is budgeted with `fitTuiText`, so the pill can
 * never be squeezed into an overlapping smear or push its own border off-grid.
 * It is positioned absolutely (bottom-right by default) with a high `zIndex`
 * so it floats over the transcript without participating in its layout.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { fitTuiText } from "./text.js";
import { useTheme, type Theme } from "./theme-context.js";
import { useSymbols, type SymbolTable } from "./symbol-context.js";
import {
  isToastDone,
  showToast as makeShow,
  toastDurationMs,
  toastFrameAt,
  type ToastConfig,
  type ToastFrame,
  type ToastShow,
  type ToastTone,
} from "./toast-logic.js";

/** How the toast is pinned to the viewport. */
export type ToastPlacement = "bottom-right" | "bottom-left" | "top-right" | "top-left";

/** Re-exported so a caller can name a tone without reaching into toast-logic. */
export type { ToastTone } from "./toast-logic.js";

export interface ToastProps {
  /** The current frame from `toastFrameAt`. Nothing renders when hidden. */
  frame: ToastFrame;
  /**
   * Corner to pin the pill to. Default `"bottom-right"` — above the composer's
   * right edge, out of the transcript's reading column. Chat-screen may want
   * `"top-right"` if the composer is tall.
   */
  placement?: ToastPlacement;
  /** Cells of inset from the pinned edges. Default 1. */
  margin?: number;
  /** Max cells the pill may occupy, so a long message cannot span the screen. */
  maxWidth?: number;
  /** Stacking order over the transcript. Default 50. */
  zIndex?: number;
}

/** Longest message we will render inside the pill, before the outer clamp. */
const DEFAULT_MAX_WIDTH = 40;
/** Two cells of horizontal padding each side — the pill is borderless and reads
 * as a raised layer through its background contrast, not a drawn outline. */
const CHROME_CELLS = 4;
/** Leading glyph (1) + its gap (1), spent only when a tone was stated. */
const GLYPH_CELLS = 2;

/**
 * Glyph + colour for a stated tone, from the same vocabulary the sidebar's
 * status marks use, so `✓ / ! / ×` mean the same thing in a toast as they do
 * in the agent list. An unstated tone gets NO glyph and neutral chrome: the
 * pill says what it was given and claims nothing further.
 */
function toneStyle(
  tone: ToastTone | undefined,
  theme: Theme,
  symbols: SymbolTable,
): { glyph?: string; color: string } {
  switch (tone) {
    case "success": return { glyph: symbols.check, color: theme.SUCCESS };
    case "warning": return { glyph: symbols.warning, color: theme.WARNING };
    case "error": return { glyph: symbols.cross, color: theme.ERROR };
    case "info": return { glyph: symbols.info, color: theme.ACCENT };
    default: return { color: theme.ACCENT };
  }
}

function edges(placement: ToastPlacement, margin: number) {
  const vertical = placement.startsWith("top") ? { top: margin } : { bottom: margin };
  const horizontal = placement.endsWith("left") ? { left: margin } : { right: margin };
  return { ...vertical, ...horizontal };
}

/**
 * Render a toast frame. Pure and side-effect free: safe to render every tick.
 * Returns `null` when the frame is hidden, so it costs nothing off-screen.
 */
export function Toast({
  frame,
  placement = "bottom-right",
  margin = 1,
  maxWidth = DEFAULT_MAX_WIDTH,
  zIndex = 50,
}: ToastProps): ReactNode {
  const theme = useTheme();
  const symbols = useSymbols();

  if (!frame.visible || frame.message.trim().length === 0) return null;

  const tone = toneStyle(frame.tone, theme, symbols);

  // Budget the label against the pill's inner width so it can never overflow
  // its border. `fitTuiText` also strips control chars from the message. The
  // glyph is dropped before the message is, so a very narrow clamp still
  // carries the words rather than a bare mark.
  const innerCap = Math.max(1, maxWidth - CHROME_CELLS);
  const showGlyph = Boolean(tone.glyph) && innerCap > GLYPH_CELLS + 4;
  const labelCap = Math.max(1, showGlyph ? innerCap - GLYPH_CELLS : innerCap);
  const label = fitTuiText(frame.message, labelCap);
  const labelWidth = Math.max(1, Math.min(labelCap, label.length));
  const innerWidth = labelWidth + (showGlyph ? GLYPH_CELLS : 0);
  const boxWidth = innerWidth + CHROME_CELLS;

  // The envelope's `progress` is available for the caller to key motion off;
  // OpenTUI has no per-cell opacity, so the fade reads through colour — a
  // fully-in pill wears its tone's chrome, the ramp phases dim to MUTED.
  const chrome = frame.phase === "hold" ? tone.color : theme.MUTED;

  return (
    <box
      position="absolute"
      {...edges(placement, margin)}
      width={boxWidth}
      height={3}
      flexShrink={0}
      flexGrow={0}
      minWidth={0}
      backgroundColor={theme.PANEL_ALT}
      paddingX={2}
      paddingY={1}
      zIndex={zIndex}
    >
      <box flexDirection="row" width={innerWidth} height={1} flexShrink={0} minWidth={0}>
        {showGlyph ? (
          <text width={GLYPH_CELLS} height={1} flexShrink={0} wrapMode="none" truncate fg={chrome}>{`${tone.glyph} `}</text>
        ) : null}
        <text width={labelWidth} height={1} flexShrink={0} wrapMode="none" truncate fg={theme.TEXT}>{label}</text>
      </box>
    </box>
  );
}

/** Repaint cadence while a toast animates (~30fps). */
const TICK_MS = 33;

export interface UseToastResult {
  /**
   * Raise a toast with `message`; resets the envelope if one is showing.
   * `tone` is optional and has no default — omit it and the pill is neutral.
   */
  showToast: (message: string, tone?: ToastTone) => void;
  /** The current frame — feed straight to `<Toast frame={...} />`. */
  frame: ToastFrame;
}

/**
 * Stateful toast driver. Owns the current show record and a ticker that
 * re-renders while the toast is on screen (and stops once it is gone). Under
 * `reduceMotion` it holds still and schedules a single dismissal instead of
 * ticking.
 *
 * Wiring, from chat-screen:
 *
 *   const { showToast, frame } = useToast();
 *   useSelectionCopy({ emit, onCopied: ({ bytes }) => showToast(`Copied ${bytes} bytes`) });
 *   // ...render tree...
 *   <Toast frame={frame} />
 */
export function useToast(config: ToastConfig = {}): UseToastResult {
  const [show, setShow] = useState<ToastShow | null>(null);
  // A dummy counter whose only job is to force a re-render on each tick so the
  // frame is recomputed against a fresh `Date.now()`.
  const [, forceTick] = useState(0);

  // Keep config stable-by-value so the effect below does not thrash. Callers
  // typically pass a literal each render; memo on its serialised shape.
  const configRef = useRef(config);
  configRef.current = config;

  const showToast = useCallback((message: string, tone?: ToastTone) => {
    setShow(makeShow(message, Date.now(), tone));
  }, []);

  useEffect(() => {
    if (!show) return;
    const cfg = configRef.current;

    if (cfg.reduceMotion) {
      // No animation to run: hold still, then dismiss once.
      const remaining = Math.max(0, show.shownAt + toastDurationMs(cfg) - Date.now());
      const id = setTimeout(() => setShow((cur) => (cur === show ? null : cur)), remaining);
      return () => clearTimeout(id);
    }

    const id = setInterval(() => {
      if (isToastDone(show, Date.now(), configRef.current)) {
        setShow((cur) => (cur === show ? null : cur));
      } else {
        forceTick((t) => (t + 1) % 1_000_000);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [show]);

  // Computed fresh every render (each tick forces one) so the frame tracks the
  // wall clock — no memo, which would pin it to a stale `Date.now()`.
  const frame = toastFrameAt(show, Date.now(), configRef.current);

  return { showToast, frame };
}
