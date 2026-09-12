/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "./theme-context.js";
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
import { formatDuration, parseSummary, type HistoryScanRow } from "./findings-data.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import {
  DialogDetailColumn,
  DialogTitleRow,
  dialogTotalRows,
  scanStatusTone,
  wrapDialogLines,
  type DialogDetailLine,
} from "./dialog-screen-chrome.js";

interface HistorySelection {
  action: "replay";
  scanId: string;
}

const HISTORY_DAY_MS = 86_400_000;

/**
 * Recency bucket for a run's `startedAt`.
 *
 * The column is a free-form string, so a value that will not parse is grouped
 * as `Undated` rather than folded into the newest bucket — the screen never
 * claims a run happened at a time it cannot read. Buckets are stated as
 * elapsed windows ("Last 24 hours") because that is what the arithmetic
 * actually establishes; a calendar word like "today" would not be.
 */
function historyRecencyBucket(startedAt: string | undefined | null, now: number): string {
  if (!startedAt) return "Undated";
  const at = Date.parse(startedAt);
  if (!Number.isFinite(at)) return "Undated";
  const age = now - at;
  if (age < HISTORY_DAY_MS) return "Last 24 hours";
  if (age < HISTORY_DAY_MS * 7) return "Last 7 days";
  if (age < HISTORY_DAY_MS * 30) return "Last 30 days";
  return "Earlier";
}

