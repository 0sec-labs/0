/** @jsxImportSource @opentui/react */
/**
 * MessageCard — the OMP-style directional card for an inter-agent message.
 *
 * A faithful port of oh-my-pi's `createIrcMessageCard` to our OpenTUI/React
 * stack: a bordered card whose first row is a directional header
 * (`» ← from`, `» → to`, or `» from → to`) with each peer name painted in its
 * stable agent accent (`agentAccentFor`), a muted row of meta chips
 * (kind · reply · age), then a bounded, collapsible body. Broadcasts add a
 * per-recipient delivery-badge row when the caller supplies receipts.
 *
 * Where OMP draws with ANSI + `renderStatusLine`, we lay out coloured `<text>`
 * segments so each name keeps its own hue (a box `title` can only take one
 * colour). All shaping — kind, direction, header segments, chips, body caps —
 * comes from `message-card-layout.ts`; this shell only colours and boxes what
 * those pure helpers decide. Bodies and names are UNTRUSTED (authored by
 * another agent) and are run through `sanitizeTuiText` before they reach the
 * screen.
 *
 * Mirrors `ToolCard`'s bordered-box idiom (rounded border, `PANEL` fill,
 * `paddingX`, the `commandCardFrame` width math, and the `expanded`/`toggleable`
 * collapse affordance with `TOOL_EXPAND_KEY`). Falls back to the existing plain
 * `» from → to  body` single line when the width is too small for a card.
 */

import React from "react";
import { TextAttributes } from "@opentui/core";

import { agentAccentFor } from "../agent-color.js";
import { KEYBINDINGS } from "../keybindings.js";
import { fitTuiText, sanitizeTuiText } from "../text.js";
import { commandCardFrame } from "../transcript-style.js";
import type { Theme } from "../theme-context.js";
import {
  type MessageCardData,
  boundBodyLines,
  composeHeader,
  deliveryBadgeLabel,
  headerText,
} from "./message-card-layout.js";

/** Keybinding hint for expanding a card, reused from the tool cards. */
const MESSAGE_EXPAND_KEY = KEYBINDINGS.find((binding) => binding.id === "view.transcript-detail")?.keys;

export interface MessageCardProps {
  /** Fully-derived card props (from a `message-card-layout` adapter). */
  data: MessageCardData;
  /** Cell budget for the whole card. It never draws wider than this. */
  width: number;
  theme: Theme;
  /** Top margin between transcript rows. */
  spacing?: number;
  /** True when the body is fully expanded (all retained lines). */
  expanded?: boolean;
  /** True when a click can toggle this row, so the hint can say so. */
  toggleable?: boolean;
}

/** Accent for a header name segment; broadcast/unknown ids fall to muted. */
function segmentColor(role: string, peerId: string | undefined, theme: Theme): string {
  if ((role === "from" || role === "to") && peerId) return agentAccentFor(peerId, theme.CANVAS);
  return theme.MUTED;
}

export function MessageCard({
  data,
  width,
  theme,
  spacing = 1,
  expanded = false,
  toggleable = false,
}: MessageCardProps): React.ReactNode {
  const { TEXT, MUTED, PANEL, BORDER, SUCCESS, ERROR } = theme;
  const segments = composeHeader(data);
  const chipsLine = data.chips.join("  ·  ");

  const frame = commandCardFrame(width);

  // Degrade to the existing plain one-liner when the terminal is too narrow for
  // a card (mirrors ToolCard's compact fallback, and matches what the peer
  // entry rendered before this card existed).
  if (!frame.render) {
    const plain = `${headerText(segments)}  ${sanitizeTuiText(data.body)}`;
    return (
      <box flexDirection="column" width={Math.max(1, width)} flexShrink={0} minWidth={0} marginTop={spacing}>
        <text width={Math.max(1, width)} height={1} wrapMode="none" truncate fg={TEXT}>
          {fitTuiText(plain, Math.max(1, width))}
        </text>
      </box>
    );
  }

  const inner = frame.innerWidth;
  const bodyLines = boundBodyLines(sanitizeTuiText(data.body), inner, { expanded });
  const expandHint =
    toggleable && !expanded ? ` · click${MESSAGE_EXPAND_KEY ? ` or ${MESSAGE_EXPAND_KEY}` : ""} to expand` : "";

  return (
    <box
      flexDirection="column"
      width={frame.outerWidth}
      flexShrink={0}
      minWidth={0}
      marginTop={spacing}
      border
      borderStyle="rounded"
      borderColor={BORDER}
      backgroundColor={PANEL}
      paddingX={1}
    >
      {/* Directional header: glyphs muted, each peer name in its agent accent. */}
      <box flexDirection="row" width={inner} height={1} flexShrink={0} minWidth={0}>
        {segments.map((seg, index) => (
          <text
            key={`h-${index}`}
            flexShrink={0}
            fg={segmentColor(seg.role, seg.peerId, theme)}
            attributes={seg.role === "from" || seg.role === "to" ? TextAttributes.BOLD : undefined}
          >
            {`${index === 0 ? "" : " "}${sanitizeTuiText(seg.text)}`}
          </text>
        ))}
      </box>

      {/* Meta chips: kind · reply · age. */}
      {chipsLine ? (
        <box flexDirection="row" width={inner} height={1} flexShrink={0} minWidth={0}>
          <text fg={MUTED} wrapMode="none" truncate>{fitTuiText(chipsLine, inner)}</text>
        </box>
      ) : null}

      {/* Body: bounded + collapsible, matching OMP's quote-preview budget. */}
      {bodyLines.length > 0 ? (
        <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
          {bodyLines.map((line, index) => (
            <text
              key={`b-${index}`}
              fg={line.kind === "overflow" ? MUTED : TEXT}
              wrapMode="none"
              truncate
            >
              {fitTuiText(line.text, inner)}
            </text>
          ))}
        </box>
      ) : null}

      {/* Delivery badges for a broadcast/send, when receipts were supplied. */}
      {data.delivery && data.delivery.length > 0 ? (
        <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
          {data.delivery.map((receipt, index) => (
            <box key={`d-${index}`} flexDirection="row" width={inner} height={1} flexShrink={0} minWidth={0}>
              <text flexShrink={0} fg={receipt.ok ? SUCCESS : ERROR}>
                {fitTuiText(
                  `${receipt.ok ? "✓" : "✗"} ${sanitizeTuiText(receipt.to)} ${deliveryBadgeLabel(receipt)}`,
                  inner,
                )}
              </text>
            </box>
          ))}
        </box>
      ) : null}

      {expandHint ? (
        <box flexDirection="row" width={inner} height={1} flexShrink={0} minWidth={0}>
          <text fg={MUTED} wrapMode="none" truncate>{fitTuiText(expandHint.replace(/^ · /, ""), inner)}</text>
        </box>
      ) : null}
    </box>
  );
}
