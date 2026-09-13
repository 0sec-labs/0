/**
 * Pure layout + data shaping for the AGENTS COMMS view — the live multi-agent
 * "comms" surface that shows the fleet of sub-agents AND the messages flowing
 * between them (agent↔agent, agent↔operator) at a glance.
 *
 * This is `agents-comms-screen.tsx`'s pure half, following the precedent set by
 * `herd-layout.ts` / `settings-layout.ts`: every number the screen renders with
 * is computed here, where a property sweep can hammer it across widths 0..200
 * and heights 0..80. The reason (spelled out in `PRIMITIVES.md`) is that Yoga
 * *shrinks* siblings rather than clipping them, so a region that claims one row
 * too many paints its border through its own content — invisible until someone
 * resizes a terminal, which is why the arithmetic lives somewhere a sweep can
 * reach.
 *
 * ## What this view is over — and its truthfulness rule
 *
 * TWO real data sources, joined by `agent_id`, and NOTHING invented:
 *
 *   1. The FLEET — the live subagent map the console already maintains
 *      (`HerdSubagentMap`, fed by the `subagent_lifecycle` / `subagent_progress`
 *      bus reducers). Every stat rendered on a fleet row is a field that record
 *      actually carries (status, turns, current tool, findings, last-seen age),
 *      optionally enriched with MEASURED telemetry (`usage` tokens, `durationMs`)
 *      from the lifecycle payload. A stat that was never reported is OMITTED,
 *      never zero-filled — the same truthfulness rule the agent-display code and
 *      `herd-layout` follow.
 *
 *   2. The MESSAGE STREAM — the `peer_message` bus events, the moment each
 *      inter-agent message is sent. Each is rendered with the directional
 *      `MessageCard` idiom (from → to, kind chip, age, body, delivery badges)
 *      via the shared `message-card-layout` helpers.
 *
 * Everything here is pure: no clock (callers inject `now`), no theme, no
 * filesystem, no bus. Bodies / names / tool names are UNTRUSTED (authored by
 * another agent); the component sanitizes on the way to the screen — these
 * helpers only shape and are asserted without a renderer (see the test).
 */

import { computeListWindow, type ListWindow } from "./pane-layout.js";
import { sanitizeTuiText } from "./text.js";
import { shellChromeRows } from "./herd-layout.js";
import type { HerdSubagentMap, HerdSubagentRecord, SubagentStatus } from "./herd-layout.js";
import {
  type MessageCardData,
  type PeerMessageLike,
  messageCardFromPayload,
  SELF_ID,
} from "./chat/message-card-layout.js";

// ---------------------------------------------------------------------------
// Numeric hygiene (mirrors herd-layout.ts / primitives.ts)
// ---------------------------------------------------------------------------

/** Non-negative integer cell/row count. NaN / fractional / negative → fallback→0. */
function cells(value: unknown, fallback = 0): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const truncated = Math.trunc(raw);
  return truncated > 0 ? truncated : 0;
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

// ---------------------------------------------------------------------------
// Fleet model — a truthful projection of the live subagent record
// ---------------------------------------------------------------------------

/**
 * MEASURED telemetry for one agent, keyed elsewhere by `agent_id`. Every field
 * is optional and, when present, was actually measured (the `usage` counts and
 * `durationMs` come off the `subagent_lifecycle` payload's `SubagentTelemetry`).
 * Absent → "not reported", so the stat line omits it rather than showing 0.
 */
export interface CommsAgentTelemetry {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  model?: string;
}

/** A telemetry map keyed by `agent_id`, mirroring `HerdSubagentMap`'s keys. */
export type CommsTelemetryMap = Record<string, CommsAgentTelemetry>;

/**
 * The render-ready fleet row: the roster record plus the one telemetry snapshot
 * joined to it. Kept as the raw record so the accent (`agentAccentFor(id)`) and
 * every stat are read from real fields at render time.
 */
export interface CommsFleetRow {
  readonly kind: "agent";
  readonly record: HerdSubagentRecord;
  readonly telemetry?: CommsAgentTelemetry;
}

