/** @jsxImportSource @opentui/react */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme, type Theme } from "./theme-context.js";
import { severityToneFor } from "./themes.js";
import { fitTuiText, fitTuiUrl } from "./text.js";
import { useSettings } from "./settings-store.js";
import { frameAt } from "./animation.js";
import { SHIMMER_TEXT_INTERVAL_MS } from "./animations.js";
import { ShimmerText } from "./chat/shimmer.js";
import {
  PANEL_HORIZONTAL_CHROME,
  SCROLLBAR_COLUMN,
  SESSION_LAYOUT_GAP,
  getFooterLayout,
  getOverlayBodyRows,
  getOverlayLayout,
  getSessionLayout,
} from "./shell-geometry.js";
import { FooterBar, OverlayFrame, RailBar, ShellFrame } from "./shell-frame.js";
import type { ShellNav } from "./shell-nav.js";
import {
  PaletteOverlay,
  createShellCommands,
  filterCommands,
  type PaletteCommand,
} from "./command-palette.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import type { SessionState, TranscriptItem } from "./session-state.js";
import { TranscriptReview } from "./chat/TranscriptReview.js";
import type { TranscriptReviewRenderable } from "./transcript-review-renderable.js";
import { createSessionTranscriptDocument } from "./session-presentation.js";


// Historic caps on overlay list length, kept so a tall terminal renders
// exactly what it did before; the height budget only ever lowers them.
const TIMELINE_MAX_TURNS = 10;
// Historic cap on the live session's sidebar findings list.
const SESSION_MAX_SIDEBAR_FINDINGS = 8;

function parseToolAction(theme: Theme, action: string): {
  kind: "http" | "crawl" | "bash" | "save" | "read" | "run" | "install" | "summary" | "generic";
  title: string;
  meta?: string;
  tone: string;
} {
  if (action.startsWith("http_request:")) {
    const rest = action.slice("http_request:".length).trim();
    const parts = rest.split(/\s+/);
    const method = parts[0] ?? "GET";
    const url = parts.slice(1).join(" ");
    return {
      kind: "http",
      title: `${method} ${url || "request"}`,
      meta: "http request",
      tone: theme.PRIMARY,
    };
  }
  if (action.startsWith("crawl:")) {
    return {
      kind: "crawl",
      title: action.slice("crawl:".length).trim() || "crawl",
      meta: "crawl",
      tone: theme.PRIMARY,
    };
  }
  if (action.startsWith("bash:")) {
    return {
      kind: "bash",
      title: action.slice("bash:".length).trim() || "shell",
      meta: "shell",
      tone: theme.PRIMARY,
    };
  }
  if (action.startsWith("save_finding:")) {
    return {
      kind: "save",
      title: action.slice("save_finding:".length).trim() || "saved finding",
      meta: "finding",
      tone: theme.SUCCESS,
    };
  }
  if (action.startsWith("read_file:")) {
    return {
      kind: "read",
      title: action.slice("read_file:".length).trim() || "source file",
      meta: "reading source",
      tone: theme.INFO,
    };
  }
  if (action.startsWith("run_command:")) {
    return {
      kind: "run",
      title: action.slice("run_command:".length).trim() || "command",
      meta: "running command",
      tone: theme.PRIMARY,
    };
  }
  if (action.startsWith("Reading ")) {
    return {
      kind: "read",
      title: action.slice("Reading ".length).trim() || "source file",
      meta: "reading source",
      tone: theme.INFO,
    };
  }
  if (action.startsWith("Running: ")) {
    return {
      kind: "run",
      title: action.slice("Running: ".length).trim() || "command",
      meta: "running command",
      tone: theme.PRIMARY,
    };
  }
  if (action.startsWith("Installing ") || action.startsWith("Installed ")) {
    return {
      kind: "install",
      title: action,
      meta: "preparing package",
      tone: theme.ACCENT,
    };
  }
  if (action.startsWith("Target ready:") || action.startsWith("Analysis complete:") || action.startsWith("done:")) {
    return {
      kind: "summary",
      title: action,
      meta: "stage summary",
      tone: theme.MUTED,
    };
  }
  return {
      kind: "generic",
      title: action,
      meta: undefined,
      tone: theme.TEXT,
    };
}

function renderToolActionLine(theme: Theme, action: string, key: string, maxWidth: number) {
  const parsed = parseToolAction(theme, action);
  const contentWidth = Math.max(8, maxWidth - 2);
  return (
    <box key={key} flexDirection="row" width="100%" minWidth={0}>
      <text width={1} flexShrink={0} fg={parsed.tone}>•</text>
      <box flexDirection="column" marginLeft={1} flexGrow={1} minWidth={0}>
        <text fg={parsed.tone} wrapMode="word">{fitTuiText(parsed.title, contentWidth)}</text>
        {parsed.meta ? <text fg={theme.MUTED}>{fitTuiText(parsed.meta, contentWidth)}</text> : null}
      </box>
    </box>
  );
}

