/**
 * Pure layout for the inter-agent MESSAGE CARD — the directional-card
 * rendering of peer/operator/sibling traffic, ported from oh-my-pi's
 * `createIrcMessageCard` (`tools/hub/messaging.ts`).
 *
 * OMP builds three custom-message cards — `irc:incoming`, `irc:autoreply`,
 * `irc:relay` — each a directional-glyph header (`IRC ⟵ from`, `IRC ➤ to`,
 * `IRC from ➤ to`) + meta chips (`auto` / `reply` / age) + a quote-bordered,
 * collapsible body. We already carry the same data (a `PeerMessagePayload`
 * crossing the hub, resolved to display names on a `peer` {@link ChatEntry}),
 * but render it as one plain `» from → to  body` line. This module holds the
 * *pure* half of the card: kind + direction derivation, header composition,
 * meta chips, age formatting, bounded body wrapping, delivery badges, and the
 * adapters that turn our message data into card props. The React shell in
 * `MessageCard.tsx` only colours and boxes what these helpers decide, so the
 * whole thing is assertable without a renderer (see `message-card-layout.test.ts`).
 *
 * Everything here is pure: no clock (callers inject `now`), no theme, no
 * filesystem. Bodies and names are UNTRUSTED (authored by another agent); the
 * component sanitizes on the way to the screen — these helpers only shape.
 */

import { wrapText } from "../text.js";
import type { ChatEntry } from "./types.js";

/**
 * Which channel a message crossed, mapped to the card's visual identity. Wider
 * than the bus's `"peer" | "operator" | "broadcast"` because a peer send whose
 * endpoints are both non-root reads as `sibling` (child↔child), the case OMP
 * surfaces as its `irc:relay` card.
 */
export type MessageKind = "peer" | "operator" | "sibling" | "broadcast";

/** How the header reads: an arrival, a send from here, or an observed relay. */
export type MessageDirection = "incoming" | "outgoing" | "relay";

/** A `#RRGGBB`-ish literal from the bus's SendResult, when a caller has one. */
export interface DeliveryReceipt {
  /** Recipient roster id / display name. */
  to: string;
  /** Did the message land? Mirrors the mailbox `SendResult.ok`. */
  ok: boolean;
  /** Machine-readable failure reason when `!ok`. */
  reason?: string;
}

/**
 * The minimal message shape both adapters accept — a structural subset of the
 * bus `PeerMessagePayload` and the mailbox `HubMessage`, declared locally so
 * this module stays self-contained (no `@0sec/core` import).
 */
export interface PeerMessageLike {
  from: string;
  to: string;
  body: string;
  ts: number;
  /** Bus channel, when known. Absent → derived purely from the endpoints. */
  kind?: "peer" | "operator" | "broadcast";
  /** Id of the message this one answers, when it is a reply. */
  replyTo?: string;
}

/** Fully-derived, render-ready card props. The adapters' output. */
export interface MessageCardData {
  kind: MessageKind;
  direction: MessageDirection;
  from: string;
  to: string;
  body: string;
  /** Relative age string ("12s" / "4m" / "2h"), or "" when unknown. */
  age: string;
  /** Meta chips, in render order (kind, reply, age). */
  chips: string[];
  /** Per-recipient delivery badges for a broadcast/send, when a caller has them. */
  delivery?: DeliveryReceipt[];
  isReply: boolean;
}

/** The roster id the local console renders as. Endpoints matching it are "me". */
export const SELF_ID = "Main";
/** Broadcast recipient sentinel, mirroring the bus + mailbox `BROADCAST_ID`. */
export const BROADCAST_ID = "all";
/** How a broadcast recipient reads in the header. */
export const BROADCAST_LABEL = "#all";

/** Direction glyphs. One terminal cell each; no theme symbol lookup needed. */
export const GLYPH_INCOMING = "←";
export const GLYPH_OUTGOING = "→";
/** Lead marker for the header, matching the existing plain peer line's `»`. */
export const GLYPH_LEAD = "»";

/** Collapsed / expanded body line budgets, mirroring OMP's 3 / 12. */
export const BODY_LINES_COLLAPSED = 3;
export const BODY_LINES_EXPANDED = 12;

/**
 * Classify a message into a {@link MessageKind}. An explicit bus `kind` wins
 * for `operator` and `broadcast`; a `peer` send is refined to `sibling` when
 * neither endpoint is the root console (child↔child), which is the traffic OMP
 * shows as a relay observation. With no `kind`, the endpoints decide.
 */
