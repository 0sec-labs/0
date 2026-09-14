/** @jsxImportSource @opentui/react */
/**
 * The AGENTS COMMS surface — a live multi-agent "comms" view.
 *
 * TOP: the FLEET. Every active sub-agent as a row — its stable accent colour,
 * name, status marker, and a TRUTHFUL stat line (status · turns · current tool ·
 * findings · measured tokens · elapsed) built only from fields the live
 * subagent record actually carries. Rows are clickable (`onMouseDown`) and
 * keyboard-navigable; selecting one FOCUSES it, filtering the stream below to
 * that agent's traffic.
 *
 * MAIN: the inter-agent MESSAGE STREAM. A chronological log of `peer_message`
 * bus events rendered with the directional {@link MessageCard} idiom — from → to
 * with each endpoint in its agent accent, a kind chip, an age, the (untrusted,
 * sanitized) body, and delivery badges — the moment each message is sent, so the
 * operator watches agents coordinate live. An optional compact "who talks to
 * whom" summary (directed edge counts per pair) sits between the two.
 *
 * Two load-bearing properties, both inherited from `herd-screen.tsx`:
 *   1. This component does NO arithmetic — every width/height/row/window comes
 *      off `agents-comms-layout.ts`, swept by a test, because Yoga shrinks
 *      siblings rather than clipping them (see `PRIMITIVES.md`).
 *   2. It NEVER fabricates. The fleet is the console's real live subagent map;
 *      the stream is real bus traffic. Both empty by default, and the screen
 *      says so honestly rather than inventing agents or messages.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { eventBus } from "@0sec/core";

import { useTheme, type Theme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useSettings } from "./settings-store.js";
import { keyMatchesChord } from "./keybindings.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { Cells } from "./primitives.js";
import { paneTitleColumns } from "./pane-layout.js";
import { agentAccentFor } from "./agent-color.js";
import { sanitizeTuiText } from "./text.js";
import { MessageCard } from "./chat/MessageCard.js";
import type { HerdSubagentMap } from "./herd-layout.js";
import {
  COMMS_EMPTY_FLEET_TEXT,
  COMMS_EMPTY_STREAM_TEXT,
  type CommsFleetRow,
  type CommsMessage,
  type CommsTelemetryMap,
  applyCommsMessage,
  buildCommsFleet,
  clampFleetSelection,
  commsEdgeLabel,
  commsFleetMeta,
  commsFleetName,
  commsFleetStatLine,
  commsFooterHint,
  commsMessageCard,
  commsRowColumns,
  commsStatusMarker,
  commsStreamMeta,
  computeCommsEdges,
  computeCommsLayout,
  computeFleetWindow,
  filterMessagesForAgent,
  fleetIndexForNumber,
  moveFleetSelection,
} from "./agents-comms-layout.js";

/** How often the view refreshes (age ticks + roster poll), in ms. */
const REFRESH_MS = 1500;
/** How many edge lines the summary region shows at most. */
const MAX_EDGE_LINES = 4;
/** The roster id the local console renders as (mirrors message-card SELF_ID). */
const SELF_ID = "Main";

export interface CommsFrameInput {
  body: React.ReactNode;
  hint: string;
}

/** The minimal event-bus sink shape this screen subscribes with. */
export interface CommsBusSink {
  emit: (type: string, payload: Record<string, unknown>) => void;
}

