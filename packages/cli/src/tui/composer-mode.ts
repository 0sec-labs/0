/**
 * Autonomy-mode cycling and the bottom status bar's shared mode hint.
 *
 * The current mode and its Shift+Tab shortcut are handled directly by the
 * keyboard handler. The mode stays visible at the bottom of both the startup
 * and conversation surfaces, independently of optional telemetry.
 *
 * WHO OWNS THE KEY. Not this module. `chat-screen.tsx` keeps the single
 * inline Shift+Tab handler and calls {@link isAutonomyCycleKey} and
 * {@link nextAutonomyMode} from it. That is deliberate: opentui fans a
 * keypress out to every live handler with no way to stop propagation, so a
 * second handler here would advance the mode twice per press. This module
 * therefore exports the *decision* functions and registers no keyboard
 * handler of its own.
 *
 * AUTHORITY. Nothing here changes what a mode MEANS or who may grant it. The
 * cycle is a pure function over the existing `ConsoleAutonomyMode` union from
 * `@0/core`; applying it is the chat screen's job. This module never calls
 * `setAutonomyMode`.
 */
import type { ConsoleAutonomyMode } from "@0/core";
import { modeLabel } from "./chat/helpers.js";

/**
 * The complete supported set, in the order Shift+Tab walks it.
 *
 * This is the existing `ConsoleAutonomyMode` union (`core/console/turn-engine.ts`)
 * in the existing cycle order documented on the `autonomy.cycle-mode` binding
 * (`keybindings.ts`): Standard → Co-pilot → YOLO → Recon. It is NOT a new
 * enumeration and must never gain, lose or reorder a member independently —
 * the `satisfies` clause below is what makes a drift in the core union a type
 * error here rather than a silently short cycle.
 */
export const AUTONOMY_CYCLE = ["standard", "copilot", "yolo", "recon"] as const satisfies readonly ConsoleAutonomyMode[];

/** Compile-time proof that AUTONOMY_CYCLE covers the union exhaustively. */
type CycleMember = (typeof AUTONOMY_CYCLE)[number];
type _CycleIsExhaustive = ConsoleAutonomyMode extends CycleMember ? true : never;
const _cycleIsExhaustive: _CycleIsExhaustive = true;
void _cycleIsExhaustive;

/**
 * The mode one Shift+Tab away, wrapping at the end.
 *
 * A mode outside the cycle cannot occur through the union, but an untyped
 * value crossing a boundary (a persisted session, a plugin) would land at
 * index -1; that resolves to the first member rather than throwing, so a
 * stale value self-heals on the next press instead of wedging the key.
 */
export function nextAutonomyMode(mode: ConsoleAutonomyMode): ConsoleAutonomyMode {
  const at = AUTONOMY_CYCLE.indexOf(mode as CycleMember);
  return AUTONOMY_CYCLE[(at + 1) % AUTONOMY_CYCLE.length] ?? AUTONOMY_CYCLE[0];
}

/** The chord as the status bar spells it, matching the `keybindings.ts` entry. */
export const AUTONOMY_CYCLE_CHORD = "Shift+Tab";

/** The parenthetical mode hint: "(Shift+Tab to cycle)". */
export const AUTONOMY_CYCLE_HINT = `(${AUTONOMY_CYCLE_CHORD} to cycle)`;

/**
 * The mode segment as one plain string. Empty when there is no mode to report:
 * an absent mode must render nothing, never a plausible-looking default.
 */
export function autonomyFooterText(mode: ConsoleAutonomyMode | null | undefined): string {
  if (!mode) return "";
  return `${modeLabel(mode)} ${AUTONOMY_CYCLE_HINT}`;
}

/**
 * Is this keypress the composer's mode-cycle chord?
 *
 * Deliberately strict. `key.shift` alone is not enough: a Ctrl/Meta/Alt-
 * modified Tab is somebody else's chord (and plain Tab is the slash-menu
 * completion), so anything carrying another modifier is declined here rather
 * than swallowed.
 */
export function isAutonomyCycleKey(key: {
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
}): boolean {
  if (key.name !== "tab") return false;
  if (!key.shift) return false;
  return !key.ctrl && !key.meta && !key.option;
}
