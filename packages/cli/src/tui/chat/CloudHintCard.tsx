/** @jsxImportSource @opentui/react */
/**
 * The getting-started card that sits at the BOTTOM of the right sidebar,
 * beneath the AGENTS / FINDINGS / PLAN sections.
 *
 * Modelled on OpenCode's sidebar footer: a short, dismissible offer to connect
 * an account, shown only while there is genuinely nothing connected, pinned
 * below the scrolling sections rather than competing with them for rows.
 *
 * Three properties are load-bearing and deliberately narrow:
 *
 * 1. **Dismissal is session-scoped, and the state lives in the HOST.** The card
 *    is deliberately stateless: `dismissed` and `onDismiss` are required props
 *    held by the persistent chat screen, not local `useState`. That is not a
 *    style preference — the right sidebar can be hidden and reopened, which
 *    unmounts and remounts this card, and local state would resurrect a card
 *    the operator already dismissed. There is still no new setting, no new
 *    store and no schema change; the upstream project persists this in a
 *    key-value store and that is explicitly NOT a licence for us to add one.
 *
 * 2. **It is mouse-driven only, with no keyboard handler at all.** The composer
 *    sits directly below this column and a dialog may sit above it. A card that
 *    claimed a key would either steal a keystroke from the operator's prompt or
 *    fight the top dialog for it, so it claims none: both the action and the
 *    dismiss are `onMouseDown`, exactly as the findings rows already are.
 *
 * 3. **It never authenticates on its own.** The action invokes the host's
 *    existing connect route and stops there. No token is read, no request is
 *    made, and nothing about the operator's provider or model choice changes —
 *    a BYOK operator who is happy with their own key sees an offer, never a
 *    migration.
 *
 * The card also never claims a state it has not been told about: it renders
 * only when the host reports, from real connection context, that nothing is
 * connected. "Unknown" is not "disconnected", so an unknown state shows nothing.
 */

import React from "react";

import { fitTuiText } from "../text.js";
import type { Theme } from "../theme-context.js";
import { useSymbols } from "../symbol-context.js";
import { operatorIcon } from "../operator-icons.js";
import { wrapCells } from "./todos-sidebar-layout.js";

/** Rows the card needs at minimum: the title line alone. */
export const CLOUD_HINT_MIN_ROWS = 1;

/** The widest the card will ever draw, so a wide sidebar does not stretch prose. */
const MAX_BODY_LINES = 2;

const TITLE = "0cloud";
const BODY = "Connect an account to run audits on hosted models.";
const ACTION = "Connect";
const DISMISS = "✕";

/**
 * Whether the offer applies at all, from facts the host actually holds.
 *
 * `hostedConnected` is tri-state ON PURPOSE. `undefined` means the host has not
 * established the connection context yet — during that window the honest
 * output is nothing, because showing "connect your account" to someone who is
 * already connected is exactly the false claim this card must never make.
 * Only a definite `false` is an invitation.
 */
export function shouldOfferCloudHint(input: {
  /** True/false once real connection context is known; undefined while it is not. */
  hostedConnected: boolean | undefined;
  /** Rows the sidebar can actually spare for the card. */
  rows: number;
  /** Inner content width of the sidebar column. */
  width: number;
}): boolean {
  if (input.hostedConnected !== false) return false;
  return input.rows >= CLOUD_HINT_MIN_ROWS && input.width >= 8;
}

export function CloudHintCard({
  hostedConnected,
  width,
  rows,
  theme,
  dismissed,
  onDismiss,
  onConnect,
}: {
  /**
   * Real connection context from the host. `undefined` while unknown — the
   * card stays hidden rather than guessing.
   */
  hostedConnected: boolean | undefined;
  /** Inner content width of the sidebar column, in cells. */
  width: number;
  /** Rows the sidebar has granted this card. The card never exceeds them. */
  rows: number;
  theme: Theme;
  /**
   * Whether the operator has already dismissed the offer this session. Held by
   * the host so it survives the sidebar being hidden and reopened.
   */
  dismissed: boolean;
  /** Record the dismissal in the host's session state. */
  onDismiss: () => void;
  /**
   * Open the host's EXISTING connect/auth route. This component performs no
   * authentication itself and reads no credential.
   */
  onConnect: () => void;
}) {
  const symbols = useSymbols();
  if (dismissed) return null;
  if (!shouldOfferCloudHint({ hostedConnected, rows, width })) return null;

  const inner = Math.max(1, Math.floor(width));
  const budget = Math.max(CLOUD_HINT_MIN_ROWS, Math.floor(rows));
  const { TEXT, MUTED, ACCENT, BORDER } = theme;

  // The title row carries the glyph, the label and the dismiss affordance. The
  // dismiss is dropped before the label is, so a very narrow column still says
  // what the card is rather than showing a bare ✕.
  const glyph = operatorIcon("connect", symbols);
  const dismissCells = DISMISS.length + 1;
  const titleRoom = inner - glyph.length - 1;
  const showDismiss = titleRoom - dismissCells >= 4;
  const titleText = fitTuiText(TITLE, Math.max(1, showDismiss ? titleRoom - dismissCells : titleRoom));

  // Whatever rows remain after the title go to the body, then the action. Both
  // are optional: the card degrades to its title alone rather than overflowing.
  // A repeated rule, not a partial box border: every bordered box in this TUI
  // passes `border` as a boolean, so a per-edge border array is unproven here
  // and this column cannot afford an experiment that paints through the
  // sections above it.
  let remaining = budget - 1;
  const ruleRows = remaining > 0 ? 1 : 0;
  remaining -= ruleRows;
  const actionRows = remaining > 0 ? 1 : 0;
  remaining -= actionRows;
  const bodyLines = remaining > 0
    ? wrapCells(BODY, inner, Math.min(MAX_BODY_LINES, remaining))
    : [];

  return (
    <box flexDirection="column" width={inner} flexShrink={0}>
      {ruleRows === 1 ? <text flexShrink={0} fg={BORDER}>{"─".repeat(inner)}</text> : null}
      <box flexDirection="row" width={inner} flexShrink={0}>
        <text flexShrink={0} fg={ACCENT}>{`${glyph} `}</text>
        <text flexShrink={0} fg={TEXT}>{titleText}</text>
        {showDismiss ? (
          <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" justifyContent="flex-end">
            <text
              flexShrink={0}
              fg={MUTED}
              onMouseDown={onDismiss}
            >
              {DISMISS}
            </text>
          </box>
        ) : null}
      </box>
      {bodyLines.map((line, index) => (
        <text key={`body-${index}`} flexShrink={0} fg={MUTED}>{line}</text>
      ))}
      {actionRows === 1 ? (
        <text flexShrink={0} fg={ACCENT} onMouseDown={onConnect}>
          {fitTuiText(`${ACTION} →`, inner)}
        </text>
      ) : null}
    </box>
  );
}