function TimelineOverlay({
  selected,
  turns,
}: {
  selected: number;
  turns: TranscriptItem[];
}) {
  const theme = useTheme();
  const { width, height } = useSurfaceDimensions();
  const contentWidth = Math.max(8, getOverlayLayout(width).contentWidth - 2);
  // Same unbordered-overflow trap as the palette: each turn costs two rows
  // (text plus stage line), so only take the turns the frame can hold.
  const visibleTurns = Math.max(
    1,
    Math.min(TIMELINE_MAX_TURNS, Math.floor(getOverlayBodyRows(height) / 2)),
  );

  return (
    <OverlayFrame title="TURN TIMELINE" footer="ctrl+j close · enter jump · esc cancel">
        {turns.slice(0, visibleTurns).map((turn, index) => {
          const active = index === selected;
          return (
            <box key={turn.id} flexDirection="row" width="100%" minWidth={0}>
              <RailBar tone={active ? theme.PRIMARY : theme.BORDER} />
              <box flexDirection="column" marginLeft={1} flexGrow={1} minWidth={0}>
                <text fg={active ? theme.TEXT : "#CCCCCC"} wrapMode="word">{fitTuiText(turn.text, contentWidth)}</text>
                <text fg={active ? theme.ACCENT : theme.MUTED}>{fitTuiText(`${turn.stage ?? "session"}${turn.turn !== undefined ? ` · turn ${turn.turn}` : ""}`, contentWidth)}</text>
              </box>
            </box>
          );
        })}
    </OverlayFrame>
  );
}

function ComposeOverlay({ text }: { text: string }) {
  const theme = useTheme();
  const { width } = useSurfaceDimensions();
  const contentWidth = getOverlayLayout(width).contentWidth;
  const inputWidth = Math.max(1, contentWidth - 3);

  return (
    <OverlayFrame title="MESSAGE TO AGENT" footer="enter send · esc cancel">
      <text fg={theme.MUTED} wrapMode="word">{fitTuiText("will be injected at next turn boundary", contentWidth)}</text>
      <box flexDirection="row" marginTop={1} width="100%" minWidth={0}>
        <text width={2} flexShrink={0} fg={theme.PRIMARY}>&gt; </text>
        <box width={inputWidth} flexShrink={0} minWidth={0}>
          <text fg={theme.TEXT} wrapMode="word">{fitTuiText(text || " ", inputWidth)}</text>
        </box>
        <text width={1} flexShrink={0} fg={theme.INFO}>█</text>
      </box>
    </OverlayFrame>
  );
}

function LiveBadge({ label, active = true }: { label: string; active?: boolean }) {
  const theme = useTheme();
  const { width } = useSurfaceDimensions();
  // The badge is only ever rendered as FooterBar's status, so it spends the
  // cells the footer reserved for that slot — the dot and the space in front
  // of the label come out of that allowance rather than being added to it.
  const labelWidth = Math.max(1, getFooterLayout(width, true).statusWidth - 2);

  return (
    <box flexDirection="row" width="100%" minWidth={0}>
      <text width={1} flexShrink={0} fg={active ? theme.SUCCESS : theme.MUTED}>●</text>
      <text flexShrink={0} fg={theme.MUTED}>{` ${fitTuiText(label, labelWidth)}`}</text>
    </box>
  );
}