export interface AgentsCommsScreenProps {
  /**
   * Wraps the body in the console shell. Injected rather than imported so this
   * module does not depend on `run.tsx` (which owns `ShellFrame`).
   */
  frame: (input: CommsFrameInput) => React.ReactNode;
  /** Leave the screen — Esc (when not focused on an agent). */
  onBack: () => void;
  /** Leave the console entirely — ctrl+c. */
  onExit: () => void;
  /**
   * Reads the current live subagent map owned by the active audit's ChatScreen.
   * Defaults to an empty map — with no audit mounted there is genuinely nothing
   * to show, and the screen states that honestly rather than inventing a fleet.
   */
  readAgents?: () => Readonly<HerdSubagentMap>;
  /**
   * Subscribes a bus sink and returns an unsubscribe fn. Injected for tests;
   * defaults to the real {@link eventBus}. The screen listens for `peer_message`
   * (the stream) and `subagent_lifecycle` (measured telemetry).
   */
  subscribe?: (sink: CommsBusSink) => () => void;
  /** Show the "who talks to whom" edge summary. Defaults to true. */
  showSummary?: boolean;
  /** Injected clock, tests only. Defaults to `Date.now`. */
  now?: () => number;
}

/** Read a measured `usage`/`durationMs`/`model` snapshot off a lifecycle payload. */
function readTelemetry(payload: Record<string, unknown>): CommsTelemetryMap[string] | undefined {
  const usage = payload["usage"];
  const snap: CommsTelemetryMap[string] = {};
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u["inputTokens"] === "number") snap.inputTokens = u["inputTokens"];
    if (typeof u["outputTokens"] === "number") snap.outputTokens = u["outputTokens"];
  }
  if (typeof payload["durationMs"] === "number") snap.durationMs = payload["durationMs"];
  if (typeof payload["model"] === "string") snap.model = payload["model"];
  return Object.keys(snap).length > 0 ? snap : undefined;
}

/** One fleet row: `marker  name` over-under stat, in the agent's accent. */
function FleetRow({
  row,
  width,
  theme,
  now,
  selected,
  focused,
  onSelect,
}: {
  row: CommsFleetRow;
  width: number;
  theme: Theme;
  now: number;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
}) {
  const cols = commsRowColumns(width);
  if (cols.width <= 0) return null;
  const accent = agentAccentFor(row.record.agentId, theme.CANVAS);
  const bg = selected ? theme.PANEL_ALT : undefined;
  const marker = commsStatusMarker(row.record);
  const name = commsFleetName(row.record);
  const stat = commsFleetStatLine(row, now);
  const nameFg = focused ? theme.PRIMARY : accent;
  return (
    <box
      flexDirection="row"
      width={cols.width}
      height={1}
      flexShrink={0}
      minWidth={0}
      backgroundColor={bg}
      onMouseDown={onSelect}
    >
      {cols.markerWidth > 0 ? (
        <Cells width={cols.markerWidth} fg={accent} bg={bg}>
          {marker}
        </Cells>
      ) : null}
      {cols.markerGap > 0 ? <Cells width={cols.markerGap} bg={bg}>{""}</Cells> : null}
      <Cells width={cols.nameWidth} fg={nameFg} bg={bg} attributes={TextAttributes.BOLD}>
        {name}
      </Cells>
      {cols.statWidth > 0 ? (
        <>
          {cols.statGap > 0 ? <Cells width={cols.statGap} bg={bg}>{""}</Cells> : null}
          <Cells width={cols.statWidth} align="right" fg={theme.MUTED} bg={bg}>
            {stat}
          </Cells>
        </>
      ) : null}
    </box>
  );
}

