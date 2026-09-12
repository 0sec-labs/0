/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "./theme-context.js";
import { severityToneFor } from "./themes.js";
import { fitTuiText } from "./text.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import {
  clampDialogSelection,
  computeDialogPanel,
  filterDialogItems,
  moveDialogSelection,
} from "./dialog-select-layout.js";
import { Cells } from "./primitives.js";
import { SCROLLBAR_COLUMN } from "./shell-geometry.js";
import { FooterBar, ShellFrame } from "./shell-frame.js";
import { leaveCurrentScreen, type ShellNav } from "./shell-nav.js";
import {
  PaletteOverlay,
  createShellCommands,
  usePaletteController,
} from "./command-palette.js";
import {
  describeEventPayload,
  formatDuration,
  parseSummary,
  type FindingsRow,
  type ReplayEventRow,
  type ReplayScanRow,
} from "./findings-data.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import {
  DialogDetailColumn,
  DialogTitleRow,
  dialogTotalRows,
  scanStatusTone,
  wrapDialogLines,
  type DialogDetailLine,
} from "./dialog-screen-chrome.js";

/**
 * Rows of raw event payload the dialog's detail column will materialise. The
 * pane scrolls, so this is a node budget rather than a visibility limit — and
 * it is two orders of magnitude more payload than the legacy pane's 120-cell
 * `describeEventPayload` headline ever exposed.
 */
const REPLAY_PAYLOAD_MAX_WRAPPED_ROWS = 200;