function WorkingPulse({ label, detail, maxWidth }: { label: string; detail?: string; maxWidth: number }) {
  const theme = useTheme();
  const { reduceMotion } = useSettings();
  const startedAt = useMemo(() => Date.now(), [label]);
  const [frame, setFrame] = useState(0);
  const contentWidth = Math.max(1, maxWidth);

  useEffect(() => {
    const timer = setInterval(
      () => setFrame((current) => current + 1),
      reduceMotion ? 1000 : SHIMMER_TEXT_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [reduceMotion]);

  const animation = frameAt("tool", Date.now() - startedAt, { motion: !reduceMotion });
  const loader = animation.glyph;
  const workingLabel = `${label}${animation.elapsedLabel ? ` · ${animation.elapsedLabel}` : ""}`;
  // Reserve the rail, panel padding, glyph and gap before fitting the label.
  const innerWidth = Math.max(1, contentWidth - 4);
  const labelWidth = Math.max(1, innerWidth - loader.length - 1);

  return (
    <box flexDirection="row" marginTop={1} width="100%" minWidth={0}>
      <RailBar tone={theme.PRIMARY} />
      <box flexDirection="column" marginLeft={1} backgroundColor={theme.PANEL_ALT} paddingX={1} flexGrow={1} minWidth={0}>
        <box flexDirection="row" width="100%" minWidth={0}>
          <text width={loader.length} flexShrink={0} fg={theme.ACCENT}>{loader}</text>
          <box width={labelWidth} flexShrink={0} marginLeft={1} minWidth={0}>
            {reduceMotion ? (
              <text fg={theme.MUTED}>{fitTuiText(workingLabel, labelWidth)}</text>
            ) : (
              <ShimmerText label={fitTuiText(workingLabel, labelWidth)} frame={frame} base={theme.MUTED} peak={theme.TEXT} />
            )}
          </box>
        </box>
        {detail ? <text fg={theme.MUTED} wrapMode="word">{fitTuiText(detail, innerWidth)}</text> : null}
      </box>
    </box>
  );
}

function formatLiveActivity(theme: Theme, state: SessionState, runningStage: SessionState["stages"][number] | null, latestRunningAction?: string): {
  label: string;
  detail?: string;
} {
  if (state.thinking) {
    return {
      label: "thinking",
      detail: state.thinking,
    };
  }

  const liveTool = formatActiveToolLabel(theme, latestRunningAction);
  return {
    label: liveTool.label,
    detail: latestRunningAction ? liveTool.detail : (runningStage?.detail ?? "waiting for the next tool result"),
  };
}

function formatActiveToolLabel(theme: Theme, action?: string): { label: string; detail?: string } {
  if (!action) return { label: "agent working", detail: "waiting for the next tool result" };

  const parsed = parseToolAction(theme, action);
  switch (parsed.kind) {
    case "http":
      return { label: "http request in flight", detail: parsed.title };
    case "crawl":
      return { label: "crawl in progress", detail: parsed.title };
    case "bash":
      return { label: "shell tool running", detail: parsed.title };
    case "save":
      return { label: "saving finding", detail: parsed.title };
    case "read":
      return { label: "reading source", detail: parsed.title };
    case "run":
      return { label: "running command", detail: parsed.title };
    case "install":
      return { label: "preparing target", detail: parsed.title };
    case "summary":
      return { label: "stage update", detail: parsed.title };
    default:
      return { label: "tool call in progress", detail: parsed.title };
  }
}

function railTone(theme: Theme, item: TranscriptItem): string {
  switch (item.tone) {
    case "primary": return theme.PRIMARY;
    case "success": return theme.SUCCESS;
    case "warning": return theme.WARNING;
    case "error": return theme.ERROR;
    case "info": return theme.INFO;
    default: return theme.BORDER;
  }
}

function textTone(theme: Theme, item: TranscriptItem): string {
  switch (item.tone) {
    case "primary": return theme.TEXT;
    case "success": return theme.SUCCESS;
    case "warning": return theme.WARNING;
    case "error": return theme.ERROR;
    case "info": return theme.INFO;
    default: return item.kind === "finding" ? theme.PRIMARY : item.kind === "thinking" ? theme.MUTED : theme.TEXT;
  }
}

function renderTranscriptItem(
  theme: Theme,
  item: TranscriptItem,
  options: {
    expanded: Set<string>;
    toggleExpanded: (id: string) => void;
    hoveredToolId: string | null;
    setHoveredToolId: (id: string | null) => void;
    contentWidth: number;
  },
) {
  const contentWidth = Math.max(12, options.contentWidth);
  // Every variant starts with a one-cell rail and a one-cell margin, and the
  // padded and bordered variants spend more on top of that. Budgeting all of
  // them against the raw transcript width let each one overrun its own box —
  // and on the bordered tool card that meant the header row fused.
  const railedWidth = Math.max(8, contentWidth - 2);
  const paddedWidth = Math.max(8, railedWidth - 2);
  const cardWidth = Math.max(8, railedWidth - 4);

  if (item.kind === "turn") {
    return (
      <box key={item.id} flexDirection="row" marginTop={1} width="100%" minWidth={0}>
        <RailBar tone={theme.PRIMARY} />
        <box flexDirection="column" marginLeft={1} backgroundColor={theme.PANEL_ALT} paddingX={1} flexGrow={1} minWidth={0}>
          <text fg={theme.TEXT} wrapMode="word">{fitTuiText(item.text.toUpperCase(), paddedWidth)}</text>
          <text fg={theme.MUTED}>{fitTuiText(`${item.stage ?? "session"}${item.turn !== undefined ? ` · operator turn ${item.turn}` : ""}`, paddedWidth)}</text>
        </box>
      </box>
    );
  }

  if (item.kind === "tool-group") {
    const actions = item.actions ?? [];
    const preview = actions.slice(0, Math.min(actions.length, 2));
    const isExpandable = actions.length > preview.length;
    const isExpanded = isExpandable && options.expanded.has(item.id);
    const isHovered = isExpandable && options.hoveredToolId === item.id;
    const controlWidth = isExpandable && cardWidth >= 40
      ? Math.min(22, Math.floor(cardWidth * 0.4))
      : 0;
    const controlGap = controlWidth > 0 ? 1 : 0;
    const titleWidth = Math.max(1, cardWidth - controlWidth - controlGap);
    return (
      <box key={item.id} flexDirection="row" width="100%" minWidth={0}>
        <RailBar tone={isHovered ? theme.PRIMARY : railTone(theme, item)} />
        <box
          flexDirection="column"
          marginLeft={1}
          backgroundColor={isHovered ? theme.PANEL : theme.PANEL_ALT}
          border
          borderColor={isHovered || isExpanded ? theme.MUTED : theme.BORDER}
          paddingX={1}
          paddingY={0}
          flexGrow={1}
          minWidth={0}
          onMouseDown={isExpandable ? () => options.toggleExpanded(item.id) : undefined}
          onMouseOver={isExpandable ? () => options.setHoveredToolId(item.id) : undefined}
          onMouseOut={isExpandable ? () => options.setHoveredToolId(null) : undefined}
        >
          <box flexDirection="row" width={cardWidth} minWidth={0} gap={controlGap}>
            <box width={titleWidth} flexShrink={0} minWidth={0}>
              <text fg={isHovered ? theme.PRIMARY : theme.TEXT}>{fitTuiText((item.label ?? "Actions").toUpperCase(), titleWidth)}</text>
            </box>
            {controlWidth > 0 ? (
              <box width={controlWidth} flexShrink={0} minWidth={0} alignItems="flex-end">
                <text fg={isHovered ? theme.ACCENT : theme.MUTED}>{fitTuiText(isExpanded ? "click to collapse" : "click to expand", controlWidth)}</text>
              </box>
            ) : null}
          </box>
          <text fg={theme.MUTED}>{fitTuiText(`${item.stage}${item.turn !== undefined ? ` · turn ${item.turn}` : ""}`, cardWidth)}</text>
          <text fg={theme.MUTED} wrapMode="word">{fitTuiText(item.text, cardWidth)}</text>
          {(isExpanded ? actions : preview).map((action, index) => renderToolActionLine(theme, action, `${item.id}-${index}`, cardWidth))}
          {isExpandable && !isExpanded ? <text fg={theme.MUTED}>{fitTuiText(`${actions.length - preview.length} more hidden`, cardWidth)}</text> : null}
        </box>
      </box>
    );
  }

  if (item.kind === "user-inject") {
    return (
      <box key={item.id} flexDirection="row" width="100%" minWidth={0}>
        <RailBar tone={theme.ACCENT} />
        <box flexDirection="column" marginLeft={1} flexGrow={1} minWidth={0}>
          <text fg={theme.ACCENT}>{fitTuiText("USER MESSAGE INJECTED", railedWidth)}</text>
          <text fg={theme.TEXT} wrapMode="word">{fitTuiText(item.text, railedWidth)}</text>
        </box>
      </box>
    );
  }

  return (
    <box key={item.id} flexDirection="row" width="100%" minWidth={0}>
      <RailBar tone={railTone(theme, item)} />
      <box flexDirection="column" marginLeft={1} flexGrow={1} minWidth={0}>
        {item.stage ? <text fg={theme.MUTED}>{fitTuiText(item.stage, railedWidth)}</text> : null}
        <text fg={textTone(theme, item)} wrapMode="word">{fitTuiText(item.text, railedWidth)}</text>
      </box>
    </box>
  );
}

function PanelSection({
  title,
  tone,
  contentWidth,
  children,
}: {
  title: string;
  tone: string;
  /** Inner cells the section was given; the title is budgeted against it. */
  contentWidth?: number;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    // flexShrink is off because the section draws its own border: squeeze it
    // and Yoga paints that bottom border straight through the last row of
    // content. Overflowing off-screen is recoverable; a corrupt frame is not.
    <box flexDirection="column" flexShrink={0} minWidth={0} border borderColor={tone} backgroundColor={theme.PANEL} paddingX={1} paddingY={0}>
      <text fg={tone}>{fitTuiText(title.toUpperCase(), contentWidth ?? 44)}</text>
      <box flexDirection="column" minWidth={0}>
        {children}
      </box>
    </box>
  );
}

export function SessionScreen({ state, onExit, shell, queueUserMessage }: { state: SessionState; onExit: () => void; shell?: ShellNav; queueUserMessage?: (text: string) => void }) {
  const theme = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelected, setPaletteSelected] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineSelected, setTimelineSelected] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [expandedToolCards, setExpandedToolCards] = useState<Set<string>>(new Set());
  const [hoveredToolId, setHoveredToolId] = useState<string | null>(null);
  const [visibleFromTurnId, setVisibleFromTurnId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewRenderableRef = useRef<TranscriptReviewRenderable | null>(null);
  const { width, height } = useSurfaceDimensions();
  const sessionLayout = getSessionLayout(width, height);
  const sidebarOpen = sidebarVisible && sessionLayout.sidebarCanFit;
  const sidebarTextWidth = Math.max(12, sessionLayout.sidebarWidth - PANEL_HORIZONTAL_CHROME - SCROLLBAR_COLUMN);
  const apiStatus = state.connection.apiConnected
    ? "connected"
    : state.connection.apiConfigured
      ? "configured"
      : "missing";
  const apiProviderLabel = state.connection.apiProviderLabel ?? "unknown";
  const apiProviderWidth = Math.max(1, sidebarTextWidth - `api ${apiStatus} · `.length);
  const localRuntimesWidth = Math.max(1, sidebarTextWidth - "local ".length);
  const modelWidth = Math.max(1, sidebarTextWidth - "model ".length);
  // Counters were interpolated raw next to their labels. The sidebar is only
  // ~24 cells wide, so a six-figure token count or a long transcript ran the
  // pair past the panel border; budget each value against its own label.
  const tokensValueWidth = Math.max(1, sidebarTextWidth - "tokens ".length);
  const costValueWidth = Math.max(1, sidebarTextWidth - "cost ".length);
  const transcriptCountWidth = Math.max(1, sidebarTextWidth - "transcript ".length);
  const turnsCountWidth = Math.max(1, sidebarTextWidth - "turns ".length);
  const findingsCountWidth = Math.max(1, sidebarTextWidth - "findings ".length);
  const transcriptContentWidth = Math.max(
    12,
    (sidebarOpen ? sessionLayout.transcriptWidth : sessionLayout.contentWidth)
      - PANEL_HORIZONTAL_CHROME
      - SCROLLBAR_COLUMN,
  );

  const toggleToolCard = (id: string) => {
    setExpandedToolCards((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toolCardIds = useMemo(
    () => state.transcript.filter((item) => item.kind === "tool-group").map((item) => item.id),
    [state.transcript],
  );
  const turnItems = useMemo(
    () => state.transcript.filter((item) => item.kind === "turn"),
    [state.transcript],
  );
  const visibleTranscript = useMemo(() => {
    if (!visibleFromTurnId) return state.transcript;
    const index = state.transcript.findIndex((item) => item.id === visibleFromTurnId);
    return index >= 0 ? state.transcript.slice(index) : state.transcript;
  }, [state.transcript, visibleFromTurnId]);
  const sessionTranscript = useMemo(() => createSessionTranscriptDocument(state), [state]);
  const sessionReviewExpandedTurns = useMemo(() => new Set<number>(), []);

  const paletteCommands = useMemo<PaletteCommand[]>(() => [
    {
      id: "expand-tools",
      title: "Expand tool cards",
      category: "Display",
      description: "Show full details for grouped tool activity",
      keybind: "e",
      suggested: true,
      action: () => setExpandedToolCards(new Set(toolCardIds)),
    },
    {
      id: "collapse-tools",
      title: "Collapse tool cards",
      category: "Display",
      description: "Return grouped tool activity to compact previews",
      keybind: "shift+e",
      suggested: true,
      action: () => setExpandedToolCards(new Set()),
    },
    {
      id: "toggle-sidebar",
      title: sidebarOpen ? "Hide sidebar" : "Show sidebar",
      category: "Display",
      description: sidebarOpen
        ? "Hide the right-hand session context"
        : sessionLayout.sidebarCanFit
          ? "Show target, runtime, and pipeline context"
          : "Sidebar is available on a wider terminal",
      keybind: "ctrl+\\",
      suggested: true,
      action: () => setSidebarVisible((current) => !current),
    },
    {
      id: "open-timeline",
      title: "Open turn timeline",
      category: "Session",
      description: "Jump directly to a transcript turn",
      keybind: "ctrl+j",
      suggested: true,
      action: () => {
        setTimelineOpen(true);
        setTimelineSelected(0);
      },
    },
    {
      id: "clear-turn-focus",
      title: "Show full transcript",
      category: "Session",
      description: "Clear the current turn jump focus",
      suggested: true,
      action: () => setVisibleFromTurnId(null),
    },
    {
      id: "open-transcript-review",
      title: "Open transcript review",
      category: "Display",
      description: "Open the shared native transcript review surface",
      keybind: "ctrl+o",
      suggested: true,
      action: () => setReviewOpen(true),
    },
    ...(!state.summary && queueUserMessage ? [{
      id: "inject-message",
      title: "Send message to agent",
      category: "Session",
      description: "Inject a message at the next turn boundary",
      keybind: "i",
      suggested: true,
      action: () => { setComposeOpen(true); setComposeText(""); },
    }] : []),
    {
      id: "close-session",
      title: "Close engagement view",
      category: "Engagement",
      description: "Leave the engagement view",
      keybind: "esc",
      suggested: true,
      action: onExit,
    },
    ...createShellCommands(shell),
  ], [onExit, sessionLayout.sidebarCanFit, shell, sidebarOpen, toolCardIds]);

  const filteredPalette = useMemo(() => {
    const base = paletteQuery.trim() ? paletteCommands : paletteCommands.filter((command) => command.suggested);
    return filterCommands(base, paletteQuery);
  }, [paletteCommands, paletteQuery]);

  useKeyboard((key) => {
    if (key.ctrl && (key.name === "p" || key.name === "k")) {
      setPaletteOpen((current) => !current);
      setPaletteQuery("");
      setPaletteSelected(0);
      return;
    }

    if (key.ctrl && key.name === "j") {
      setTimelineOpen((current) => !current);
      setTimelineSelected(0);
      return;
    }

    if (key.ctrl && key.sequence === "\\") {
      setSidebarVisible((current) => !current);
      return;
    }

    if (shell && key.sequence === "[") {
      shell.goBack();
      return;
    }
    if (shell && key.sequence === "]") {
      shell.goForward();
      return;
    }
    if (reviewOpen) {
      if (key.ctrl && key.name === "c") {
        onExit();
        return;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "o")) {
        setReviewOpen(false);
        return;
      }

      const review = reviewRenderableRef.current;
      if (!review) return;
      const pageRows = Math.max(1, Math.floor(review.height / 2));
      if (key.name === "pageup" || (key.ctrl && key.name === "up")) {
        review.scrollY -= pageRows;
        return;
      }
      if (key.name === "pagedown" || (key.ctrl && key.name === "down")) {
        review.scrollY += pageRows;
        return;
      }
      if (key.ctrl && key.name === "home") {
        review.scrollY = 0;
        return;
      }
      if (key.ctrl && key.name === "end") {
        review.scrollY = review.maxScrollY;
      }
      return;
    }
    if (key.ctrl && key.name === "o") {
      setReviewOpen(true);
      return;
    }

    if (composeOpen) {
      if (key.name === "escape") {
        setComposeOpen(false);
        setComposeText("");
        return;
      }
      if (key.name === "return") {
        const trimmed = composeText.trim();
        if (trimmed && queueUserMessage) {
          queueUserMessage(trimmed);
        }
        setComposeOpen(false);
        setComposeText("");
        return;
      }
      if (key.name === "backspace") {
        setComposeText((current) => current.slice(0, -1));
        return;
      }
      if (key.sequence && !key.ctrl && !key.meta && key.name !== "return") {
        setComposeText((current) => current + key.sequence);
      }
      return;
    }

    if (timelineOpen) {
      if (key.name === "escape") {
        setTimelineOpen(false);
        return;
      }
      if (key.name === "up") {
        setTimelineSelected((current) => Math.max(0, current - 1));
        return;
      }
      if (key.name === "down") {
        setTimelineSelected((current) => Math.min(Math.max(turnItems.length - 1, 0), current + 1));
        return;
      }
      if (key.name === "return") {
        const target = turnItems[timelineSelected];
        if (target) setVisibleFromTurnId(target.id);
        setTimelineOpen(false);
        return;
      }
      return;
    }

    if (paletteOpen) {
      if (key.name === "escape") {
        setPaletteOpen(false);
        setPaletteQuery("");
        setPaletteSelected(0);
        return;
      }
      if (key.name === "up") {
        setPaletteSelected((current) => Math.max(0, current - 1));
        return;
      }
      if (key.name === "down") {
        setPaletteSelected((current) => Math.min(Math.max(filteredPalette.length - 1, 0), current + 1));
        return;
      }
      if (key.name === "return") {
        filteredPalette[paletteSelected]?.action();
        setPaletteOpen(false);
        return;
      }
      if (key.name === "backspace") {
        setPaletteQuery((current) => current.slice(0, -1));
        return;
      }
      if (key.sequence && !key.ctrl && !key.meta && key.name !== "return") {
        setPaletteQuery((current) => current + key.sequence);
        setPaletteSelected(0);
      }
      return;
    }

    if (key.sequence === "e") {
      setExpandedToolCards(new Set(toolCardIds));
      return;
    }
    if (key.sequence === "E") {
      setExpandedToolCards(new Set());
      return;
    }
    if (key.sequence === "i" && !state.summary && queueUserMessage) {
      setComposeOpen(true);
      setComposeText("");
      return;
    }
    if ((key.ctrl && key.name === "c") || (state.summary && (key.name === "escape" || key.name === "q" || key.name === "return"))) {
      onExit();
    }
  });

  const summary = state.summary;
  const totalFindings = state.stages.reduce((count, stage) => count + stage.findings.length, 0);
  const runningStage = state.stages.find((stage) => stage.status === "running") ?? null;
  const latestRunningAction = runningStage?.actions.at(-1);
  const liveActivity = formatLiveActivity(theme, state, runningStage, latestRunningAction);

  return (
    <ShellFrame
      view={reviewOpen ? "transcript review" : summary ? "report" : "live session"}
      status={sidebarOpen ? state.mode : `${state.mode} · compact`}
    >
      {paletteOpen ? <PaletteOverlay title="Session commands" query={paletteQuery} selected={paletteSelected} commands={filteredPalette} /> : null}
      {timelineOpen ? <TimelineOverlay selected={timelineSelected} turns={turnItems} /> : null}
      {composeOpen ? <ComposeOverlay text={composeText} /> : null}
      {reviewOpen ? (
        <TranscriptReview
          transcript={sessionTranscript}
          width={sessionLayout.contentWidth}
          detail="expanded"
          expandedTurns={sessionReviewExpandedTurns}
          theme={theme}
          renderableRef={reviewRenderableRef}
        />
      ) : (
      <box flexDirection="row" gap={sidebarOpen ? SESSION_LAYOUT_GAP : 0} flexGrow={1} width="100%" minWidth={0} minHeight={0}>
        <scrollbox
          width={sidebarOpen ? sessionLayout.transcriptWidth : "100%"}
          flexGrow={sidebarOpen ? 0 : 1}
          flexShrink={0}
          minWidth={0}
          minHeight={0}
          stickyScroll
          stickyStart="bottom"
          border
          borderColor={theme.BORDER}
          focusedBorderColor={theme.BORDER}
          backgroundColor={theme.PANEL}
          paddingX={1}
          paddingY={0}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.PANEL_ALT,
              foregroundColor: theme.MUTED,
            },
            arrowOptions: {
              foregroundColor: theme.MUTED,
              backgroundColor: theme.PANEL,
            },
          }}
        >
          <box flexDirection="column" width="100%" minWidth={0}>
            {visibleTranscript.map((item) => renderTranscriptItem(theme, item, {
              expanded: expandedToolCards,
              toggleExpanded: toggleToolCard,
              hoveredToolId,
              setHoveredToolId,
              contentWidth: transcriptContentWidth,
            }))}
            {!summary ? (
              <WorkingPulse
                label={liveActivity.label}
                detail={liveActivity.detail}
                maxWidth={transcriptContentWidth}
              />
            ) : null}
          </box>
        </scrollbox>
        {sidebarOpen ? <scrollbox
          width={sessionLayout.sidebarWidth}
          flexShrink={0}
          minWidth={0}
          minHeight={0}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.PANEL_ALT,
              foregroundColor: theme.MUTED,
            },
            arrowOptions: {
              foregroundColor: theme.MUTED,
              backgroundColor: theme.PANEL,
            },
          }}
        >
          <PanelSection title="Target" contentWidth={sidebarTextWidth} tone={theme.PRIMARY}>
            <box flexDirection="column" minWidth={0}>
              <text fg={theme.TEXT}>{fitTuiUrl(state.target, sidebarTextWidth)}</text>
              <text fg={theme.MUTED}>{fitTuiText(`${state.mode} · ${state.depth}`, sidebarTextWidth)}</text>
            </box>
          </PanelSection>
          <PanelSection title="Runtime" contentWidth={sidebarTextWidth} tone={state.connection.apiConnected ? theme.SUCCESS : state.connection.apiConfigured ? theme.WARNING : theme.BORDER}>
            <box flexDirection="column" minWidth={0}>
              <text fg={theme.TEXT}>selected {fitTuiText(state.connection.runtime, Math.max(1, sidebarTextWidth - "selected ".length))}</text>
              <box flexDirection="row" width="100%" minWidth={0}>
                <text flexShrink={0} fg={theme.TEXT}>api {apiStatus} </text>
                <text fg={theme.MUTED}>· {fitTuiText(apiProviderLabel, apiProviderWidth)}</text>
              </box>
              <box flexDirection="row" width="100%" minWidth={0}>
                <text flexShrink={0} fg={theme.TEXT}>local </text>
                <text fg={theme.MUTED}>{fitTuiText(state.connection.localRuntimes.length > 0 ? state.connection.localRuntimes.join(", ") : "none", localRuntimesWidth)}</text>
              </box>
              {state.usage.inputTokens > 0 || state.usage.outputTokens > 0 ? (
                <>
                  <box flexDirection="row" width="100%" minWidth={0}>
                    <text flexShrink={0} fg={theme.TEXT}>tokens </text>
                    <text fg={theme.MUTED}>{fitTuiText(`${state.usage.inputTokens}/${state.usage.outputTokens}`, tokensValueWidth)}</text>
                  </box>
                  <box flexDirection="row" width="100%" minWidth={0}>
                    <text flexShrink={0} fg={theme.TEXT}>cost </text>
                    <text fg={theme.MUTED}>{fitTuiText(`$${state.usage.estimatedCostUsd.toFixed(4)}`, costValueWidth)}</text>
                  </box>
                </>
              ) : (
                <text fg={theme.MUTED}>{fitTuiText("usage awaiting first model response", sidebarTextWidth)}</text>
              )}
              {state.connection.model ? (
                <box flexDirection="row" width="100%" minWidth={0}>
                  <text flexShrink={0} fg={theme.TEXT}>model </text>
                  <text fg={theme.MUTED}>{fitTuiText(state.connection.model, modelWidth)}</text>
                </box>
              ) : null}
            </box>
          </PanelSection>
          <PanelSection title="Session" contentWidth={sidebarTextWidth} tone={theme.BORDER}>
            <box flexDirection="column" minWidth={0}>
              <box flexDirection="row" width="100%" minWidth={0}>
                <text flexShrink={0} fg={theme.TEXT}>transcript </text>
                <text fg={theme.MUTED}>{fitTuiText(`${state.transcript.length} items`, transcriptCountWidth)}</text>
              </box>
              <box flexDirection="row" width="100%" minWidth={0}>
                <text flexShrink={0} fg={theme.TEXT}>turns </text>
                <text fg={theme.MUTED}>{fitTuiText(String(turnItems.length), turnsCountWidth)}</text>
              </box>
              <box flexDirection="row" width="100%" minWidth={0}>
                <text flexShrink={0} fg={theme.TEXT}>findings </text>
                <text fg={theme.MUTED}>{fitTuiText(String(totalFindings), findingsCountWidth)}</text>
              </box>
              <text fg={summary ? theme.SUCCESS : theme.PRIMARY}>{fitTuiText(summary ? "completed" : "running", sidebarTextWidth)}</text>
              {visibleFromTurnId ? <text fg={theme.ACCENT}>{fitTuiText("timeline focus active", sidebarTextWidth)}</text> : null}
            </box>
          </PanelSection>
          <PanelSection title="Pipeline" contentWidth={sidebarTextWidth} tone={state.stages.some((stage) => stage.status === "running") ? theme.PRIMARY : theme.BORDER}>
            <box flexDirection="column" minWidth={0}>
              {state.stages.map((stage) => (
                <box key={stage.id} flexDirection="column" minWidth={0}>
                  <text fg={stage.status === "running" ? theme.PRIMARY : stage.status === "done" ? theme.SUCCESS : stage.status === "error" ? theme.ERROR : theme.MUTED}>
                    {fitTuiText(`${stage.label} · ${stage.status}`, sidebarTextWidth)}
                  </text>
                  {stage.detail ? <text fg={theme.TEXT} wrapMode="word">{fitTuiText(stage.detail, sidebarTextWidth)}</text> : stage.status === "pending" ? <text fg={theme.MUTED}>{fitTuiText("waiting for stage handoff", sidebarTextWidth)}</text> : null}
                </box>
              ))}
            </box>
          </PanelSection>
          <PanelSection title="Findings" contentWidth={sidebarTextWidth} tone={totalFindings > 0 ? theme.WARNING : theme.BORDER}>
            <box flexDirection="column" minWidth={0}>
              {state.stages.flatMap((stage) => stage.findings).length === 0 ? (
                <text fg={theme.TEXT}>{fitTuiText("No findings yet.", sidebarTextWidth)}</text>
              ) : state.stages.flatMap((stage) => stage.findings).slice(0, SESSION_MAX_SIDEBAR_FINDINGS).map((finding, index) => (
                <text key={`${finding.title}-${index}`} fg={severityToneFor(theme, finding.severity)}>{fitTuiText(`${finding.severity} · ${finding.title}`, sidebarTextWidth)}</text>
              ))}
            </box>
          </PanelSection>
          {summary ? (
            <PanelSection title="Report" contentWidth={sidebarTextWidth} tone={summary.critical > 0 || summary.high > 0 ? theme.ERROR : theme.SUCCESS}>
              <box flexDirection="column" minWidth={0}>
                <box flexDirection="row" width="100%" minWidth={0}>
                  <text flexShrink={0} fg={summary.critical > 0 ? theme.ERROR : theme.TEXT}>critical </text>
                  <text fg={theme.MUTED}>{fitTuiText(String(summary.critical), Math.max(1, sidebarTextWidth - "critical ".length))}</text>
                </box>
                <box flexDirection="row" width="100%" minWidth={0}>
                  <text flexShrink={0} fg={summary.high > 0 ? theme.ERROR : theme.TEXT}>high </text>
                  <text fg={theme.MUTED}>{fitTuiText(String(summary.high), Math.max(1, sidebarTextWidth - "high ".length))}</text>
                </box>
                <box flexDirection="row" width="100%" minWidth={0}>
                  <text flexShrink={0} fg={summary.medium > 0 ? theme.WARNING : theme.TEXT}>medium </text>
                  <text fg={theme.MUTED}>{fitTuiText(String(summary.medium), Math.max(1, sidebarTextWidth - "medium ".length))}</text>
                </box>
                <box flexDirection="row" width="100%" minWidth={0}>
                  <text flexShrink={0} fg={theme.TEXT}>low </text>
                  <text fg={theme.MUTED}>{fitTuiText(String(summary.low), Math.max(1, sidebarTextWidth - "low ".length))}</text>
                </box>
                <box flexDirection="row" width="100%" minWidth={0}>
                  <text flexShrink={0} fg={theme.TEXT}>info </text>
                  <text fg={theme.MUTED}>{fitTuiText(String(summary.info ?? 0), Math.max(1, sidebarTextWidth - "info ".length))}</text>
                </box>
                {summary.shareUrl ? <text fg={theme.ACCENT}>{fitTuiUrl(summary.shareUrl, sidebarTextWidth)}</text> : null}
              </box>
            </PanelSection>
          ) : null}
        </scrollbox> : null}
      </box>
      )}
      <FooterBar
        hint={reviewOpen
          ? "ctrl+o or esc live · pgup/pgdn scroll"
          : state.pendingUserMessages.length > 0
            ? `message queued (${state.pendingUserMessages.length}) · ctrl+p commands`
            : "i inject message · ctrl+p commands"}
        status={summary ? <LiveBadge label={`ready · ${state.mode}`} active={false} /> : <LiveBadge label={`running · ${state.mode}`} />}
      />
    </ShellFrame>
  );
}