/**
 * Fixed sort priority for the fleet: the agents an operator most wants to see
 * (actively running, then queued/parked/waiting) rise to the top, terminal ones
 * sink. Stable within a bucket, so the list does not reshuffle between polls.
 */
function statusRank(status: SubagentStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "parked":
      return 2;
    case "failed":
      return 3;
    default:
      return 4; // completed
  }
}

/**
 * Build the sorted fleet rows from the live subagent map and the telemetry map.
 * Preserves insertion order within a status bucket (a stable sort keyed only by
 * the status rank). Skips malformed records. Invents nothing — an empty map
 * yields an empty fleet, which the screen states honestly.
 */
export function buildCommsFleet(
  agents: Readonly<HerdSubagentMap>,
  telemetry: Readonly<CommsTelemetryMap> = {},
): CommsFleetRow[] {
  const rows: CommsFleetRow[] = [];
  for (const record of Object.values(agents)) {
    if (!record || typeof record.agentId !== "string") continue;
    const snap = telemetry[record.agentId];
    rows.push({ kind: "agent", record, ...(snap ? { telemetry: snap } : {}) });
  }
  // Stable sort: decorate with the original index so equal ranks keep order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => statusRank(a.row.record.status) - statusRank(b.row.record.status) || a.index - b.index)
    .map((entry) => entry.row);
}

/** Human status word for a fleet row (mirrors herd's subagentStatusLabel). */
export function commsStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "parked":
      return "parked";
    default:
      return "failed";
  }
}

/** A one-cell marker glyph per status, so state reads without colour. */
export function commsStatusMarker(record: HerdSubagentRecord): string {
  if (record.operatorStopped) return "■"; // operator-stopped: settled, not failed
  switch (record.status) {
    case "running":
      return "●";
    case "queued":
    case "parked":
      return "○";
    case "failed":
      return "✗";
    default:
      return "✓"; // completed
  }
}

/** The label column text: the agent's human name, else its id. */
export function commsFleetName(record: HerdSubagentRecord): string {
  const name = typeof record.name === "string" ? sanitizeTuiText(record.name) : "";
  if (name.length > 0) return name;
  return sanitizeTuiText(record.agentId);
}

/**
 * Compact token count — "1.2k" / "980" / "" — for a stat chip. Returns "" for a
 * missing or zero total so the caller drops the chip rather than showing "0 tok".
 */