export function AgentsCommsScreen({
  frame,
  onBack,
  onExit,
  readAgents,
  subscribe,
  showSummary = true,
  now: nowFn,
}: AgentsCommsScreenProps) {
  const theme = useTheme();
  const symbols = useSymbols();
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const clock = nowFn ?? Date.now;

  const readAgentsRef = useRef(readAgents);
  readAgentsRef.current = readAgents;

  const [agents, setAgents] = useState<Readonly<HerdSubagentMap>>(() => readAgents?.() ?? {});
  const [telemetry, setTelemetry] = useState<CommsTelemetryMap>({});
  const [messages, setMessages] = useState<readonly CommsMessage[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  // Live settings: roster ordering + the optional leader chord (read via the
  // shared store hook so a change re-renders without run.tsx plumbing).
  const settings = useSettings();
  const rosterSort = settings.rosterSort;
  const leaderKey = settings.leaderKey;
  // One-shot leader ("prefix") arming, consumed by the next key.
  const prefixArmedRef = useRef(false);
  // A repaint pulse so relative ages tick on the refresh cadence. Only the
  // setter is read — the value itself is never rendered.
  const [, setTick] = useState(0);
  const seqRef = useRef(0);

  // ── Bus subscription: the stream (peer_message) + telemetry (lifecycle) ──
  useEffect(() => {
    const sub = subscribe ?? ((sink: CommsBusSink) => eventBus.subscribe(sink));
    const unsub = sub({
      emit: (type, payload) => {
        if (type === "peer_message") {
          seqRef.current += 1;
          setMessages((prev) => applyCommsMessage(prev, payload, seqRef.current));
        } else if (type === "subagent_lifecycle") {
          const id = payload["agent_id"];
          if (typeof id !== "string") return;
          const snap = readTelemetry(payload);
          if (snap) setTelemetry((prev) => ({ ...prev, [id]: { ...prev[id], ...snap } }));
        }
      },
    });
    return unsub;
  }, [subscribe]);

  // ── Roster poll + age tick, on the refresh cadence. A signature guard keeps
  // an unchanged poll from repainting; `tick` still advances so relative ages
  // update. Cleared on unmount. ──
  const signatureRef = useRef("");
  useEffect(() => {
    const poll = () => {
      const next = readAgentsRef.current?.() ?? {};
      const sig = Object.values(next)
        .map((r) => `${r.agentId}|${r.status}|${r.turn ?? ""}|${r.turns ?? ""}|${r.tool ?? ""}|${r.findings ?? ""}|${r.operatorStopped ?? ""}`)
        .join("~");
      if (sig !== signatureRef.current) {
        signatureRef.current = sig;
        setAgents(next);
      }
      setTick((value) => (value + 1) % 1_000_000);
    };
    poll();
    const handle = setInterval(poll, REFRESH_MS);
    return () => clearInterval(handle);
  }, []);

  const now = clock();

  const fleet = useMemo(() => buildCommsFleet(agents, telemetry, rosterSort), [agents, telemetry, rosterSort]);

  // A stable id → display name resolver for the stream and the edge summary.
  // "Main" and the broadcast sentinel pass through; a known agent id resolves to
  // its human name; anything else is shown as-is (already control-stripped).
  const nameFor = useCallback(
    (id: string): string => {
      if (id === SELF_ID || id === "all") return id;
      const rec = agents[id];
      return rec?.name ?? id;
    },
    [agents],
  );

  // Clear the focus/selection if the focused agent left the fleet.
  useEffect(() => {
    if (focusId && !agents[focusId]) setFocusId(null);
  }, [focusId, agents]);

  const focused = focusId !== null && Boolean(agents[focusId]);
  const streamAll = messages;
  const streamShown = useMemo(
    () => (focused ? filterMessagesForAgent(streamAll, focusId!) : streamAll),
    [focused, focusId, streamAll],
  );
  const edges = useMemo(() => (showSummary ? computeCommsEdges(streamAll) : []), [showSummary, streamAll]);

  const layout = computeCommsLayout({
    width,
    height,
    fleetCount: Math.max(1, fleet.length),
    showSummary: showSummary && edges.length > 0,
    hostRows: inDialog ? 1 : undefined,
    hostPaddingX: inDialog ? 0 : undefined,
  });

  const fleetWindow = computeFleetWindow({
    rows: fleet,
    selected: clampFleetSelection(fleet.length, selected),
    visible: layout.fleetVisibleRows,
  });
  const visibleFleet = fleet.slice(fleetWindow.start, fleetWindow.end);

  const selectRow = useCallback(
    (index: number) => {
      const clamped = clampFleetSelection(fleet.length, index);
      if (clamped < 0) return;
      setSelected(clamped);
      const row = fleet[clamped];
      if (row) setFocusId(row.record.agentId);
    },
    [fleet],
  );

  const jumpToAgent = (n: number) => {
    const index = fleetIndexForNumber(fleet.length, n);
    if (index >= 0) selectRow(index);
  };

  useKeyboard((key) => {
    // Ctrl+C always exits — never trap the operator.
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    // Optional leader (prefix) chord: arms a one-shot prefix so the next key is
    // a leader action. Off by default; placed after the Ctrl+C guard so exit is
    // never trapped.
    if (leaderKey !== "off" && !prefixArmedRef.current && keyMatchesChord(key, leaderKey)) {
      prefixArmedRef.current = true;
      return;
    }
    if (prefixArmedRef.current) {
      prefixArmedRef.current = false;
      if (!key.ctrl && !key.meta && typeof key.sequence === "string" && /^[1-9]$/.test(key.sequence)) {
        jumpToAgent(Number(key.sequence));
        return;
      }
      if (!key.ctrl && !key.meta && (key.sequence === "n" || key.sequence === "N")) {
        setSelected((current) => moveFleetSelection(fleet.length, current, 1));
        return;
      }
      if (!key.ctrl && !key.meta && (key.sequence === "p" || key.sequence === "P")) {
        setSelected((current) => moveFleetSelection(fleet.length, current, -1));
        return;
      }
      // Not a leader action: the prefix is spent and the key falls through to
      // normal handling below (Esc/Enter/arrows are never swallowed by it).
    }
    // Number keys 1-9 focus the N-th agent in the current ordering directly —
    // always available, no leader required. Reuses the existing focus/select
    // handler (`selectRow`), exactly as Enter and a click do.
    if (!key.ctrl && !key.meta && typeof key.sequence === "string" && /^[1-9]$/.test(key.sequence)) {
      jumpToAgent(Number(key.sequence));
      return;
    }
    if (key.name === "escape") {
      if (focused) {
        setFocusId(null);
        return;
      }
      onBack();
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSelected((current) => moveFleetSelection(fleet.length, current, -1));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSelected((current) => moveFleetSelection(fleet.length, current, 1));
      return;
    }
    if (key.name === "return") {
      selectRow(selected);
    }
  });

  // ── Title rows for each region ──
  const fleetTitle = `${operatorIcon("agents", symbols)} ${operatorTitle("agents")}`;
  const fleetMeta = commsFleetMeta(fleet.length, fleet.length);
  const streamMeta = commsStreamMeta(streamShown.length, streamAll.length, focused);

  const clampedSelected = clampFleetSelection(fleet.length, selected);

  const body = (
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
      {/* ── TOP: the fleet ── */}
      <Region
        theme={theme}
        width={layout.contentWidth}
        height={layout.fleet.height}
        innerWidth={layout.fleet.innerWidth}
        bordered={layout.bordered}
        title={fleetTitle}
        meta={`${fleetMeta}${fleetWindow.hasAbove || fleetWindow.hasBelow ? ` · ${fleetWindow.start + 1}-${fleetWindow.end}` : ""}`}
      >
        {fleet.length === 0 ? (
          <Cells width={layout.fleet.innerWidth} fg={theme.MUTED}>
            {COMMS_EMPTY_FLEET_TEXT}
          </Cells>
        ) : (
          visibleFleet.map((row, index) => {
            const rowIndex = fleetWindow.start + index;
            return (
              <FleetRow
                key={row.record.agentId}
                row={row}
                width={layout.fleet.innerWidth}
                theme={theme}
                now={now}
                selected={rowIndex === clampedSelected}
                focused={focusId === row.record.agentId}
                onSelect={() => selectRow(rowIndex)}
              />
            );
          })
        )}
      </Region>

      {layout.regionGap > 0 ? <Cells width={layout.contentWidth}>{""}</Cells> : null}

      {/* ── OPTIONAL: who talks to whom ── */}
      {layout.summary.height > 0 ? (
        <>
          <Region
            theme={theme}
            width={layout.contentWidth}
            height={layout.summary.height}
            innerWidth={layout.summary.innerWidth}
            bordered={layout.bordered}
            title="TRAFFIC"
            meta={`${edges.length} edge${edges.length === 1 ? "" : "s"}`}
          >
            {edges.slice(0, Math.min(MAX_EDGE_LINES, layout.summaryVisibleRows)).map((edge) => (
              <Cells key={`${edge.from}->${edge.to}`} width={layout.summary.innerWidth} fg={theme.MUTED}>
                {commsEdgeLabel(edge, nameFor)}
              </Cells>
            ))}
          </Region>
          {layout.regionGap > 0 ? <Cells width={layout.contentWidth}>{""}</Cells> : null}
        </>
      ) : null}

      {/* ── MAIN: the message stream ── */}
      <RegionShell
        theme={theme}
        width={layout.contentWidth}
        height={layout.stream.height}
        innerWidth={layout.stream.innerWidth}
        bordered={layout.bordered}
        title={focused ? `MESSAGES · ${sanitizeTuiText(nameFor(focusId!))}` : "MESSAGES"}
        meta={streamMeta}
      >
        {streamShown.length === 0 ? (
          <Cells width={layout.stream.innerWidth} fg={theme.MUTED}>
            {COMMS_EMPTY_STREAM_TEXT}
          </Cells>
        ) : (
          <scrollbox
            width="100%"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            minHeight={0}
            scrollX={false}
            stickyScroll
            stickyStart="bottom"
            verticalScrollbarOptions={{
              trackOptions: { backgroundColor: theme.PANEL, foregroundColor: theme.MUTED },
              arrowOptions: { foregroundColor: theme.MUTED, backgroundColor: theme.PANEL },
            }}
          >
            <box flexDirection="column" width="100%" minWidth={0}>
              {streamShown.map((message) => (
                <MessageCard
                  key={message.seq}
                  data={commsMessageCard(message, { now, selfId: SELF_ID, resolveName: nameFor })}
                  width={Math.max(1, layout.stream.innerWidth - 1)}
                  theme={theme}
                  spacing={1}
                />
              ))}
            </box>
          </scrollbox>
        )}
      </RegionShell>
    </box>
  );

  const hint = commsFooterHint(focused);
  return <>{frame({ body, hint })}</>;
}

/** A bordered/plain region whose title row splits into title + right-meta. */
function RegionShell({
  theme,
  width,
  height,
  innerWidth,
  bordered,
  title,
  meta,
  children,
}: {
  theme: Theme;
  width: number;
  height: number;
  innerWidth: number;
  bordered: boolean;
  title: string;
  meta: string;
  children: React.ReactNode;
}) {
  if (height <= 0 || innerWidth <= 0) return null;
  const cols = paneTitleColumns(innerWidth, meta.length);
  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      flexGrow={0}
      minWidth={0}
      minHeight={0}
      border={bordered || undefined}
      borderColor={bordered ? theme.BORDER : undefined}
      backgroundColor={bordered ? theme.PANEL : undefined}
      paddingX={bordered ? 1 : undefined}
    >
      <box flexDirection="row" width={innerWidth} flexShrink={0} minWidth={0}>
        <Cells width={cols.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
          {title}
        </Cells>
        <Cells width={cols.gap}>{""}</Cells>
        <Cells width={cols.metaWidth} align="right" fg={theme.MUTED}>
          {meta}
        </Cells>
      </box>
      {children}
    </box>
  );
}

/** RegionShell with a plain vertical content column (fleet / summary rows). */
function Region(props: {
  theme: Theme;
  width: number;
  height: number;
  innerWidth: number;
  bordered: boolean;
  title: string;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <RegionShell {...props}>
      <box flexDirection="column" width={props.innerWidth} flexShrink={1} minWidth={0} minHeight={0} overflow="hidden">
        {props.children}
      </box>
    </RegionShell>
  );
}