export function HistoryScreen({ dbPath, limit, onResolve, onExit, shell }: { dbPath?: string; limit: number; onResolve?: (selection: HistorySelection) => void; onExit: () => void; shell?: ShellNav }) {
  const theme = useTheme();
  const [scans, setScans] = useState<HistoryScanRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  // The picker cursor and its filter; `index` is the cursor.
  const [historyFilter, setHistoryFilter] = useState("");
  const [historyFiltering, setHistoryFiltering] = useState(false);
  // A terminal delivers "/q" as a single input burst: the "/" handler's
  // state commit has not landed when "q" arrives, so every synchronous
  // decision in the key handler reads these refs instead. Render keeps
  // reading the state below — refs do not repaint.
  const historyFilterRef = useRef("");
  const historyFilteringRef = useRef(false);
  const applyHistoryFilter = (next: SetStateAction<string>) => {
    historyFilterRef.current = typeof next === "function" ? next(historyFilterRef.current) : next;
    setHistoryFilter(historyFilterRef.current);
  };
  const applyHistoryFiltering = (next: boolean) => {
    historyFilteringRef.current = next;
    setHistoryFiltering(next);
  };
  // The cursor has the same burst problem the filter had: in "/ab<enter>" the
  // trailing key resolves its target against the list as it stood BEFORE the
  // burst, so `r` would replay the wrong run. Every synchronous decision in
  // the key handler reads this ref and the ref-derived list below; render
  // keeps reading `index`/`historyFiltered` — refs do not repaint.
  const indexRef = useRef(0);
  const applyIndex = (next: number) => {
    indexRef.current = next;
    setIndex(next);
  };
  const { width, height } = useSurfaceDimensions();

  // ── dialog interior: the run list projected onto the shared picker ───────
  // Grouped by how long ago each run started, which is the only ordering the
  // stored rows actually support. A run whose summary will not parse reports
  // an unknown finding count rather than a zero.
  const historyItems = useMemo<DialogItem[]>(() => {
    if (scans.length === 0) {
      return [{ id: "history:none", label: "No scan history found.", category: "Runs", disabled: true }];
    }
    const now = Date.now();
    return scans.map((scan) => ({
      id: `scan:${scan.id}`,
      label: scan.target,
      description: `${scan.mode}/${scan.depth} · ${scan.runtime}`,
      meta: scan.status,
      category: historyRecencyBucket(scan.startedAt, now),
      tone: scanStatusTone(theme, scan.status),
    }));
  }, [scans, theme]);
  const historyFiltered = useMemo(() => filterDialogItems(historyItems, historyFilter), [historyItems, historyFilter]);
  const historyCursor = clampDialogSelection(historyFiltered, index);
  const historyActiveId = historyFiltered[historyCursor]?.id;
  // `index` is the picker cursor; the selection is resolved through the
  // highlighted row's id so a filter cannot desync it.
  const historySelected = historyActiveId && historyActiveId.startsWith("scan:")
    ? scans.find((scan) => scan.id === historyActiveId.slice("scan:".length)) ?? null
    : null;
  const selected = historySelected;
  // The list and the run every synchronous decision in the key handler resolves
  // against. `currentHistoryItems` recomputes only when the ref and the
  // render-time filter disagree — mid-burst — and otherwise hands back the memo.
  const currentHistoryItems = () =>
    historyFilterRef.current === historyFilter ? historyFiltered : filterDialogItems(historyItems, historyFilterRef.current);
  const currentHistoryScan = (): HistoryScanRow | null => {
    const visible = currentHistoryItems();
    const activeId = visible[clampDialogSelection(visible, indexRef.current)]?.id;
    return activeId && activeId.startsWith("scan:")
      ? scans.find((scan) => scan.id === activeId.slice("scan:".length)) ?? null
      : null;
  };
  const moveHistoryCursor = (step: number) => {
    const visible = currentHistoryItems();
    if (visible.length === 0) return;
    let next = clampDialogSelection(visible, indexRef.current);
    const dir: 1 | -1 = step >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(step); i += 1) next = moveDialogSelection(visible, next, dir);
    applyIndex(next);
  };
  const palette = usePaletteController([
    {
      id: "replay-scan",
      title: "Replay selected scan",
      category: "Session",
      description: "Hand off the selected run to the replay view",
      keybind: "r",
      suggested: true,
      action: () => {
        const run = currentHistoryScan();
        if (!run) return;
        if (shell) {
          shell.openReplay(run.id);
          return;
        }
        onResolve?.({ action: "replay", scanId: run.id });
        onExit();
      },
    },
    {
      id: "back-history",
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
          const rows = db.listScans(limit) as HistoryScanRow[];
          if (!alive) return;
          setScans(rows);
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
  }, [dbPath, limit]);

  useKeyboard((key) => {
    if (palette.handlePaletteKey(key)) return;
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    // Filter mode is entered only with "/"; esc clears the filter before it
    // can leave the screen.
    if (historyFilteringRef.current) {
      if (key.name === "escape") {
        applyHistoryFiltering(false);
        applyHistoryFilter("");
        applyIndex(0);
        return;
      }
      if (key.name === "return") {
        applyHistoryFiltering(false);
        return;
      }
      if (key.name === "backspace") {
        applyHistoryFilter((current) => Array.from(current).slice(0, -1).join(""));
        applyIndex(0);
        return;
      }
      if (key.name === "up") return moveHistoryCursor(-1);
      if (key.name === "down") return moveHistoryCursor(1);
      if (key.name === "pageup") return moveHistoryCursor(-5);
      if (key.name === "pagedown") return moveHistoryCursor(5);
      const typed = typeof key.sequence === "string" ? key.sequence : "";
      if (!key.ctrl && !key.meta && typed.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(typed)) {
        applyHistoryFilter((current) => current + typed);
        applyIndex(0);
      }
      return;
    }
    if (key.name === "q") {
      onExit();
      return;
    }
    if (key.name === "escape") {
      if (historyFilterRef.current.length > 0) {
        applyHistoryFilter("");
        applyIndex(0);
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
    if (key.sequence === "r") {
      const run = currentHistoryScan();
      if (!run) return;
      if (shell) {
        shell.openReplay(run.id);
      } else {
        onResolve?.({ action: "replay", scanId: run.id });
        onExit();
      }
      return;
    }
    if (key.name === "up") return moveHistoryCursor(-1);
    if (key.name === "down") return moveHistoryCursor(1);
    if (key.name === "pageup") return moveHistoryCursor(-5);
    if (key.name === "pagedown") return moveHistoryCursor(5);
    if (key.name === "home") return applyIndex(clampDialogSelection(currentHistoryItems(), 0));
    if (key.name === "end") {
      const visible = currentHistoryItems();
      return applyIndex(clampDialogSelection(visible, visible.length - 1));
    }
    if (key.sequence === "/") {
      applyHistoryFiltering(true);
      applyHistoryFilter("");
      applyIndex(0);
      return;
    }
  });

  const summary = selected ? parseSummary(selected.summary) : {};

  // Rows the picker may fill: the panel less the title row, the status line
  // and the single footer row the host draws.
  const historyBodyRows = Math.max(1, height - 3);
  const historyPanel = computeDialogPanel({
    width,
    height,
    size: "large",
    totalRows: dialogTotalRows(historyFiltered),
    withDetail: true,
    bodyRows: historyBodyRows,
  });
  const renderHistoryDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const inner = Math.max(1, pane.width - SCROLLBAR_COLUMN);
    const lines: DialogDetailLine[] = [];
    const scan = item.id.startsWith("scan:")
      ? scans.find((row) => row.id === item.id.slice("scan:".length))
      : undefined;
    if (!scan) {
      lines.push(...wrapDialogLines(item.label, inner, theme.MUTED));
      return <DialogDetailColumn lines={lines} pane={pane} />;
    }
    const scanSummary = parseSummary(scan.summary);
    lines.push({ text: "RUN", fg: theme.PRIMARY });
    lines.push(...wrapDialogLines(scan.target, inner, theme.TEXT));
    lines.push({ text: "" });
    lines.push(...wrapDialogLines(`status ${scan.status}`, inner, scanStatusTone(theme, scan.status) ?? theme.MUTED));
    lines.push(...wrapDialogLines(`mode ${scan.mode}/${scan.depth}`, inner, theme.MUTED));
    lines.push(...wrapDialogLines(`runtime ${scan.runtime}`, inner, theme.MUTED));
    // An unparsable summary reports an unknown count; it is never a zero.
    lines.push(...wrapDialogLines(`findings ${scanSummary.totalFindings ?? "unknown"}`, inner, theme.MUTED));
    lines.push(...wrapDialogLines(`duration ${formatDuration(scan.durationMs)}`, inner, theme.MUTED));
    lines.push(...wrapDialogLines(`started ${scan.startedAt}`, inner, theme.MUTED));
    lines.push(...wrapDialogLines(`scan ${scan.id}`, inner, theme.MUTED));
    lines.push({ text: "" });
    lines.push(...wrapDialogLines("r replays this run", inner, theme.ACCENT));
    return <DialogDetailColumn lines={lines} pane={pane} />;
  };
  const historyStatusLine = error
    ?? (selected
      ? `${selected.status} · ${formatDuration(selected.durationMs)} · findings ${summary.totalFindings ?? "unknown"}`
      : "No run selected");

  return (
    <ShellFrame view="history" dialogContent>
      {palette.paletteOpen ? <PaletteOverlay title="History commands" query={palette.paletteQuery} selected={palette.paletteSelected} commands={palette.filteredPalette} /> : null}
      <box flexDirection="column" width="100%" height="100%" minWidth={0}>
        <DialogTitleRow screenKey="history" width={width} meta={`${scans.length} runs · limit ${limit}`} />
        <DialogSelectBody
          items={historyFiltered}
          cursor={historyCursor}
          panel={historyPanel}
          query={historyFilter}
          placeholder={historyFiltering ? "type to filter" : "/ to filter runs"}
          emptyText="Nothing matches this filter."
          renderDetail={renderHistoryDetail}
        />
        <Cells width={width} fg={error ? theme.ERROR : theme.MUTED}>
          {historyStatusLine}
        </Cells>
        <FooterBar hint={historyFiltering ? "type to filter · enter keep · esc clear" : "↑↓ move · r replay · / filter · esc back · ctrl+p commands · ctrl+c exit"} />
      </box>
    </ShellFrame>
  );
}