export function formatTokens(total: number | undefined): string {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return "";
  const n = Math.trunc(total);
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * Compact elapsed duration — "4.2s" / "1m03s" / "2h" — for a stat chip. Returns
 * "" for a missing / non-positive duration so the caller omits it.
 */
export function formatElapsed(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Relative age of a peer's last heartbeat — mirrors herd's formatRelativeAge. */
export function commsRelativeAge(lastSeen: number | undefined, now: number): string {
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) return "";
  const ageMs = now - lastSeen;
  if (ageMs < 1000) return "now";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The truthful stat line for a fleet row: only fields that were actually
 * reported, joined by " · ". Order: status word, turns, current tool, findings,
 * measured tokens, measured elapsed, last-seen age. NOTHING is fabricated — an
 * agent with only a status shows only its status word.
 *
 * `turns` (the completed-turn count) is preferred over `turn`; a bare `turn`
 * (the in-flight index) falls back to it. The turn budget cap (`maxTurns`) is
 * deliberately NOT surfaced — it is an internal guardrail, not progress.
 */
export function commsFleetStatLine(row: CommsFleetRow, now: number): string {
  const { record, telemetry } = row;
  const parts: string[] = [];
  parts.push(record.operatorStopped ? "stopped" : commsStatusLabel(record.status));

  const turnValue = typeof record.turns === "number" ? record.turns : record.turn;
  if (typeof turnValue === "number" && Number.isFinite(turnValue)) {
    const t = Math.trunc(turnValue);
    parts.push(`${t} turn${t === 1 ? "" : "s"}`);
  }
  if (record.status === "running" && typeof record.tool === "string" && record.tool.length > 0) {
    parts.push(sanitizeTuiText(record.tool));
  }
  if (typeof record.findings === "number" && Number.isFinite(record.findings) && record.findings > 0) {
    const f = Math.trunc(record.findings);
    parts.push(`${f} finding${f === 1 ? "" : "s"}`);
  }
  const tokens = telemetry
    ? formatTokens((telemetry.inputTokens ?? 0) + (telemetry.outputTokens ?? 0))
    : "";
  if (tokens) parts.push(`${tokens} tok`);
  const elapsed = telemetry ? formatElapsed(telemetry.durationMs) : "";
  if (elapsed) parts.push(elapsed);

  const age = commsRelativeAge(record.lastSeen, now);
  // Only show age for a settled agent (a running one's "current tool"/turns say
  // more, and its heartbeat is by definition recent).
  if (age && (record.status === "completed" || record.status === "failed")) parts.push(age);

  return parts.join(" · ");
}

/** The role/task subtitle for a fleet row: the task it was spawned with. */
export function commsFleetTask(record: HerdSubagentRecord): string {
  return typeof record.task === "string" ? sanitizeTuiText(record.task) : "";
}

// ---------------------------------------------------------------------------
// Fleet navigation (a flat list — no headings)
// ---------------------------------------------------------------------------

/** Clamp an arbitrary index onto a valid fleet row, or -1 when the fleet is empty. */
export function clampFleetSelection(count: number, current: number): number {
  const total = cells(count);
  if (total === 0) return -1;
  return clamp(Math.trunc(Number.isFinite(current) ? current : 0), 0, total - 1);
}

/** Move the fleet selection by `delta`, wrapping. -1 when the fleet is empty. */
export function moveFleetSelection(count: number, current: number, delta: number): number {
  const total = cells(count);
  if (total === 0) return -1;
  const anchor = clampFleetSelection(total, current);
  const step = Math.trunc(Number.isFinite(delta) ? delta : 0);
  return ((anchor + step) % total + total) % total;
}

// ---------------------------------------------------------------------------
// Message stream — a bounded chronological log of peer_message events
// ---------------------------------------------------------------------------

/** How many messages the stream retains. Older ones drop off the head. */
export const COMMS_STREAM_MAX = 500;

/** One stored inter-agent message, structurally a `PeerMessageLike` + a seq. */
export interface CommsMessage extends PeerMessageLike {
  /** Monotonic arrival sequence, so a stable React key survives id collisions. */
  readonly seq: number;
}

/**
 * Fold one raw `peer_message` bus payload onto the chronological stream. Pure:
 * the arrival `seq` is injected (the caller keeps a monotonic counter). Returns
 * the SAME list when the payload is unusable (no string `from`/`to`), so a
 * malformed event never forces a repaint. Bounded at `max` — the newest tail is
 * kept, matching the bus emit order (a message is emitted the moment it is sent).
 */
export function applyCommsMessage(
  list: readonly CommsMessage[],
  payload: Record<string, unknown>,
  seq: number,
  max: number = COMMS_STREAM_MAX,
): CommsMessage[] {
  const from = typeof payload["from"] === "string" ? payload["from"] : undefined;
  const to = typeof payload["to"] === "string" ? payload["to"] : undefined;
  if (!from || !to) return list as CommsMessage[];
  const kindRaw = payload["kind"];
  const kind = kindRaw === "peer" || kindRaw === "operator" || kindRaw === "broadcast" ? kindRaw : undefined;
  const message: CommsMessage = {
    seq: Math.trunc(Number.isFinite(seq) ? seq : 0),
    from,
    to,
    body: typeof payload["body"] === "string" ? payload["body"] : "",
    ts: typeof payload["ts"] === "number" && Number.isFinite(payload["ts"]) ? payload["ts"] : 0,
    ...(kind ? { kind } : {}),
    ...(typeof payload["reply_to"] === "string" ? { replyTo: payload["reply_to"] } : {}),
  };
  const cap = Math.max(1, cells(max) || COMMS_STREAM_MAX);
  const next = [...list, message];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Adapter: a stored {@link CommsMessage} → directional {@link MessageCardData},
 * reusing the shared message-card derivation. `resolveName` maps a roster id to
 * its display name (default: identity); `selfId` is the id the local console
 * renders as ("Main").
 */
export function commsMessageCard(
  message: CommsMessage,
  options: { now: number; selfId?: string; resolveName?: (id: string) => string },
): MessageCardData {
  return messageCardFromPayload(message, {
    now: options.now,
    selfId: options.selfId ?? SELF_ID,
    ...(options.resolveName ? { resolveName: options.resolveName } : {}),
  });
}

/**
 * The messages touching one agent (as `from` OR `to`), matched on the raw
 * roster id. Used when the operator focuses an agent to filter the stream to
 * that agent's traffic. Preserves chronological order.
 */
export function filterMessagesForAgent(
  list: readonly CommsMessage[],
  agentId: string,
): CommsMessage[] {
  if (!agentId) return [...list];
  return list.filter((m) => m.from === agentId || m.to === agentId);
}

// ---------------------------------------------------------------------------
// "Who talks to whom" — directed edge counts per pair
// ---------------------------------------------------------------------------

export interface CommsEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

/**
 * Aggregate the stream into directed `from → to` edges with message counts,
 * sorted by count descending then alphabetically, so the busiest channel leads.
 * Pure counting over real messages — no edge is invented.
 */
export function computeCommsEdges(list: readonly CommsMessage[]): CommsEdge[] {
  const counts = new Map<string, number>();
  for (const m of list) {
    const key = `${m.from} ${m.to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const edges: CommsEdge[] = [];
  for (const [key, count] of counts) {
    const sep = key.indexOf(" ");
    edges.push({ from: key.slice(0, sep), to: key.slice(sep + 1), count });
  }
  return edges.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** A compact one-line label for an edge: "Explorer → Main ×4" (name-resolved). */
export function commsEdgeLabel(edge: CommsEdge, resolveName: (id: string) => string = (id) => id): string {
  return `${sanitizeTuiText(resolveName(edge.from))} → ${sanitizeTuiText(resolveName(edge.to))} ×${edge.count}`;
}

// ---------------------------------------------------------------------------
// Empty states + footer hints
// ---------------------------------------------------------------------------

/** Honest empty-fleet line — no delegated subagents are running. */
export const COMMS_EMPTY_FLEET_TEXT = "no subagents running";
/** Honest empty-stream line — no inter-agent messages observed this session. */
export const COMMS_EMPTY_STREAM_TEXT = "no messages between agents yet";

export function commsFooterHint(focused: boolean): string {
  return focused
    ? ["↑/↓ agents", "esc clear focus", "↑↓ scroll msgs", "ctrl+c exit"].join(" · ")
    : ["↑/↓ agents", "enter/click focus", "esc back", "ctrl+c exit"].join(" · ");
}

// ---------------------------------------------------------------------------
// Fleet row column split (marker · name · stat), summing to innerWidth
// ---------------------------------------------------------------------------

export interface CommsRowColumns {
  width: number;
  markerWidth: number;
  markerGap: number;
  /** Name column: a bounded share of the row. */
  nameWidth: number;
  statGap: number;
  /** Stat column: what the name leaves. 0 when the row can only afford a name. */
  statWidth: number;
}

/**
 * Split a fleet row into marker, name and stat columns using real Yoga gaps
 * (never padded literals — `fitTuiText` trims). The stat gives way before the
 * name: a row that can only fit "Explorer" still names the agent. Columns sum
 * to EXACTLY `innerWidth`.
 */
export function commsRowColumns(innerWidth: number): CommsRowColumns {
  const width = cells(innerWidth);
  if (width <= 0) return { width: 0, markerWidth: 0, markerGap: 0, nameWidth: 0, statGap: 0, statWidth: 0 };

  const markerWidth = width >= 6 ? 1 : 0;
  const markerGap = markerWidth > 0 && width > markerWidth ? 1 : 0;
  const afterMarker = Math.max(0, width - markerWidth - markerGap);

  // The stat column wants ~55% of the remaining width, but only when the row is
  // wide enough that a name and a stat can coexist.
  const statWidth = afterMarker >= 24 ? Math.floor(afterMarker * 0.55) : 0;
  const statGap = statWidth > 0 && afterMarker > statWidth ? 1 : 0;
  const nameWidth = Math.max(0, afterMarker - statWidth - statGap);
  return { width, markerWidth, markerGap, nameWidth, statGap, statWidth };
}

// ---------------------------------------------------------------------------
// Screen geometry — a fixed top FLEET region over a MAIN message STREAM
// ---------------------------------------------------------------------------

const SHELL_HORIZONTAL_PADDING = 2;
/** The dialog's own icon+title row, budgeted out of the body (mirrors herd). */
const HEADER_ROWS = 1;
/** Region borders cost 2 rows + a title row each when bordered. */
const BORDERED_MIN_ROWS = 14;
/** The fleet never eats more than this share of the body. */
const FLEET_MAX_SHARE = 0.5;
/** The edge summary is dropped below this body height. */
const SUMMARY_MIN_BODY_ROWS = 20;

export interface CommsLayoutInput {
  width: number;
  height: number;
  /** Number of fleet rows to be shown (used to size the fleet region). */
  fleetCount: number;
  /** 1 when a notice occupies a row above the footer. */
  noticeRows?: number;
  /** Whether the operator asked for the "who talks to whom" summary. */
  showSummary?: boolean;
  /**
   * Rows the HOST frame spends around this screen's body. Inside a
   * `DialogSurface` the shell renders with `dialogContent`: no outer header and
   * no padding, so the only row the host still spends is its one footer row.
   * Omit it and the legacy `shellChromeRows(width)` applies.
   */
  hostRows?: number;
  /** Cells the HOST frame pads on EACH side. A dialog pads none. */
  hostPaddingX?: number;
}

export interface CommsRegion {
  /** Outer rows, borders included. 0 when the region is not rendered. */
  height: number;
  /** Rows available to content below the title row. */
  bodyRows: number;
  /** Cells available to text inside the region. */
  innerWidth: number;
  hasTitle: boolean;
}

export interface CommsLayout {
  bordered: boolean;
  contentWidth: number;
  bodyRows: number;
  regionGap: number;
  fleet: CommsRegion;
  /** The optional "who talks to whom" region, between fleet and stream. */
  summary: CommsRegion;
  stream: CommsRegion;
  /** Fleet rows the fleet region can actually paint. */
  fleetVisibleRows: number;
  /** Edge lines the summary region can paint. */
  summaryVisibleRows: number;
}

function makeRegion(outerHeight: number, innerWidth: number, bordered: boolean): CommsRegion {
  const outer = cells(outerHeight);
  const chromeV = bordered ? 2 : 0;
  const titleRow = 1; // both regions always spend a title row
  const verticalChrome = chromeV + titleRow;
  if (outer <= verticalChrome || cells(innerWidth) <= 0) {
    return { height: 0, bodyRows: 0, innerWidth: 0, hasTitle: false };
  }
  return {
    height: outer,
    bodyRows: outer - verticalChrome,
    innerWidth: Math.max(0, cells(innerWidth) - (bordered ? 4 : 0)),
    hasTitle: true,
  };
}

/**
 * The full geometry: a fixed-height FLEET region on top and a MAIN message
 * STREAM region filling the rest, with an optional edge-summary region between
 * them. The fleet is sized to its own content (capped at {@link FLEET_MAX_SHARE}
 * of the body), the summary takes a small fixed slice when asked for and the
 * body is tall enough, and the stream takes every remaining row. All three
 * regions' outer heights sum to EXACTLY `bodyRows` (plus the inter-region gaps),
 * so nothing overflows and no border is painted through content.
 */
export function computeCommsLayout({
  width,
  height,
  fleetCount,
  noticeRows = 0,
  showSummary = false,
  hostRows,
  hostPaddingX,
}: CommsLayoutInput): CommsLayout {
  const terminalWidth = cells(width);
  const padding = hostPaddingX === undefined ? SHELL_HORIZONTAL_PADDING : cells(hostPaddingX);
  const chromeRows = hostRows === undefined ? shellChromeRows(terminalWidth) : cells(hostRows);
  const contentWidth = Math.max(0, terminalWidth - padding * 2);
  const bodyRows = Math.max(
    0,
    cells(height) - chromeRows - HEADER_ROWS - Math.min(1, cells(noticeRows)),
  );

  const bordered = bodyRows >= BORDERED_MIN_ROWS && contentWidth >= 40;
  const regionGap = bordered ? 0 : 1;
  const chromeV = bordered ? 2 : 0;

  // Nothing fits: report a single collapsed layout the screen degrades to.
  if (bodyRows <= 0 || contentWidth <= 0) {
    const empty: CommsRegion = { height: 0, bodyRows: 0, innerWidth: 0, hasTitle: false };
    return {
      bordered: false,
      contentWidth,
      bodyRows,
      regionGap: 0,
      fleet: empty,
      summary: empty,
      stream: empty,
      fleetVisibleRows: 0,
      summaryVisibleRows: 0,
    };
  }

  // Gaps between the regions: one below the fleet, one below the summary (only
  // when that region renders). Reserve them up front so the outer heights sum
  // cleanly.
  const wantSummary = showSummary && bodyRows >= SUMMARY_MIN_BODY_ROWS;
  const gapCount = regionGap * (wantSummary ? 2 : 1);
  const rowsForRegions = Math.max(0, bodyRows - gapCount);

  // Fleet: its own content height (title + a row per agent + border), capped at
  // half the body and floored so a title + one row always fits when there is
  // any room at all.
  const fleetContentRows = Math.max(1, cells(fleetCount));
  const fleetDesired = fleetContentRows + 1 /* title */ + chromeV;
  const fleetCap = Math.max(1 + 1 + chromeV, Math.floor(rowsForRegions * FLEET_MAX_SHARE));
  const fleetOuter = Math.min(fleetDesired, fleetCap, rowsForRegions);

  const afterFleet = Math.max(0, rowsForRegions - fleetOuter);

  // Summary: a small fixed slice (title + up to 4 edge lines + border), only
  // when asked for and there is room left for a stream too.
  let summaryOuter = 0;
  if (wantSummary && afterFleet >= 6 + chromeV) {
    summaryOuter = Math.min(afterFleet - (2 + chromeV) /* leave the stream a floor */, 4 + 1 + chromeV);
    if (summaryOuter < 1 + 1 + chromeV) summaryOuter = 0;
  }

  const streamOuter = Math.max(0, afterFleet - summaryOuter);

  const fleet = makeRegion(fleetOuter, contentWidth, bordered);
  const summary = summaryOuter > 0 ? makeRegion(summaryOuter, contentWidth, bordered) : { height: 0, bodyRows: 0, innerWidth: 0, hasTitle: false };
  const stream = makeRegion(streamOuter, contentWidth, bordered);

  return {
    bordered,
    contentWidth,
    bodyRows,
    regionGap,
    fleet,
    summary,
    stream,
    fleetVisibleRows: fleet.bodyRows,
    summaryVisibleRows: summary.bodyRows,
  };
}

/**
 * Scroll-into-view windowing for the fleet list, reusing the shared allocator.
 * Stateless apart from the caller's last start, so the list scrolls rather than
 * re-centres.
 */
export function computeFleetWindow(input: {
  rows: readonly CommsFleetRow[];
  selected: number;
  visible: number;
  anchor?: number;
}): ListWindow {
  return computeListWindow(input);
}

/** Right-aligned meta on the fleet region's title row — a truthful count. */
export function commsFleetMeta(shown: number, total: number): string {
  const visible = cells(shown);
  const all = cells(total);
  if (all === 0) return "none";
  if (visible === all) return `${all} agent${all === 1 ? "" : "s"}`;
  return `${visible}/${all}`;
}

/** Right-aligned meta on the stream region's title row. */
export function commsStreamMeta(shown: number, total: number, focused: boolean): string {
  const all = cells(total);
  if (all === 0) return "none";
  const base = `${all} message${all === 1 ? "" : "s"}`;
  return focused ? `focus · ${base}` : base;
}
