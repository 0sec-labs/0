/** @jsxImportSource @opentui/react */
/**
 * The agent-herd overview surface.
 *
 * A roster of every 0sec peer — sessions and subagents — working this project
 * directory, grouped by live status, with a detail pane for the selected peer
 * and its recent inbox activity. Modelled on the settings screen: a grouped
 * list on the left, a detail pane on the right, stacked when the terminal is
 * too narrow to hold both.
 *
 * Two properties are load-bearing, both inherited from `settings-screen.tsx`:
 *
 * 1. **This component does no arithmetic.** Every width, height, row count and
 *    window boundary comes off `herd-layout.ts`, swept across widths 0..200 and
 *    heights 0..80 by a test, because Yoga shrinks siblings rather than clipping
 *    them (see `PRIMITIVES.md`).
 *
 * 2. **It never fabricates a herd.** The hub roster has no producer wired yet
 *    (see `herd-layout.ts` and `packages/core/src/hub/registry.ts`), so the
 *    roster is empty by default and this screen says so — "no other agents in
 *    this project" — rather than rendering placeholder agents. It reads its
 *    roster from an INJECTED provider (`readRoster`), defaulting to one that
 *    returns nothing; the day a producer persists the roster, the provider is
 *    swapped for a real reader and this screen lights up unchanged.
 *
 * The roster is a *view*, so it refreshes on a timer. The interval is cleared
 * on unmount, and a cheap signature guard skips the state update (and therefore
 * the repaint) when nothing observable changed between two polls.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sleekScrollbar } from "./scrollbar.js";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes, TextAttributes } from "@opentui/core";
import { eventBus, peekInbox, sendOperatorMessage, type MessagingRuntime } from "@0sec/core";

import { useTheme, type Theme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useSettings } from "./settings-store.js";
import { keyMatchesChord } from "./keybindings.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { Cells } from "./primitives.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import { computeDialogPanel } from "./dialog-select-layout.js";
import { sanitizeTuiText } from "./text.js";
import {
  HERD_COMPOSER_CURSOR,
  HERD_COMPOSER_PROMPT,
  HERD_EMPTY_TEXT,
  HERD_FOCUS_EMPTY_TEXT,
  applySubagentLifecycle,
  applySubagentProgress,
  buildHerdRows,
  clampHerdSelection,
  computeHerdFocusLayout,
  computeHerdLayout,
  filterHerdPeers,
  nthPeerRowIndex,
  focusHeaderLines,
  focusScrollPosition,
  herdComposerFooterHint,
  herdComposerVisibleDraft,
  herdDetailLines,
  herdDialogItems,
  herdDialogMeta,
  herdRowTone,
  herdFocusFooterHint,
  herdFocusTranscriptTitle,
  herdFooterHint,
  paneTitleColumns,
  herdStatusLabel,
  mergeSubagentRoster,
  moveHerdSelection,
  renderFocusActivity,
  siblingLabel,
  subagentPeers,
  subagentStatusLabel,
  windowFocusTail,
  readFocusTelemetry,
  type HerdDetailTone,
  type HerdInboxMessage,
  type HerdPane,
  type HerdPeer,
  type HerdSubagentMap,
  type FocusTelemetry,
} from "./herd-layout.js";
import { summarizeFleet } from "./agents-panel-model.js";

/** How many rows page-up and page-down move. */
const PAGE_STEP = 5;
/** How often the roster view refreshes, in ms. */
const REFRESH_MS = 1500;
/** The dialog's own icon+title row, budgeted out of the body. */
const HEADER_ROWS = 1;

export interface HerdFrameInput {
  body: React.ReactNode;
  hint: string;
}

export interface HerdScreenProps {
  /**
   * Wraps the body in the console shell. Injected rather than imported so this
   * module does not depend on `run.tsx` — which owns `ShellFrame` and pulls in
   * every other screen with it.
   */
  frame: (input: HerdFrameInput) => React.ReactNode;
  /** Leave the screen — Esc. */
  onBack: () => void;
  /** Leave the console entirely — ctrl+c. */
  onExit: () => void;
  /**
   * Reads the current peer roster as of `now`. Defaults to an empty roster,
   * because the hub has no producer wired yet — the screen must not invent one.
   * A real reader is injected once the roster transport lands.
   */
  readRoster?: (now: number) => HerdPeer[];
  /** Audit root scan. An empty supplied root is scoped but not ready. */
  parentScanId?: string;
  /** Snapshot owned by that audit's mounted ChatScreen, including existing workers. */
  readAgents?: () => Readonly<HerdSubagentMap>;
  /** Audit mailbox namespace; never changes process HOME or credential storage. */
  messagingHomeDir?: string;
  /**
   * Reads (peeks, never drains) a peer's inbox. Defaults to the hub mailbox's
   * `peekInbox` against `projectPath`. Peeking leaves the mail in place so a
   * concurrent drain by the real reader is not starved.
   */
  peekInboxFor?: (peerId: string) => HerdInboxMessage[];
  /** Project directory the hub is keyed by. Defaults to `process.cwd()`. */
  projectPath?: string;
  /** Home dir for `~` path abbreviation. Defaults to `$HOME`. */
  homeDir?: string;
  /** Injected clock, tests only. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * The OPERATOR's own peer id — the `from` on a steering message. Without it
   * the console cannot name itself, so the compose affordance still opens but a
   * send fails cleanly ("operator identity not wired"). Supplied once the
   * roster producer lands; left unset today, consistent with the empty roster.
   */
  selfId?: string;
  /**
   * The operator↔child channel toggle, mirrored onto the steering runtime.
   * Defaults to `true` — steering a running subagent is on by default, and the
   * pure {@link import("@0sec/core").decideAddressing} still re-checks it.
   */
  operatorChannelEnabled?: boolean;
  /**
   * Sends a steering message to `to`, returning the delivery outcome. Injected
   * for tests; the default authorizes with `decideAddressing` and delivers via
   * the hub mailbox (`sendOperatorMessage`) using an `operator` runtime built
   * from {@link selfId}, the live roster, and the project/home paths.
   */
  sendSteer?: (input: { to: string; body: string }) => {
    ok: boolean;
    reason?: string;
    truncated?: boolean;
  };
}