export function ReplayScreen({ dbPath, scanId, onExit, shell }: { dbPath?: string; scanId?: string; onExit: () => void; shell?: ShellNav }) {
  const theme = useTheme();
  const [scan, setScan] = useState<ReplayScanRow | null>(null);
  const [findings, setFindings] = useState<FindingsRow[]>([]);
  const [events, setEvents] = useState<ReplayEventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [eventIndex, setEventIndex] = useState(0);
  // Dialog-interior view state; `eventIndex` doubles as the picker cursor.
  const [replayFilter, setReplayFilter] = useState("");
  const [replayFiltering, setReplayFiltering] = useState(false);
  // A terminal delivers "/q" as a single input burst: the "/" handler's
  // state commit has not landed when "q" arrives, so every synchronous
  // decision in the key handler reads these refs instead. Render keeps
  // reading the state below — refs do not repaint.
  const replayFilterRef = useRef("");
  const replayFilteringRef = useRef(false);
  const applyReplayFilter = (next: SetStateAction<string>) => {
    replayFilterRef.current = typeof next === "function" ? next(replayFilterRef.current) : next;
    setReplayFilter(replayFilterRef.current);
  };
  const applyReplayFiltering = (next: boolean) => {
    replayFilteringRef.current = next;
    setReplayFiltering(next);
  };
  // The cursor has the same burst problem the filter had: in "/ab<enter>" the
  // trailing key resolves its target against the list as it stood BEFORE the
  // burst. Every synchronous decision in the key handler reads this ref and
  // the ref-derived list below; render keeps reading `eventIndex` and
  // `replayFiltered` — refs do not repaint.
  const eventIndexRef = useRef(0);
  const applyEventIndex = (next: number) => {
    eventIndexRef.current = next;
    setEventIndex(next);
  };

  const palette = usePaletteController([
    {
      id: "back-replay",
      title: "Go back",
      category: "Navigate",
      description: "Return to the previous console screen",
      keybind: "esc",
      suggested: true,
      action: () => leaveCurrentScreen(shell, onExit),
    },
    ...createShellCommands(shell),
  ]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { osecDB } = await import("@0sec/db");
        const db = new osecDB(dbPath);
        try {
          let selected = scanId ? db.getScan(scanId) as ReplayScanRow | undefined : undefined;
          if (!selected && scanId) {
            const scans = db.listScans(100) as ReplayScanRow[];
            selected = scans.find((row) => row.id.startsWith(scanId));
          }
          if (!selected) {
            const scans = db.listScans(1) as ReplayScanRow[];
            selected = scans[0];
          }
          if (!selected) throw new Error("No scan history found. Run a scan first.");
          const nextFindings = db.getFindings(selected.id) as FindingsRow[];
          const nextEvents = db.getEvents(selected.id) as ReplayEventRow[];
          if (!alive) return;
          setScan(selected);
          setFindings(nextFindings);
          setEvents(nextEvents);
          applyEventIndex(0);
          setError(null);
        } finally {
          db.close();
        }
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [dbPath, scanId]);

  const summary = parseSummary(scan?.summary);
  const verifiedFindings = findings.filter((finding) => finding.status !== "false-positive");
  const falsePositiveFindings = findings.filter((finding) => finding.status === "false-positive");
  const { width, height } = useSurfaceDimensions();

  // ── dialog interior: the run, its lane, its findings and every event ────
  // One grouped picker over everything the three legacy panes drew. Nothing
  // is summarised away: the event detail carries the raw payload and scrolls.
  const replayItems = useMemo<DialogItem[]>(() => {
    const rows: DialogItem[] = [];
    if (scan) {
      rows.push({
        id: `run:${scan.id}`,
        label: scan.target,
        description: `${scan.mode}/${scan.depth} · ${scan.runtime}`,
        meta: scan.status,
        category: "Run",
        tone: scanStatusTone(theme, scan.status),
        current: true,
      });
      rows.push({
        id: "lane:discover",
        label: "DISCOVER",
        description: `${scan.mode}/${scan.depth} via ${scan.runtime}`,
        category: "Lane",
      });
    } else {
      rows.push({ id: "run:none", label: "No scan loaded.", category: "Run", disabled: true });
      rows.push({ id: "lane:discover", label: "DISCOVER", description: "loading", category: "Lane", disabled: true });
    }
    rows.push({
      id: "lane:attack",
      label: "ATTACK",
      description: verifiedFindings.length > 0
        ? `${verifiedFindings.length} findings survived triage`
        : "No confirmed findings recorded",
      category: "Lane",
    });
    rows.push({
      id: "lane:verify",
      label: "VERIFY",
      description: `${falsePositiveFindings.length} false positives removed`,
      category: "Lane",
    });
    rows.push({
      id: "lane:report",
      label: "REPORT",
      description: `${formatDuration(scan?.durationMs)} total runtime`,
      category: "Lane",
    });
    if (findings.length === 0) {
      rows.push({ id: "finding:none", label: "No findings recorded for this scan.", category: "Findings", disabled: true });
    } else {
      for (const finding of findings) {
        rows.push({
          id: `finding:${finding.id}`,
          label: finding.title,
          description: `${finding.category} · ${finding.status}`,
          meta: finding.severity,
          category: "Findings",
          tone: severityToneFor(theme, finding.severity),
        });
      }
    }
    if (events.length === 0) {
      rows.push({ id: "event:none", label: "No pipeline events captured for this scan.", category: "Events", disabled: true });
    } else {
      for (const event of events) {
        const failed = /error|fail/i.test(event.eventType);
        rows.push({
          id: `event:${event.id}`,
          label: `${event.stage} · ${event.eventType}`,
          description: describeEventPayload(event.payload),
          category: "Events",
          tone: failed ? theme.ERROR : undefined,
        });
      }
    }
    return rows;
  }, [scan, findings, events, verifiedFindings.length, falsePositiveFindings.length, theme]);
  const replayFiltered = useMemo(() => filterDialogItems(replayItems, replayFilter), [replayItems, replayFilter]);
  const replayCursor = clampDialogSelection(replayFiltered, eventIndex);
  const replayActiveId = replayFiltered[replayCursor]?.id;
  const replaySelectedEvent = replayActiveId && replayActiveId.startsWith("event:")
    ? events.find((event) => event.id === replayActiveId.slice("event:".length)) ?? null
    : null;
  const selectedEvent = replaySelectedEvent;
  // The list every synchronous decision in the key handler resolves against.
  // It recomputes only when the ref and the render-time filter disagree — that
  // is, mid-burst — and otherwise hands back the memo itself.
  const currentReplayItems = () =>
    replayFilterRef.current === replayFilter ? replayFiltered : filterDialogItems(replayItems, replayFilterRef.current);
  const moveReplayCursor = (step: number) => {
    const visible = currentReplayItems();
    if (visible.length === 0) return;
    let next = clampDialogSelection(visible, eventIndexRef.current);
    const dir: 1 | -1 = step >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(step); i += 1) next = moveDialogSelection(visible, next, dir);
    applyEventIndex(next);
  };


  useKeyboard((key) => {
    if (palette.handlePaletteKey(key)) return;
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    // Filter mode is entered only with "/"; esc clears it before it can
    // leave the screen.
    if (replayFilteringRef.current) {
      if (key.name === "escape") {
        applyReplayFiltering(false);
        applyReplayFilter("");
        applyEventIndex(0);
        return;
      }
      if (key.name === "return") {
        applyReplayFiltering(false);
        return;
      }
      if (key.name === "backspace") {
        applyReplayFilter((current) => Array.from(current).slice(0, -1).join(""));
        applyEventIndex(0);
        return;
      }
      if (key.name === "up") return moveReplayCursor(-1);
      if (key.name === "down") return moveReplayCursor(1);
      if (key.name === "pageup") return moveReplayCursor(-5);
      if (key.name === "pagedown") return moveReplayCursor(5);
      const typed = typeof key.sequence === "string" ? key.sequence : "";
      if (!key.ctrl && !key.meta && typed.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(typed)) {
        applyReplayFilter((current) => current + typed);
        applyEventIndex(0);
      }
      return;
    }
    if (key.name === "q") {
      onExit();
      return;
    }
    if (key.name === "escape") {
      if (replayFilterRef.current.length > 0) {
        applyReplayFilter("");
        applyEventIndex(0);
        return;
      }
      leaveCurrentScreen(shell, onExit);
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
    if (key.name === "up") return moveReplayCursor(-1);
    if (key.name === "down") return moveReplayCursor(1);
    if (key.name === "pageup") return moveReplayCursor(-5);
    if (key.name === "pagedown") return moveReplayCursor(5);
    if (key.name === "home") return applyEventIndex(clampDialogSelection(currentReplayItems(), 0));
    if (key.name === "end") {
      const visible = currentReplayItems();
      return applyEventIndex(clampDialogSelection(visible, visible.length - 1));
    }
    if (key.sequence === "/") {
      applyReplayFiltering(true);
      applyReplayFilter("");
      applyEventIndex(0);
      return;
    }
  });

  const replayBodyRows = Math.max(1, height - 3); // title row + status line + host footer
  const replayPanel = computeDialogPanel({
    width,
    height,
    size: "large",
    totalRows: dialogTotalRows(replayFiltered),
    withDetail: true,
    bodyRows: replayBodyRows,
  });
  const renderReplayDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const inner = Math.max(1, pane.width - SCROLLBAR_COLUMN);
    const lines: DialogDetailLine[] = [];
    const separator = item.id.indexOf(":");
    const kind = separator < 0 ? item.id : item.id.slice(0, separator);
    const key = separator < 0 ? "" : item.id.slice(separator + 1);
    if (kind === "run" && scan) {
      lines.push({ text: "RUN", fg: theme.PRIMARY });
      lines.push(...wrapDialogLines(scan.target, inner, theme.TEXT));
      lines.push({ text: "" });
      lines.push(...wrapDialogLines(`status ${scan.status}`, inner, scanStatusTone(theme, scan.status) ?? theme.MUTED));
      lines.push(...wrapDialogLines(`mode ${scan.mode}/${scan.depth}`, inner, theme.MUTED));
      lines.push(...wrapDialogLines(`runtime ${scan.runtime}`, inner, theme.MUTED));
      // The scan summary is authoritative when it parses; when it does not,
      // the only honest number left is the rows actually loaded.
      lines.push(...wrapDialogLines(
        summary.totalFindings !== undefined
          ? `findings ${summary.totalFindings}`
          : `findings unknown · ${findings.length} rows loaded`,
        inner,
        theme.MUTED,
      ));
      lines.push(...wrapDialogLines(`events ${events.length}`, inner, theme.MUTED));
      lines.push(...wrapDialogLines(`duration ${formatDuration(scan.durationMs)}`, inner, theme.MUTED));
      lines.push(...wrapDialogLines(`started ${scan.startedAt}`, inner, theme.MUTED));
      lines.push(...wrapDialogLines(`scan ${scan.id}`, inner, theme.MUTED));
    } else if (kind === "lane") {
      lines.push({ text: "LANE", fg: theme.PRIMARY });
      lines.push(...wrapDialogLines(item.label, inner, theme.TEXT));
      lines.push({ text: "" });
      lines.push(...wrapDialogLines(item.description ?? "", inner, theme.MUTED));
    } else if (kind === "finding") {
      const finding = findings.find((row) => row.id === key);
      if (finding) {
        lines.push({ text: "FINDING", fg: severityToneFor(theme, finding.severity) });
        lines.push(...wrapDialogLines(finding.title, inner, theme.TEXT));
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(`severity ${finding.severity}`, inner, severityToneFor(theme, finding.severity)));
        lines.push(...wrapDialogLines(`category ${finding.category}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`status ${finding.status}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`triage ${finding.triageStatus ?? "new"}`, inner, theme.MUTED));
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(finding.description, inner, theme.MUTED));
      } else {
        lines.push(...wrapDialogLines(item.label, inner, theme.MUTED));
      }
    } else if (kind === "event") {
      const event = events.find((row) => row.id === key);
      if (event) {
        lines.push({ text: "EVENT", fg: /error|fail/i.test(event.eventType) ? theme.ERROR : theme.PRIMARY });
        lines.push(...wrapDialogLines(`${event.stage} · ${event.eventType}`, inner, theme.TEXT));
        lines.push(...wrapDialogLines(new Date(event.timestamp).toISOString(), inner, theme.MUTED));
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(describeEventPayload(event.payload), inner, theme.ACCENT));
        lines.push({ text: "" });
        lines.push({ text: "PAYLOAD", fg: theme.PRIMARY });
        // The raw payload, scrolled rather than clipped. `describeEventPayload`
        // caps its headline at 120 cells — all the legacy pane ever showed —
        // so the body is kept here and the pane scrolls over it. The cap is a
        // render budget (a payload can be an entire HTTP response and every
        // line is a node), and `fitTuiText` marks the cut where it happens.
        lines.push(...wrapDialogLines(fitTuiText(event.payload, inner * REPLAY_PAYLOAD_MAX_WRAPPED_ROWS), inner, theme.MUTED));
      } else {
        lines.push(...wrapDialogLines(item.label, inner, theme.MUTED));
      }
    } else {
      lines.push(...wrapDialogLines(item.label, inner, theme.MUTED));
    }
    return <DialogDetailColumn lines={lines} pane={pane} />;
  };
  const replayCounts = `findings ${summary.totalFindings ?? `${findings.length} loaded`} · confirmed ${verifiedFindings.length} · events ${events.length}`;
  const replayStatusLine = error
    ?? (selectedEvent ? `${selectedEvent.stage} · ${selectedEvent.eventType} · up/down browse` : replayCounts);

  return (
    <ShellFrame view="replay" dialogContent>
      {palette.paletteOpen ? <PaletteOverlay title="Replay commands" query={palette.paletteQuery} selected={palette.paletteSelected} commands={palette.filteredPalette} /> : null}
      <box flexDirection="column" width="100%" height="100%" minWidth={0}>
        <DialogTitleRow screenKey="replay" width={width} meta={scan ? scan.id.slice(0, 8) : "latest scan"} />
        <DialogSelectBody
          items={replayFiltered}
          cursor={replayCursor}
          panel={replayPanel}
          query={replayFilter}
          placeholder={replayFiltering ? "type to filter" : "/ to filter lane, findings and events"}
          emptyText="Nothing matches this filter."
          gutter
          renderDetail={renderReplayDetail}
        />
        <Cells width={width} fg={error ? theme.ERROR : theme.MUTED}>
          {replayStatusLine}
        </Cells>
        <FooterBar hint={replayFiltering ? "type to filter · enter keep · esc clear" : "↑↓ move · / filter · esc back · ctrl+p commands · ctrl+c exit"} />
      </box>
    </ShellFrame>
  );
}
