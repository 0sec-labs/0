/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "./theme-context.js";
import { severityToneFor } from "./themes.js";
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
import { formatDuration, parseSummary, type OpsSnapshot } from "./findings-data.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import {
  DialogDetailColumn,
  DialogTitleRow,
  dialogTotalRows,
  wrapDialogLines,
  type DialogDetailLine,
} from "./dialog-screen-chrome.js";

export function OpsScreen({ dbPath, refreshMs, onExit, shell }: { dbPath?: string; refreshMs: number; onExit: () => void; shell?: ShellNav }) {
  const theme = useTheme();
  const [snapshot, setSnapshot] = useState<OpsSnapshot>({ scans: [], findings: [], incidents: [] });
  const [error, setError] = useState<string | null>(null);
  // The picker cursor and its filter.
  const [opsSelected, setOpsSelected] = useState(0);
  const [opsFilter, setOpsFilter] = useState("");
  const [opsFiltering, setOpsFiltering] = useState(false);
  // A terminal delivers "/q" as a single input burst: the "/" handler's
  // state commit has not landed when "q" arrives, so every synchronous
  // decision in the key handler reads these refs instead. Render keeps
  // reading the state below — refs do not repaint.
  const opsFilterRef = useRef("");
  const opsFilteringRef = useRef(false);
  const applyOpsFilter = (next: SetStateAction<string>) => {
    opsFilterRef.current = typeof next === "function" ? next(opsFilterRef.current) : next;
    setOpsFilter(opsFilterRef.current);
  };
  const applyOpsFiltering = (next: boolean) => {
    opsFilteringRef.current = next;
    setOpsFiltering(next);
  };
  // The cursor has the same burst problem the filter had: "/ab<enter>" resolves
  // its target against the list as it stood BEFORE the burst. Every selection
  // decision in the key handler reads this ref and the ref-derived list below;
  // render keeps reading `opsSelected`/`opsFiltered` — refs do not repaint.
  const opsSelectedRef = useRef(0);
  const applyOpsSelected = (next: number) => {
    opsSelectedRef.current = next;
    setOpsSelected(next);
  };
  const { width, height } = useSurfaceDimensions();
  // fitTuiText sanitizes before it truncates, and sanitizing trims: a label
  // handed in as "runs " came back as "runs" and the value fused onto it
  // ("runs12"). The separator is a row gap now, and the label budget stops
  // pretending to own that cell.
  // Neither panel scrolls, so the row count has to come from the frame: a
  // section handed more rows than the column has is shrunk until its own
  // bottom border is painted through its last entry. The metric strip above
  // is three rows plus a margin inline, or three chips deep when stacked;
  // each section then spends two border rows and a title row before content,
  // and every run/incident renders on three lines.
  const palette = usePaletteController([
    {
      id: "back-ops",
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
    const refresh = async () => {
      try {
        const { osecDB } = await import("@0sec/db");
        const db = new osecDB(dbPath);
        try {
          const scans = db.listScans(12) as OpsSnapshot["scans"];
          const findings = db.listFindings({ limit: 12 }) as OpsSnapshot["findings"];
          const events = db.listRecentEvents(30) as Array<{ scanId: string; scanTarget?: string; stage: string; eventType: string; payload: string }>;
          const incidents = events
            .filter((event) => ["agent_error", "scan_error", "worker_failed"].includes(event.eventType))
            .slice(0, 6)
            .map((event) => ({ scanId: event.scanId, target: event.scanTarget ?? event.scanId, stage: event.stage, headline: event.payload }));
          if (!alive) return;
          setSnapshot({ scans, findings, incidents });
          setError(null);
        } finally {
          db.close();
        }
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [dbPath, refreshMs]);

  // ── dialog interior: one grouped list over everything the snapshot holds ──
  // The runs and incidents the two legacy panels drew, plus the findings the
  // metric strip only ever counted, projected onto the shared picker. Nothing
  // is invented: a scan with no parsable summary reports an unknown finding
  // count in the detail column rather than a zero.
  const opsItems = useMemo<DialogItem[]>(() => {
    const rows: DialogItem[] = [];
    if (snapshot.scans.length === 0) {
      rows.push({ id: "run:none", label: "No local scans yet.", category: "Runs", disabled: true });
    } else {
      for (const scan of snapshot.scans) {
        rows.push({
          id: `run:${scan.id}`,
          label: scan.target,
          description: `${scan.mode}/${scan.depth} · ${scan.runtime}`,
          meta: scan.status,
          category: "Runs",
        });
      }
    }
    if (snapshot.findings.length === 0) {
      rows.push({ id: "finding:none", label: "No findings recorded.", category: "Findings", disabled: true });
    } else {
      for (const finding of snapshot.findings) {
        rows.push({
          id: `finding:${finding.id}`,
          label: finding.title,
          description: finding.category,
          meta: finding.severity,
          category: "Findings",
          tone: severityToneFor(theme, finding.severity),
        });
      }
    }
    if (snapshot.incidents.length === 0) {
      rows.push({ id: "incident:none", label: "No recent runtime incidents.", category: "Incidents", disabled: true });
    } else {
      snapshot.incidents.forEach((incident, index) => {
        rows.push({
          id: `incident:${incident.scanId}:${index}`,
          label: incident.target,
          description: incident.stage,
          meta: "incident",
          category: "Incidents",
          tone: theme.ERROR,
        });
      });
    }
    return rows;
  }, [snapshot, theme]);

  const opsFiltered = useMemo(() => filterDialogItems(opsItems, opsFilter), [opsItems, opsFilter]);
  const opsCursor = clampDialogSelection(opsFiltered, opsSelected);
  // The list every synchronous decision in the key handler resolves against.
  // It recomputes only when the ref and the render-time filter disagree — that
  // is, mid-burst — and otherwise hands back the memo itself.
  const currentOpsItems = () =>
    opsFilterRef.current === opsFilter ? opsFiltered : filterDialogItems(opsItems, opsFilterRef.current);
  const moveOpsCursor = (step: number) => {
    const visible = currentOpsItems();
    if (visible.length === 0) return;
    let next = clampDialogSelection(visible, opsSelectedRef.current);
    const dir: 1 | -1 = step >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(step); i += 1) next = moveDialogSelection(visible, next, dir);
    applyOpsSelected(next);
  };

  useKeyboard((key) => {
    if (palette.handlePaletteKey(key)) return;
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    // Filter mode is entered only with "/".
    if (opsFilteringRef.current) {
      if (key.name === "escape") {
        applyOpsFiltering(false);
        applyOpsFilter("");
        applyOpsSelected(0);
        return;
      }
      if (key.name === "return") {
        applyOpsFiltering(false);
        return;
      }
      if (key.name === "backspace") {
        applyOpsFilter((current) => Array.from(current).slice(0, -1).join(""));
        applyOpsSelected(0);
        return;
      }
      if (key.name === "up") return moveOpsCursor(-1);
      if (key.name === "down") return moveOpsCursor(1);
      if (key.name === "pageup") return moveOpsCursor(-5);
      if (key.name === "pagedown") return moveOpsCursor(5);
      const typed = typeof key.sequence === "string" ? key.sequence : "";
      if (!key.ctrl && !key.meta && typed.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(typed)) {
        applyOpsFilter((current) => current + typed);
        applyOpsSelected(0);
      }
      return;
    }
    if (key.name === "q") {
      onExit();
      return;
    }
    if (key.name === "escape") {
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
    if (key.name === "up") return moveOpsCursor(-1);
    if (key.name === "down") return moveOpsCursor(1);
    if (key.name === "pageup") return moveOpsCursor(-5);
    if (key.name === "pagedown") return moveOpsCursor(5);
    if (key.name === "home") return applyOpsSelected(clampDialogSelection(currentOpsItems(), 0));
    if (key.name === "end") {
      const visible = currentOpsItems();
      return applyOpsSelected(clampDialogSelection(visible, visible.length - 1));
    }
    if (key.sequence === "/") {
      applyOpsFiltering(true);
      applyOpsFilter("");
      applyOpsSelected(0);
    }
  });

  const opsBodyRows = Math.max(1, height - 3); // title row + status line + host footer
  const opsPanel = computeDialogPanel({
    width,
    height,
    size: "large",
    totalRows: dialogTotalRows(opsFiltered),
    withDetail: true,
    bodyRows: opsBodyRows,
  });
  const renderOpsDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const inner = Math.max(1, pane.width - SCROLLBAR_COLUMN);
    const lines: DialogDetailLine[] = [];
    const [kind, ...rest] = item.id.split(":");
    const key = rest.join(":");
    if (kind === "run" && key !== "none") {
      const scan = snapshot.scans.find((entry) => entry.id === key);
      if (scan) {
        lines.push({ text: "RUN", fg: theme.PRIMARY });
        lines.push(...wrapDialogLines(scan.target, inner, theme.TEXT));
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(`id ${scan.id}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`mode ${scan.mode}/${scan.depth}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`runtime ${scan.runtime}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`status ${scan.status}`, inner, theme.MUTED));
        const total = parseSummary(scan.summary).totalFindings;
        lines.push(...wrapDialogLines(`findings ${total ?? "unknown"}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`duration ${formatDuration(scan.durationMs)}`, inner, theme.MUTED));
      }
    } else if (kind === "finding" && key !== "none") {
      const finding = snapshot.findings.find((entry) => entry.id === key);
      if (finding) {
        lines.push({ text: "FINDING", fg: theme.PRIMARY });
        lines.push(...wrapDialogLines(finding.title, inner, severityToneFor(theme, finding.severity)));
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(`severity ${finding.severity}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`category ${finding.category}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`scan ${finding.scanId}`, inner, theme.MUTED));
      }
    } else if (kind === "incident" && key !== "none") {
      const index = Number.parseInt(key.slice(key.lastIndexOf(":") + 1), 10);
      const incident = snapshot.incidents[index];
      if (incident) {
        lines.push({ text: "INCIDENT", fg: theme.ERROR });
        lines.push(...wrapDialogLines(incident.target, inner, theme.TEXT));
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(incident.headline, inner, theme.ERROR));
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(`stage ${incident.stage}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`scan ${incident.scanId}`, inner, theme.MUTED));
      }
    } else {
      lines.push(...wrapDialogLines(item.label, inner, theme.MUTED));
    }
    return <DialogDetailColumn lines={lines} pane={pane} />;
  };

  const opsCounts = `runs ${snapshot.scans.length} · findings ${snapshot.findings.length} · incidents ${snapshot.incidents.length}`;
  const opsRefresh = refreshMs >= 1000 ? `refresh ${Math.round(refreshMs / 1000)}s` : `refresh ${refreshMs}ms`;

  return (
    <ShellFrame view="mission control" dialogContent>
      {palette.paletteOpen ? <PaletteOverlay title="Mission control commands" query={palette.paletteQuery} selected={palette.paletteSelected} commands={palette.filteredPalette} /> : null}
      <box flexDirection="column" width="100%" height="100%" minWidth={0}>
        <DialogTitleRow screenKey="ops" width={width} meta={opsRefresh} />
        <DialogSelectBody
          items={opsFiltered}
          cursor={opsCursor}
          panel={opsPanel}
          query={opsFilter}
          placeholder={opsFiltering ? "type to filter" : "/ to filter runs, findings and incidents"}
          emptyText="Nothing matches this filter."
          renderDetail={renderOpsDetail}
        />
        <Cells width={width} fg={error ? theme.ERROR : snapshot.incidents.length > 0 ? theme.ERROR : theme.MUTED}>
          {error ?? opsCounts}
        </Cells>
        <FooterBar hint={opsFiltering ? "type to filter · enter keep · esc clear" : "↑↓ move · / filter · esc back · ctrl+p commands · ctrl+c exit"} />
      </box>
    </ShellFrame>
  );
}