function toneColor(theme: Theme, tone: HerdDetailTone): string | undefined {
  switch (tone) {
    case "title":
      return theme.PRIMARY;
    case "accent":
      return theme.ACCENT;
    case "warn":
      return theme.WARNING;
    case "muted":
    case "blank":
      return theme.MUTED;
    default:
      return theme.TEXT;
  }
}

/**
 * The unselected colour for a roster row, by lifecycle class. This is the
 * ladder the hand-rolled list used before the roster moved onto the shared
 * picker — a failure reads red, a stopped or incomplete peer dims, working is
 * accented, blocked/stale warn — restored through `DialogItem.tone`.
 */
function rowToneColor(theme: Theme, tone: ReturnType<typeof herdRowTone>): string {
  switch (tone) {
    case "failed":
      return theme.ERROR;
    case "working":
      return theme.ACCENT;
    case "attention":
      return theme.WARNING;
    case "settled":
    case "idle":
    default:
      return theme.MUTED;
  }
}

/**
 * A pane that states its own height. `height` includes the borders and
 * `flexShrink={0}` stops the column squeezing the box behind its content's
 * back. A pane the layout could not find room for reports zero and renders
 * nothing at all — the correct degradation.
 */
function Pane({
  pane,
  bordered,
  title,
  meta,
  children,
}: {
  pane: HerdPane;
  bordered: boolean;
  title: string;
  /** Right-aligned muted summary on the title row (count/window). */
  meta?: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  if (pane.width <= 0 || pane.height <= 0) return null;
  // Title row: bold primary title left, right-aligned muted meta — the OMP
  // header the console reuses. The columns sum to the inner width so the two
  // can never fuse under pressure.
  const cols = paneTitleColumns(pane.innerWidth, (meta ?? "").length);
  const titleRow = pane.hasTitle ? (
    <box flexDirection="row" width={pane.innerWidth} flexShrink={0} minWidth={0}>
      <Cells width={cols.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
        {title}
      </Cells>
      <Cells width={cols.gap}>{""}</Cells>
      <Cells width={cols.metaWidth} align="right" fg={theme.MUTED}>
        {meta ?? ""}
      </Cells>
    </box>
  ) : null;
  return (
    <box
      flexDirection="column"
      width={pane.width}
      height={pane.height}
      flexShrink={0}
      flexGrow={0}
      minWidth={0}
      backgroundColor={bordered ? theme.PANEL : undefined}
      paddingX={bordered ? 2 : undefined}
      paddingY={bordered ? 1 : undefined}
    >
      {titleRow}
      {children}
    </box>
  );
}

/** A single value that changes exactly when the rendered roster does. */
function rosterSignature(peers: readonly HerdPeer[], now: number): string {
  // Bucket `now` to the refresh cadence so relative-age labels still tick
  // without a repaint every millisecond.
  const bucket = Math.floor(now / REFRESH_MS);
  const parts = peers.map((p) => {
    const a = p.activity;
    return `${p.id}|${p.kind}|${p.pid}|${p.lastSeen}|${p.label ?? ""}|${a?.phase ?? ""}|${a?.turn ?? ""}|${a?.tool ?? ""}|${a?.note ?? ""}`;
  });
  return `${bucket}#${parts.join("~")}`;
}

export function HerdScreen({
  frame,
  onBack,
  onExit,
  readRoster,
  parentScanId,
  readAgents,
  messagingHomeDir,
  peekInboxFor,
  projectPath,
  homeDir,
  now: nowFn,
  selfId,
  operatorChannelEnabled,
  sendSteer,
}: HerdScreenProps) {
  const theme = useTheme();
  const symbols = useSymbols();
  const { width, height } = useSurfaceDimensions();
  // Inside a dialog the host draws one footer row and no padding, and the
  // surface is the panel interior, so the legacy shell chrome allowance must
  // not be subtracted from it.
  const inDialog = useDialogSurface();
  const clock = nowFn ?? Date.now;
  const cwd = projectPath ?? process.cwd();
  const home = homeDir ?? process.env["HOME"] ?? undefined;
  // Audit scoping. `scoped` is set by the mere PRESENCE of a root scan, so an
  // empty supplied root is scoped-but-not-ready rather than silently global.
  const scoped = parentScanId !== undefined;
  // The audit's mailbox namespace: the value handed to `peekInbox`'s existing
  // `homeDir` argument and to the messaging runtime's existing `homeDir` option,
  // so a scoped audit reads and writes ITS OWN namespace. Canonical's `home` is
  // the honest fallback when no audit namespace was supplied — there is then
  // nothing else to pass. This is a mailbox namespace only: process HOME,
  // credential storage and authentication are untouched.
  const mailboxHome = messagingHomeDir ?? home;
  // One identity per audit. Every per-audit path compares against it, so events,
  // state and a pinned compose target from a superseded audit are all refused.
  const owner = useMemo(() => ({}), [parentScanId, cwd, mailboxHome]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const readAgentsRef = useRef(readAgents);
  readAgentsRef.current = readAgents;

  // The roster provider defaults to empty: the hub has no producer, so there is
  // genuinely nothing to read, and the screen must show that honestly.
  const readRosterRef = useRef(readRoster);
  readRosterRef.current = readRoster;
  const peekRef = useRef(peekInboxFor);
  peekRef.current = peekInboxFor;

  const peekOne = React.useCallback(
    (peerId: string): HerdInboxMessage[] => {
      // A scoped screen with no root scan and no namespace value at all has
      // nothing to read from; it peeks nothing rather than reading the
      // process-wide mailbox and showing another audit's mail. A scoped screen
      // that HAS a namespace peeks that namespace.
      if (scoped && (!parentScanId || !mailboxHome)) return [];
      if (peekRef.current) return peekRef.current(peerId);
      try {
        return peekInbox(cwd, peerId, mailboxHome).map((m) => ({ from: m.from, body: m.body, ts: m.ts }));
      } catch {
        return [];
      }
    },
    [cwd, mailboxHome, parentScanId, scoped],
  );

  // Live settings from the process-wide store: the roster ordering and the
  // optional leader chord. Read via the shared hook (like chat-screen) so the
  // screen re-renders when the operator changes them — no run.tsx plumbing.
  const settings = useSettings();
  const rosterSort = settings.rosterSort;
  const leaderKey = settings.leaderKey;

  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => clock());
  const [peers, setPeers] = useState<HerdPeer[]>(() => readRoster?.(clock()) ?? []);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  // One-shot leader ("prefix") arming: set true when the leader chord is
  // pressed, consumed by the very next key. A ref so the handler reads the
  // current value without a re-render race.
  const prefixArmedRef = useRef(false);
  const applySelected = (next: number) => {
    selectedRef.current = next;
    setSelected(next);
  };

  // Live subagents seen on this process's event bus. Keyed by `agent_id`, the
  // same id a roster subagent peer carries, so the two join. Built additively
  // from `subagent_lifecycle` / `subagent_progress` — the herd screen carries
  // only a snapshot roster otherwise, so this is the live half the focus view
  // renders. Fail-soft: a malformed payload folds to the same map (no repaint).
  const [subagents, setSubagents] = useState<HerdSubagentMap>({});
  // Mirrored onto a ref so the keyboard handler tests audit membership against
  // the CURRENT map (state in render, ref in the handler).
  const subagentsRef = useRef(subagents);
  subagentsRef.current = subagents;

  // MEASURED per-agent telemetry (usage/context/duration/model), keyed by the
  // same `agent_id`. Harvested LIVE from `subagent_message` (per-turn) and the
  // terminal `subagent_lifecycle`; the focus header renders the focused agent's
  // snapshot. Absent → "not reported", so the header omits it rather than zeroing.
  const [telemetry, setTelemetry] = useState<Record<string, FocusTelemetry>>({});

  // Focus mode: the id of the subagent the operator drilled into, or null in
  // list mode. `scrollOffset` scrolls the live transcript back from its tail.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusIdRef = useRef<string | null>(null);
  const applyFocusId = (next: string | null) => {
    focusIdRef.current = next;
    setFocusId(next);
  };
  const [scrollOffset, setScrollOffset] = useState(0);

  // Steering composer. `composing`/`draft` are mirrored onto refs so the
  // keyboard handler reads the latest value synchronously between keystrokes
  // (the chat composer relies on the same pattern). `notice` is the one-row
  // delivery confirmation or error shown after a send.
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const [composeTarget, setComposeTarget] = useState<{ owner: object; peer: HerdPeer } | null>(null);
  const composeTargetRef = useRef<typeof composeTarget>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  // ── Search/filter: a text filter that narrows the roster by id, label, or
  // activity. Bound to `s` in list mode; cleared on Esc. The filter input is
  // modelled on the steering composer — a single-row overlay with a prompt,
  // Backspace, printable characters, and paste support.
  const [searching, setSearching] = useState(false);
  const searchingRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchQueryRef = useRef("");

  const setSearchingBoth = (value: boolean) => {
    searchingRef.current = value;
    setSearching(value);
  };
  const setSearchQueryBoth = (value: string) => {
    searchQueryRef.current = value;
    setSearchQuery(value);
  };

  // Paste only into the active search or steering field, never navigation.
  usePaste((event) => {
    if (!searchingRef.current && !composingRef.current) return;
    const text = sanitizeTuiText(decodePasteBytes(event.bytes));
    if (!text) return;
    if (searchingRef.current) setSearchQueryBoth(searchQueryRef.current + text);
    else setDraftBoth(draftRef.current + text);
  });

  const setComposingBoth = (value: boolean) => {
    composingRef.current = value;
    setComposing(value);
    if (!value) {
      composeTargetRef.current = null;
      setComposeTarget(null);
    }
  };
  const setDraftBoth = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };
  const beginCompose = (peer: HerdPeer) => {
    const target = { owner, peer };
    composeTargetRef.current = target;
    setComposeTarget(target);
    setNotice(null);
    setDraftBoth("");
    setComposingBoth(true);
  };

  const signatureRef = useRef<string>("");

  // Poll the roster on a timer, repainting only when the signature changes.
  useEffect(() => {
    const poll = () => {
      const at = clock();
      const next = readRosterRef.current?.(at) ?? [];
      const signature = rosterSignature(next, at);
      if (signature !== signatureRef.current) {
        signatureRef.current = signature;
        setPeers(next);
        setNow(at);
        setTick((t) => t + 1);
      }
    };
    poll();
    const handle = setInterval(poll, REFRESH_MS);
    return () => clearInterval(handle);
    // `clock` is stable (Date.now or an injected function); the refs carry the
    // latest providers so the interval never needs re-creating. `owner` re-polls
    // the roster from scratch when the audit changes.
  }, [clock, owner]);

  // Subscribe to the core event bus for per-subagent activity, additively, and
  // seed from the audit's own persistent ChatScreen before accepting any event.
  // The bus is process-local and carries EVERY audit's subagents, so a scoped
  // screen filters events down to its own audit: attribution is derived from
  // the root scan and from already-attributed agent ids, never guessed.
  //
  // This is expressed through canonical's interface — `setSubagents` with the
  // pure `applySubagent*` reducers as the only writers — rather than 40ea's
  // owner-tagged `agentState`. The audit identity lives on `owner`, which
  // re-runs this effect and re-seeds from a clean slate.
  useEffect(() => {
    /**
     * Fold the audit's ChatScreen snapshot into `base`. Pure: returns `base`
     * itself when nothing is attributable, so a no-op never repaints.
     */
    const seedAgents = (base: HerdSubagentMap): HerdSubagentMap => {
      const snapshot = readAgentsRef.current?.() ?? {};
      if (!scoped) {
        return Object.keys(snapshot).length === 0 ? base : { ...base, ...snapshot };
      }
      if (!parentScanId) return base;
      const next: HerdSubagentMap = { ...base };
      let changed = false;
      // Traverse parent agent IDs only when already attributed. Never guess a
      // nested scan's owner from an arbitrary process-wide event.
      const remaining = Object.values(snapshot);
      let moved = true;
      while (moved) {
        moved = false;
        for (let i = remaining.length - 1; i >= 0; i--) {
          const record = remaining[i];
          if (record.parentScanId !== parentScanId && !Object.hasOwn(next, record.parentScanId)) continue;
          const previous = next[record.agentId];
          if (!previous || record.lastSeen >= previous.lastSeen) {
            next[record.agentId] = record;
            changed = true;
          }
          remaining.splice(i, 1);
          moved = true;
        }
      }
      return changed ? next : base;
    };

    // A new audit owner: reset every per-audit piece of view state, then seed.
    setSubagents(() => seedAgents({}));
    setTelemetry({});
    applyFocusId(null);
    setScrollOffset(0);
    applySelected(0);
    setComposingBoth(false);
    setDraftBoth("");
    setSearchingBoth(false);
    setSearchQueryBoth("");
    setNotice(null);

    const unsub = eventBus.subscribe({
      emit: (type, payload) => {
        // Events emitted for a superseded audit are dropped before anything
        // else — the ref, not the closure, decides which audit is current.
        if (ownerRef.current !== owner) return;
        // LIVE telemetry: `subagent_message` (per-turn) + `subagent_lifecycle`
        // (terminal) both carry measured usage/context/duration/model. Merge it
        // for any agent this screen owns; the terminal snapshot arrives last and
        // wins per field. Gated by the same audit-membership rule as the roster.
        if (type === "subagent_lifecycle" || type === "subagent_message") {
          const id = payload["agent_id"];
          if (typeof id === "string") {
            const snap = readFocusTelemetry(payload);
            if (snap) {
              const parent = payload["parent_scan_id"];
              const belongs =
                !scoped ||
                Object.hasOwn(subagentsRef.current, id) ||
                (typeof parent === "string" &&
                  (parent === parentScanId || Object.hasOwn(subagentsRef.current, parent)));
              if (belongs) setTelemetry((prev) => ({ ...prev, [id]: { ...prev[id], ...snap } }));
            }
          }
        }
        if (type !== "subagent_lifecycle" && type !== "subagent_progress") return;
        const at = clock();
        setSubagents((prev) => {
          const seeded = seedAgents(prev);
          if (scoped) {
            if (!parentScanId) return seeded;
            const parent = payload["parent_scan_id"];
            const id = payload["agent_id"];
            if (typeof id !== "string" || typeof parent !== "string") return seeded;
            const known = Object.hasOwn(seeded, id) ? seeded[id] : undefined;
            const belongs = parent === parentScanId || Object.hasOwn(seeded, parent)
              || (known !== undefined && known.parentScanId === parent);
            // A foreign audit's worker never enters this screen's state.
            if (!belongs) return seeded;
          }
          return type === "subagent_lifecycle"
            ? applySubagentLifecycle(seeded, payload, at)
            : applySubagentProgress(seeded, payload, at);
        });
      },
    });
    // Re-seed on the roster's cadence so workers the audit's ChatScreen already
    // knows about appear without waiting for one of their events.
    const handle = setInterval(() => {
      if (ownerRef.current !== owner) return;
      setSubagents((prev) => seedAgents(prev));
    }, REFRESH_MS);
    return () => {
      unsub();
      clearInterval(handle);
    };
  }, [clock, owner, parentScanId, scoped]);

  // The roster the list renders is the injected provider's peers merged with
  // the live subagents (provider wins on an id collision). These are real
  // agents emitting real events, not fabricated placeholders.
  const livePeers = useMemo(() => subagentPeers(subagents, now), [subagents, now]);
  const mergedPeers = useMemo(
    () => mergeSubagentRoster(scoped ? peers.filter((peer) => Object.hasOwn(subagents, peer.id)) : peers, livePeers),
    [peers, livePeers, scoped, subagents],
  );

  // Apply the live search filter. When the query is empty the peers pass
  // through unchanged (same identity, same output).
  const filteredPeers = useMemo(
    () => filterHerdPeers(mergedPeers, searchQuery),
    [mergedPeers, searchQuery],
  );
  const rows = useMemo(() => buildHerdRows(filteredPeers, now, undefined, rosterSort), [filteredPeers, now, rosterSort]);
  const cursor = clampHerdSelection(rows, selected);
  const activeRow = cursor >= 0 ? rows[cursor] : undefined;
  const activePeer = activeRow?.kind === "peer" ? activeRow.peer : undefined;

  // Focus mode: the peer being drilled into and its live record. The peer is
  // looked up in the merged roster so a focused subagent survives list
  // reshuffles; `focused` gates the whole alternate view and its keymap. A
  // focused peer that leaves the roster (a session that vanished) drops focus.
  const focusedPeer = focusId ? mergedPeers.find((peer) => peer.id === focusId) : undefined;
  const focusRecord = focusId ? subagents[focusId] : undefined;
  const focused = focusId != null && focusedPeer != null;

  // A draft remains addressed to the peer chosen when composition began.
  const steerTarget = composing
    ? composeTarget?.owner === owner ? composeTarget.peer : undefined
    : focused ? focusedPeer : activePeer;

  useEffect(() => {
    if (focusId != null && !focusedPeer) {
      applyFocusId(null);
      setScrollOffset(0);
    }
  }, [focusId, focusedPeer]);

  // A steering composer or a delivery notice claims one row above the footer;
  // reserve it through the layout's own `noticeRows` budget so the panes shrink
  // by exactly that row and nothing overlaps. The search line is NOT counted
  // here — it lives inside the picker body, which budgets its own row.
  const overlayRow = composing || notice !== null;
  const host = inDialog ? { hostRows: 1, hostPaddingX: 0 } : {};
  const layout = computeHerdLayout({ width, height, noticeRows: overlayRow ? 1 : 0, ...host });
  const focusLayout = computeHerdFocusLayout({ width, height, noticeRows: overlayRow ? 1 : 0, ...host });

  // The roster projected onto the shared picker: status groups become the
  // category headings, the record's own activity line becomes the row meta.
  const { items: dialogItems, rowIndexOfItem } = useMemo(
    () =>
      herdDialogItems(rows, {
        ...(focusId ? { focusedId: focusId } : {}),
        workers: subagents,
        // The roster row carries the process phase; the worker lifecycle facts
        // (status, done, operator-stopped) live on the subagent RECORD, joined
        // by id — the same `agent_id` join `focusRecord` uses. A roster row with
        // no live record is classified on its phase alone. Render-time state,
        // not a ref: this repaints.
        toneFor: (peer, status) => rowToneColor(theme, herdRowTone(subagents[peer.id], status)),
      }),
    [rows, focusId, theme, subagents],
  );
  const dialogCursor = Math.max(0, rowIndexOfItem.indexOf(cursor));
  const totalRows = rows.length;
  const panel = computeDialogPanel({
    width: layout.contentWidth,
    height,
    size: "large",
    totalRows,
    withDetail: true,
    bodyRows: Math.max(1, layout.bodyRows - HEADER_ROWS),
  });
  // The picker owns its own scroll window (`dialogWindow`), so the screen keeps
  // no anchor of its own; the cursor is the single piece of selection state.
  useEffect(() => {
    if (cursor >= 0 && cursor !== selected) applySelected(cursor);
  }, [cursor, selected]);

  // Peek the selected peer's inbox. Re-peeked when the selection or the poll
  // tick changes; never drained, so a real reader's mail is left intact.
  const inbox = useMemo<HerdInboxMessage[]>(() => {
    if (!activePeer) return [];
    return peekOne(activePeer.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePeer?.id, peekOne, tick]);

  const currentRows = () => searchQueryRef.current === searchQuery
    ? rows
    : buildHerdRows(filterHerdPeers(mergedPeers, searchQueryRef.current), now, undefined, rosterSort);
  const currentPeer = () => {
    const visible = currentRows();
    const row = visible[clampHerdSelection(visible, selectedRef.current)];
    return row?.kind === "peer" ? row.peer : undefined;
  };

  const move = (delta: number) => {
    setNotice(null);
    const visible = currentRows();
    const next = moveHerdSelection(visible, clampHerdSelection(visible, selectedRef.current), delta);
    if (next >= 0) applySelected(next);
  };

  /**
   * Jump the highlight straight to the N-th agent (1-based) in the current
   * roster ordering, skipping headings. Reuses the plain select handler
   * (`applySelected`) — it highlights the peer exactly as an arrow or a click
   * would, and never drills into focus mode (that stays Enter's job). A no-op
   * when N is out of range, so an over-count never moves or clears the cursor.
   */
  const jumpToPeer = (n: number) => {
    const visible = currentRows();
    const rowIndex = nthPeerRowIndex(visible, n);
    if (rowIndex >= 0) {
      setNotice(null);
      applySelected(rowIndex);
    }
  };

  /**
   * Click on a roster row. It SELECTS, exactly as the hand-rolled row's
   * `onMouseDown` did and nothing more — a click has never focused, messaged
   * or steered an agent, and it still does not.
   */
  const selectRow = (itemIndex: number) => {
    const rowIndex = rowIndexOfItem[itemIndex];
    if (rowIndex !== undefined) applySelected(rowIndex);
  };

  /**
   * Authorize and deliver a steering message to `to`. Uses the injected
   * `sendSteer` when present (tests); otherwise builds an `operator` messaging
   * runtime — pinned to the live roster so a dead id is refused — and hands it
   * to `sendOperatorMessage`, which re-runs `decideAddressing` before it spools.
   */
  const deliver = (to: string, body: string): { ok: boolean; reason?: string; truncated?: boolean } => {
    if (sendSteer) return sendSteer({ to, body });
    if (!selfId) return { ok: false, reason: "operator identity not wired" };
    const runtime: MessagingRuntime = {
      selfId,
      selfRole: "operator",
      siblingChannelEnabled: false,
      operatorChannelEnabled: operatorChannelEnabled ?? true,
      projectPath: cwd,
      homeDir: mailboxHome,
      knownPeerIds: mergedPeers.map((peer) => peer.id),
    };
    const result = sendOperatorMessage(runtime, to, body, clock());
    return { ok: result.ok, reason: result.reason, truncated: result.truncated };
  };

  useKeyboard((key) => {
    // Ctrl+C always exits — a modal composer must never trap the operator.
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }

    // ── Search mode: type-ahead filter on the roster ──
    if (searchingRef.current) {
      if (key.name === "escape") {
        setSearchingBoth(false);
        setSearchQueryBoth("");
        return;
      }
      if (key.name === "return") {
        // Commit the search: keep the filter, close the input.
        setSearchingBoth(false);
        return;
      }
      if (key.name === "backspace") {
        setSearchQueryBoth(searchQueryRef.current.slice(0, -1));
        return;
      }
      if (
        typeof key.sequence === "string" &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.sequence.charCodeAt(0) >= 32
      ) {
        setSearchQueryBoth(`${searchQueryRef.current}${key.sequence}`);
      }
      return;
    }

    // ── Compose mode: the composer is modal, owning typing, Enter and Esc ──
    if (composingRef.current) {
      if (key.name === "escape") {
        setComposingBoth(false);
        setDraftBoth("");
        return;
      }
      if (key.name === "return") {
        const body = draftRef.current.trim();
        const target = composeTargetRef.current;
        setComposingBoth(false);
        setDraftBoth("");
        if (body.length === 0) return; // empty draft: just close, deliver nothing
        if (!target || target.owner !== owner) {
          setNotice({ text: "no agent selected", tone: "error" });
          return;
        }
        // Audit scoping WRAPS delivery: both refusals happen before `deliver`
        // is called, so canonical's authorization sequence inside it is neither
        // reordered nor weakened — only reached by an in-audit target.
        if (scoped && (!parentScanId || !mailboxHome)) {
          setNotice({ text: "audit messaging namespace not wired", tone: "error" });
          return;
        }
        if (scoped && !Object.hasOwn(subagentsRef.current, target.peer.id)) {
          setNotice({ text: "worker does not belong to this audit", tone: "error" });
          return;
        }
        const result = deliver(target.peer.id, body);
        setNotice(
          result.ok
            ? {
                text: `sent to ${target.peer.id}${result.truncated ? " (truncated)" : ""}`,
                tone: "ok",
              }
            : { text: result.reason ?? "message could not be delivered", tone: "error" },
        );
        return;
      }
      if (key.name === "backspace") {
        setDraftBoth(draftRef.current.slice(0, -1));
        return;
      }
      if (
        typeof key.sequence === "string" &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.sequence.charCodeAt(0) >= 32
      ) {
        setDraftBoth(`${draftRef.current}${key.sequence}`);
      }
      return;
    }

    // ── Focus mode: one subagent, its live transcript, a steer composer ──
    // Esc returns to the LIST (it does not leave the herd screen); up/down
    // scroll the transcript back from its tail; `m`/Enter open the steer
    // composer bound to the focused agent.
    const currentFocusedPeer = focusIdRef.current ? mergedPeers.find(peer => peer.id === focusIdRef.current) : undefined;
    if (currentFocusedPeer) {
      if (key.name === "escape") {
        applyFocusId(null);
        setScrollOffset(0);
        setNotice(null);
        return;
      }
      if (key.name === "up") {
        setScrollOffset((offset) => offset + 1);
        return;
      }
      if (key.name === "down") {
        setScrollOffset((offset) => Math.max(0, offset - 1));
        return;
      }
      if (key.name === "pageup") {
        setScrollOffset((offset) => offset + PAGE_STEP);
        return;
      }
      if (key.name === "pagedown") {
        setScrollOffset((offset) => Math.max(0, offset - PAGE_STEP));
        return;
      }
      if (
        key.name === "return" ||
        (!key.ctrl && !key.meta && (key.sequence === "m" || key.sequence === "M"))
      ) {
        beginCompose(currentFocusedPeer);
        return;
      }
      return;
    }

    // ── Navigation mode ──
    // Optional leader (prefix) chord. Pressing it arms a one-shot prefix so the
    // NEXT key is a leader action; it is off by default. Placed AFTER the
    // Ctrl+C guard at the top of the handler, so quitting is never trapped.
    if (leaderKey !== "off" && !prefixArmedRef.current && keyMatchesChord(key, leaderKey)) {
      prefixArmedRef.current = true;
      setNotice({ text: "prefix — 1-9 focus agent · n/p step", tone: "ok" });
      return;
    }
    if (prefixArmedRef.current) {
      prefixArmedRef.current = false;
      setNotice(null);
      if (!key.ctrl && !key.meta && typeof key.sequence === "string" && /^[1-9]$/.test(key.sequence)) {
        jumpToPeer(Number(key.sequence));
        return;
      }
      if (!key.ctrl && !key.meta && (key.sequence === "n" || key.sequence === "N")) {
        move(1);
        return;
      }
      if (!key.ctrl && !key.meta && (key.sequence === "p" || key.sequence === "P")) {
        move(-1);
        return;
      }
      // Not a leader action: the prefix is spent and this key falls through to
      // normal handling below, so Esc/Enter/arrows are never swallowed by it.
    }
    // Number keys 1-9 jump straight to the N-th agent in the current ordering —
    // always available, no leader required. Digits are otherwise unbound in the
    // roster, so this steals nothing from existing keys.
    if (!key.ctrl && !key.meta && typeof key.sequence === "string" && /^[1-9]$/.test(key.sequence)) {
      jumpToPeer(Number(key.sequence));
      return;
    }
    if (key.name === "escape") {
      onBack();
      return;
    }
    if (key.name === "up") {
      move(-1);
      return;
    }
    if (key.name === "down") {
      move(1);
      return;
    }
    if (key.name === "pageup") {
      move(-PAGE_STEP);
      return;
    }
    if (key.name === "pagedown") {
      move(PAGE_STEP);
      return;
    }
    // Enter drills into the highlighted peer — focus mode. A no-op with nothing
    // highlighted, so it can never enter focus with no subject.
    if (key.name === "return") {
      const activePeer = currentPeer();
      if (activePeer) {
        setNotice(null);
        setScrollOffset(0);
        applyFocusId(activePeer.id);
      }
      return;
    }
    // `s` starts an incremental text filter of the roster. Opens even when the
    // roster is empty so an operator who types `s` reflexively gets feedback.
    if (!key.ctrl && !key.meta && (key.sequence === "s" || key.sequence === "S")) {
      setNotice(null);
      setSearchQueryBoth("");
      setSearchingBoth(true);
      return;
    }
    // `m` opens the steering composer bound to the highlighted peer. A no-op
    // when the roster is empty, so it can never open a composer with no target.
    if (!key.ctrl && !key.meta && (key.sequence === "m" || key.sequence === "M")) {
      const activePeer = currentPeer();
      if (activePeer) beginCompose(activePeer);
      return;
    }
  });

  // The detail column: everything the highlighted peer's RECORD reports —
  // identity, status, model/activity and its recent inbox — fitted to the exact
  // box the shared body hands it, because OpenTUI will not clip an overflow.
  const renderDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    // One column is left for the scrollbar, exactly as the model picker's
    // detail does, so a wrapped line never sits under it.
    const inner = Math.max(1, pane.width - 1);
    // NOT clipped: everything the record reports stays REACHABLE. The pane is
    // a scrollbox bounded to the box the shared body handed it, so metadata
    // that does not fit scrolls instead of being cut away.
    const lines = activePeer
      ? herdDetailLines(activePeer, inbox, inner, now, {
          compact: pane.height < 12,
          homeDir: home,
        })
      : [
          {
            text: rows.length === 0 ? "waiting for the roster" : "select an agent",
            tone: "muted" as const,
          },
        ];
    return (
      <scrollbox
        key={item.id}
        width={pane.width}
        height={pane.height}
        flexShrink={0}
        scrollX={false}
        verticalScrollbarOptions={sleekScrollbar(theme)}
      >
        <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>
          {lines.map((line, index) => (
            <Cells key={`detail-${index}`} width={inner} fg={toneColor(theme, line.tone)}>
              {line.text}
            </Cells>
          ))}
        </box>
      </scrollbox>
    );
  };

  // The single reserved overlay row: while composing, the steering draft;
  // otherwise the most recent delivery notice. Both are budgeted to
  // `contentWidth` by `Cells`, so neither can overrun the row `noticeRows`
  // reserved for it. The search input is not here — it is the picker's own
  // search line, inside the list body.
  const overlayBody = composing ? (
    <box flexDirection="row" width={layout.contentWidth} flexShrink={0} minWidth={0}>
      <Cells width={layout.contentWidth} fg={theme.TEXT}>
        {`${HERD_COMPOSER_PROMPT}${herdComposerVisibleDraft(draft, layout.contentWidth)}${HERD_COMPOSER_CURSOR}`}
      </Cells>
    </box>
  ) : notice ? (
    <box flexDirection="row" width={layout.contentWidth} flexShrink={0} minWidth={0}>
      <Cells width={layout.contentWidth} fg={notice.tone === "ok" ? theme.SUCCESS : theme.ERROR}>
        {notice.text}
      </Cells>
    </box>
  ) : null;

  // Title row: `♙ Agents` on the left; on the right an honest count of the
  // merged roster and the highlighted agent's own status. An empty roster says
  // "none" — the hub still has no producer, and that is the normal state.
  const title = `${operatorIcon("agents", symbols)} ${operatorTitle("agents")}`;
  // Aggregate status + measured-usage header for the live subagent fleet:
  // "4 agents · 2 running · 1 done · 128k tok · 3 findings". Replaces the plain
  // roster count when subagents exist; falls back to the count for a
  // sessions-only or empty roster. Usage is the LIVE telemetry map, joined by id.
  const fleetRecords = Object.values(subagents);
  const fleetSummary =
    fleetRecords.length > 0
      ? summarizeFleet(
          fleetRecords.map((r) => (r.operatorStopped ? "cancelled" : r.status)),
          fleetRecords.map((r) => {
            const t = telemetry[r.agentId];
            return {
              ...(typeof t?.inputTokens === "number" ? { inputTokens: t.inputTokens } : {}),
              ...(typeof t?.outputTokens === "number" ? { outputTokens: t.outputTokens } : {}),
              ...(typeof r.findings === "number" ? { findings: r.findings } : {}),
            };
          }),
        )
      : "";
  const listMeta = [
    fleetSummary || herdDialogMeta(dialogItems.length, mergedPeers.length),
    activeRow?.kind === "peer" ? herdStatusLabel(activeRow.status) : "",
  ].filter(Boolean).join(" · ");
  const titleCols = paneTitleColumns(layout.contentWidth, listMeta.length);

  // While the search input is open the query carries a caret so the operator
  // can see where they are typing; otherwise the committed filter is shown.
  const searchText = searching ? `${searchQuery}${HERD_COMPOSER_CURSOR}` : searchQuery;

  const listView = (
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
      <box flexDirection="row" width={layout.contentWidth} flexShrink={0} minWidth={0}>
        <Cells width={titleCols.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
          {title}
        </Cells>
        <Cells width={titleCols.gap}>{""}</Cells>
        <Cells width={titleCols.metaWidth} align="right" fg={theme.MUTED}>
          {listMeta}
        </Cells>
      </box>
      <DialogSelectBody
        items={dialogItems}
        cursor={dialogCursor}
        panel={panel}
        query={searchText}
        placeholder="s to search agents"
        emptyText={HERD_EMPTY_TEXT}
        renderDetail={renderDetail}
        onActivateRow={selectRow}
        onHoverRow={selectRow}
        onScroll={move}
      />
      {overlayBody}
    </box>
  );

  // ── Focus view: one subagent's meta stacked over its live transcript ──
  // Every number comes off `focusLayout`; the two panes are the full content
  // width (a single column) so they can only fail vertically, which the
  // allocator has already fitted. The transcript renders a tail window over
  // the agent's activity ring, scrolled back by `scrollOffset`.
  // NOT clipped: the focused agent's identity and model metadata stay
  // reachable — the pane below scrolls when they do not fit, rather than
  // cutting them off.
  const focusMetaLines = focused
    ? (
        focusHeaderLines(focusedPeer, focusRecord, Math.max(1, focusLayout.meta.innerWidth - 1), now, {
          compact: !focusLayout.bordered,
          // MEASURED telemetry for the focused agent, joined by `agent_id`.
          ...(focusId && telemetry[focusId] ? { telemetry: telemetry[focusId] } : {}),
          // Sibling index/total mirrors OpenCode's subagent-footer identity:
          // tells the operator where this subagent sits among its siblings in
          // the merged roster. Computed from same-parent live subagent records.
          siblingIndex: focusId
            ? Object.values(subagents)
                .filter((r) => r.parentScanId === focusRecord?.parentScanId && r.agentId !== focusId)
                .findIndex(() => true) >= 0
              ? // All subagents sharing the same parent; find this agent's position.
                (() => {
                  const siblings = Object.values(subagents).filter(
                    (r) => r.parentScanId === focusRecord?.parentScanId,
                  );
                  const idx = siblings.findIndex((r) => r.agentId === focusId);
                  return idx >= 0 ? idx + 1 : undefined;
                })()
              : undefined
            : undefined,
          siblingTotal: focusId
            ? Object.values(subagents).filter(
                (r) => r.parentScanId === focusRecord?.parentScanId,
              ).length || undefined
            : undefined,
        })
      )
    : [];
  const focusActivityLines =
    focused && focusRecord
      ? renderFocusActivity(focusRecord.activity, focusLayout.transcript.innerWidth)
      : [];
  const focusTail = windowFocusTail(
    focusActivityLines.length,
    focusLayout.transcript.bodyRows,
    scrollOffset,
  );
  const focusVisibleActivity = focusActivityLines.slice(focusTail.start, focusTail.end);

  // Scroll position label: tells the operator whether they are at the newest
  // activity (↓ new), scrolled back (−N), or at the very top (↑ top).
  const focusPos = focusScrollPosition(
    focusActivityLines.length,
    focusLayout.transcript.bodyRows,
    scrollOffset,
  );

  const focusView = (
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
      <box flexDirection="column" flexShrink={0} minWidth={0}>
        <Pane
          pane={focusLayout.meta}
          bordered={focusLayout.bordered}
          title={`${operatorIcon("agents", symbols)} Focus`}
          meta={focusRecord ? subagentStatusLabel(focusRecord.status) : undefined}
        >
          <scrollbox
            width={focusLayout.meta.innerWidth}
            height={Math.max(1, focusLayout.meta.bodyRows)}
            flexShrink={0}
            scrollX={false}
            verticalScrollbarOptions={sleekScrollbar(theme)}
          >
            <box
              width={Math.max(1, focusLayout.meta.innerWidth - 1)}
              flexDirection="column"
              flexShrink={0}
              minWidth={0}
            >
              {focusMetaLines.map((line, index) => (
                <Cells
                  key={`meta-${index}`}
                  width={Math.max(1, focusLayout.meta.innerWidth - 1)}
                  fg={toneColor(theme, line.tone)}
                >
                  {line.text}
                </Cells>
              ))}
            </box>
          </scrollbox>
        </Pane>
        <Pane
          pane={focusLayout.transcript}
          bordered={focusLayout.bordered}
          title={herdFocusTranscriptTitle(focusActivityLines.length)}
          meta={focusPos || undefined}
        >
          {focusVisibleActivity.length === 0 ? (
            <Cells width={focusLayout.transcript.innerWidth} fg={theme.MUTED}>
              {HERD_FOCUS_EMPTY_TEXT}
            </Cells>
          ) : (
            focusVisibleActivity.map((line, index) => (
              <Cells
                key={`live-${focusTail.start + index}`}
                width={focusLayout.transcript.innerWidth}
                fg={toneColor(theme, line.tone)}
              >
                {line.text}
              </Cells>
            ))
          )}
        </Pane>
      </box>
      {overlayBody}
    </box>
  );

  const body = focused ? focusView : listView;

  // While composing, the footer names the bound steer target; in focus mode the
  // focus keymap; otherwise the list navigation hint.
  const hint = composing
    ? `to ${steerTarget?.id ?? "?"} · ${herdComposerFooterHint()}`
    : focused
      ? herdFocusFooterHint()
      : herdFooterHint();

  return <>{frame({ body, hint })}</>;
}