export function messageKind(msg: PeerMessageLike, selfId: string = SELF_ID): MessageKind {
  if (msg.to === BROADCAST_ID || msg.kind === "broadcast") return "broadcast";
  if (msg.kind === "operator") return "operator";
  const touchesRoot = msg.from === selfId || msg.to === selfId;
  if (!touchesRoot) return "sibling";
  return "peer";
}

/**
 * Which way the header points, from the local console's vantage. An arrival
 * addressed to us is `incoming` (`← from`); a send from us is `outgoing`
 * (`→ to`); anything between two other agents is a `relay` we observe
 * (`from → to`). Broadcasts are always outgoing-shaped (`from → #all`).
 */
export function messageDirection(msg: PeerMessageLike, selfId: string = SELF_ID): MessageDirection {
  if (msg.to === BROADCAST_ID || msg.kind === "broadcast") return "outgoing";
  if (msg.to === selfId) return "incoming";
  if (msg.from === selfId) return "outgoing";
  return "relay";
}

/** A header segment carrying its own role, so the component can colour each. */
export interface HeaderSegment {
  text: string;
  /** `from`/`to` take the peer accent; `glyph`/`arrow` are chrome (muted). */
  role: "lead" | "glyph" | "from" | "arrow" | "to";
  /** The raw peer id behind a `from`/`to` segment, for `agentAccentFor`. */
  peerId?: string;
}

/**
 * Compose the directional header as coloured segments, faithful to OMP's three
 * forms:
 *   - incoming  → `» ← from`         (recipient is us; implicit)
 *   - outgoing  → `» → to`           (sender is us; implicit)
 *   - relay     → `» from → to`      (observed between two peers)
 * The lead `»` and the glyphs are chrome; `from`/`to` carry the peer id so the
 * caller can paint each name in its stable agent accent.
 */
export function composeHeader(data: {
  from: string;
  to: string;
  direction: MessageDirection;
}): HeaderSegment[] {
  const toLabel = data.to === BROADCAST_ID ? BROADCAST_LABEL : data.to;
  const segs: HeaderSegment[] = [{ text: GLYPH_LEAD, role: "lead" }];
  if (data.direction === "incoming") {
    segs.push({ text: GLYPH_INCOMING, role: "glyph" });
    segs.push({ text: data.from, role: "from", peerId: data.from });
    return segs;
  }
  if (data.direction === "outgoing") {
    segs.push({ text: GLYPH_OUTGOING, role: "glyph" });
    segs.push({ text: toLabel, role: "to", peerId: data.to === BROADCAST_ID ? undefined : data.to });
    return segs;
  }
  // relay: from → to
  segs.push({ text: data.from, role: "from", peerId: data.from });
  segs.push({ text: GLYPH_OUTGOING, role: "arrow" });
  segs.push({ text: toLabel, role: "to", peerId: data.to === BROADCAST_ID ? undefined : data.to });
  return segs;
}

/** Flatten header segments to a single plain line (fallback / compact / tests). */
export function headerText(segments: HeaderSegment[]): string {
  return segments.map((s) => s.text).join(" ");
}

/**
 * Meta chips, in OMP's order: the kind word, a `reply` marker when this answers
 * another message, then the relative age. Empty entries are dropped so the
 * component never renders a dangling separator.
 */
export function metaChips(data: { kind: MessageKind; isReply: boolean; age: string }): string[] {
  const chips: string[] = [data.kind];
  if (data.isReply) chips.push("reply");
  if (data.age) chips.push(data.age);
  return chips;
}

/**
 * Compact relative age — "12s" / "4m" / "2h" — byte-for-byte the transcript's
 * own `relativeAge`, so a message card and the plain peer line agree. Returns
 * "" for a missing/zero timestamp (a restored entry) so the caller omits it.
 */
export function formatMessageAge(ts: number | undefined, now: number): string {
  if (!ts) return "";
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** One wrapped body line, plus the terminal "… +N more lines" overflow row. */
export interface BodyLine {
  text: string;
  /** `overflow` rows are the muted elision counter, not message content. */
  kind: "body" | "overflow";
}

/**
 * Wrap a body to `width` and cap it at the collapsed/expanded budget, appending
 * a `… +N more lines` overflow row when content is hidden — OMP's quote-bordered
 * preview, minus the quote glyph (the card supplies its own left gutter). Blank
 * lines are dropped first, matching OMP's `filter(line => line.trim())` count.
 */
export function boundBodyLines(
  body: string,
  width: number,
  options: { expanded?: boolean; collapsedLines?: number; expandedLines?: number } = {},
): BodyLine[] {
  const cap = options.expanded
    ? (options.expandedLines ?? BODY_LINES_EXPANDED)
    : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
  const limit = Math.max(1, Math.trunc(cap));
  const cells = Math.max(1, Math.trunc(Number.isFinite(width) ? width : 0));
  // Wrap paragraph by paragraph so an authored newline is honoured, then drop
  // the blank rows a double newline produces (OMP counts non-empty lines only).
  const wrapped: string[] = [];
  for (const paragraph of body.split("\n")) {
    if (!paragraph.trim()) continue;
    for (const line of wrapText(paragraph, cells)) {
      if (line.trim()) wrapped.push(line);
    }
  }
  if (wrapped.length === 0) return [];
  const shown = wrapped.slice(0, limit);
  const hidden = wrapped.length - shown.length;
  const lines: BodyLine[] = shown.map((text) => ({ text, kind: "body" as const }));
  if (hidden > 0) {
    lines.push({ text: `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`, kind: "overflow" });
  }
  return lines;
}

/** Short badge label for one delivery receipt ("delivered" / "failed"). */
export function deliveryBadgeLabel(receipt: DeliveryReceipt): string {
  return receipt.ok ? "delivered" : receipt.reason ? `failed: ${receipt.reason}` : "failed";
}

/**
 * Fold a broadcast's receipts into a one-line summary chip, e.g. "3 delivered"
 * or "2 delivered · 1 failed" — OMP's `renderSendResult` delivered/failed
 * counts. Returns "" when there is nothing to report.
 */
export function summarizeDelivery(delivery: readonly DeliveryReceipt[] | undefined): string {
  if (!delivery || delivery.length === 0) return "";
  const delivered = delivery.filter((r) => r.ok).length;
  const failed = delivery.length - delivered;
  const parts: string[] = [];
  if (delivered > 0) parts.push(`${delivered} delivered`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/**
 * Adapter: raw bus/mailbox message → {@link MessageCardData}. `resolveName`
 * maps a roster id to its display name (default: identity); `selfId` is the id
 * the local console renders as ("Main"). Pure aside from the injected `now`.
 */
export function messageCardFromPayload(
  msg: PeerMessageLike,
  options: { now: number; selfId?: string; resolveName?: (id: string) => string } = { now: Date.now() },
): MessageCardData {
  const selfId = options.selfId ?? SELF_ID;
  const name = options.resolveName ?? ((id: string) => id);
  const kind = messageKind(msg, selfId);
  const direction = messageDirection(msg, selfId);
  const from = name(msg.from);
  const to = msg.to === BROADCAST_ID ? BROADCAST_ID : name(msg.to);
  const age = formatMessageAge(msg.ts, options.now);
  const isReply = Boolean(msg.replyTo);
  return {
    kind,
    direction,
    from,
    to,
    body: msg.body ?? "",
    age,
    chips: metaChips({ kind, isReply, age }),
    isReply,
  };
}

/**
 * Adapter: a resolved `peer` {@link ChatEntry} (the transcript's current form —
 * `peerFrom`/`peerTo` already display names, `text` the body) → card props.
 * This is the mount adapter for the transcript: the entry has been through
 * `chat-screen`'s name resolution, so no `resolveName` is needed. A `peerTo`
 * of `"all"`/`"#all"` is treated as the broadcast sentinel.
 */
export function messageCardFromPeerEntry(
  entry: Pick<ChatEntry, "peerFrom" | "peerTo" | "text" | "at">,
  options: { now: number; selfId?: string; delivery?: DeliveryReceipt[] } = { now: Date.now() },
): MessageCardData {
  const rawTo = entry.peerTo ?? "?";
  const to = rawTo === BROADCAST_LABEL || rawTo === BROADCAST_ID ? BROADCAST_ID : rawTo;
  const data = messageCardFromPayload(
    { from: entry.peerFrom ?? "?", to, body: entry.text ?? "", ts: entry.at ?? 0 },
    { now: options.now, selfId: options.selfId },
  );
  if (options.delivery) data.delivery = options.delivery;
  return data;
}
