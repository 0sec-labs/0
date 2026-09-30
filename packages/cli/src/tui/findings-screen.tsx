/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useKeyboard } from "@opentui/react";
import type { FindingTriageStatus } from "@0/shared";
import { useTheme } from "./theme-context.js";
import { useSettings } from "./settings-store.js";
import { severityToneFor } from "./themes.js";
import { ContextMenu } from "./context-menu.js";
import { useContextMenu, type ContextMenuItem } from "./use-context-menu.js";
import { copyToClipboard, defaultSpawn, defaultWhich } from "./clipboard.js";
import { sanitizeTuiText } from "./text.js";
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
  describeFindingsFilters,
  findingFromRow,
  groupFindings,
  type FindingsRow,
  type FindingsScreenOptions,
} from "./findings-data.js";
import { findingImpactLines } from "./finding-detail-layout.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import {
  findingSourcePath,
  fixEligibility,
} from "./fix-action.js";
import {
  DialogDetailColumn,
  DialogTitleRow,
  dialogTotalRows,
  wrapDialogLines,
  type DialogDetailLine,
} from "./dialog-screen-chrome.js";



/**
 * Rank used only to make the dialog's severity groups contiguous, so the
 * shared picker emits one heading per severity. A severity this does not
 * recognise sorts last into its own honest `unrated` heading rather than
 * being folded into a bucket it was never assigned.
 */
const FINDING_SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

function findingSeverityRank(severity: string): number {
  const index = FINDING_SEVERITY_ORDER.indexOf(String(severity).toLowerCase() as (typeof FINDING_SEVERITY_ORDER)[number]);
  return index < 0 ? FINDING_SEVERITY_ORDER.length : index;
}

function findingSeverityHeading(severity: string): string {
  const value = String(severity).trim();
  return value.length === 0 ? "unrated" : value.toUpperCase();
}

export function FindingsScreen({ options, onExit, shell, onSourceFix }: { options: FindingsScreenOptions; onExit: () => void; shell?: ShellNav; onSourceFix?: (findingId: string) => void }) {
  const theme = useTheme();
  const { mouseSupport } = useSettings();
  // Right-click context menu over a finding row. Opens only on a right press
  // and only when mouse support is on; the left-click path is untouched.
  const contextMenu = useContextMenu();
  const [rows, setRows] = useState<FindingsRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [triageBusy, setTriageBusy] = useState<FindingTriageStatus | null>(null);
  const [fixNotice, setFixNotice] = useState<string | null>(null);
  // The picker cursor and its filter; `index` is the cursor.
  const [findingsFilter, setFindingsFilter] = useState("");
  const [findingsFiltering, setFindingsFiltering] = useState(false);
  // A terminal delivers "/q" as a single input burst: the "/" handler's
  // state commit has not landed when "q" arrives, so every synchronous
  // decision in the key handler reads these refs instead. Render keeps
  // reading the state below — refs do not repaint.
  const findingsFilterRef = useRef("");
  const findingsFilteringRef = useRef(false);
  const applyFindingsFilter = (next: SetStateAction<string>) => {
    findingsFilterRef.current = typeof next === "function" ? next(findingsFilterRef.current) : next;
    setFindingsFilter(findingsFilterRef.current);
  };
  const applyFindingsFiltering = (next: boolean) => {
    findingsFilteringRef.current = next;
    setFindingsFiltering(next);
  };
  // The cursor has the same burst problem the filter had, and here it is not a
  // cursor glitch: in "/ab<enter>" the trailing key resolves its target against
  // the list as it stood BEFORE the burst, so enter, a, s, r and f would
  // operate on the wrong finding. Every synchronous decision in the key handler
  // reads this ref and the ref-derived list below; render keeps reading
  // `index`/`findingsFiltered` — refs do not repaint.
  const indexRef = useRef(0);
  const applyIndex = (next: number) => {
    indexRef.current = next;
    setIndex(next);
  };
  const { width, height } = useSurfaceDimensions();
  // The detail pane has no border or padding of its own; its PanelSections
  // supply the chrome, and the pane's scrollbar takes the remaining column.

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { osecDB } = await import("@0/db");
        const db = new osecDB(options.dbPath);
        try {
          const findings = db.listFindings({
            scanId: options.scan,
            severity: options.severity,
            category: options.category,
            status: options.status,
            triageStatus: options.triage,
            limit: options.all ? options.limit : 1000,
          }) as FindingsRow[];
          if (!alive) return;
          setRows(findings);
          applyIndex(0);
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
  }, [options, reloadNonce]);

  const groups = useMemo(() => groupFindings(rows).slice(0, options.limit), [rows, options.limit]);
  const items = options.all ? rows.slice(0, options.limit) : groups;
  const itemCount = items.length;

  // ── dialog interior: the same rows/families, grouped by severity ────────
  // Severity becomes the picker's category and its `tone`, so colour means
  // exactly what `severityToneFor` means everywhere else. The rows are the
  // same ones the legacy list draws; only their order is stabilised so each
  // severity emits a single heading.
  const findingsItems = useMemo<DialogItem[]>(() => {
    if (options.all) {
      const visible = rows.slice(0, options.limit);
      if (visible.length === 0) {
        return [{ id: "finding:none", label: "No findings found.", category: "Findings", disabled: true }];
      }
      return [...visible]
        .sort((a, b) => findingSeverityRank(a.severity) - findingSeverityRank(b.severity))
        .map((row) => ({
          id: `row:${row.id}`,
          label: row.title,
          description: `${row.category} · ${row.status} · ${row.triageStatus ?? "new"}`,
          meta: `scan:${row.scanId.slice(0, 8)}`,
          category: findingSeverityHeading(row.severity),
          tone: severityToneFor(theme, row.severity),
          // The gutter dot marks a family whose triage decision is in effect;
          // an untriaged row carries none.
          current: (row.triageStatus ?? "new") !== "new",
        }));
    }
    if (groups.length === 0) {
      return [{ id: "finding:none", label: "No findings found.", category: "Findings", disabled: true }];
    }
    return [...groups]
      .sort((a, b) => findingSeverityRank(a.latest.severity) - findingSeverityRank(b.latest.severity))
      .map((group) => ({
        id: `group:${group.fingerprint}`,
        label: group.latest.title,
        description: `${group.latest.category} · ${group.latest.status} · ${group.latest.triageStatus ?? "new"}`,
        meta: `${group.count} hits / ${group.scans} scans`,
        category: findingSeverityHeading(group.latest.severity),
        tone: severityToneFor(theme, group.latest.severity),
        current: (group.latest.triageStatus ?? "new") !== "new",
      }));
  }, [options.all, options.limit, rows, groups, theme]);
  const findingsFiltered = useMemo(() => filterDialogItems(findingsItems, findingsFilter), [findingsItems, findingsFilter]);
  const findingsCursor = clampDialogSelection(findingsFiltered, index);
  const findingsActiveId = findingsFiltered[findingsCursor]?.id;
  const dialogGroup = !options.all && findingsActiveId?.startsWith("group:")
    ? groups.find((group) => group.fingerprint === findingsActiveId.slice("group:".length)) ?? null
    : null;
  const dialogRow = options.all
    ? (findingsActiveId?.startsWith("row:")
        ? rows.find((row) => row.id === findingsActiveId.slice("row:".length)) ?? null
        : null)
    : dialogGroup?.latest ?? null;
  // `selectedRow` is what every triage and fix action below keys off; it is
  // resolved through the highlighted row's id so a filter cannot desync it.
  const selectedRow = dialogRow;
  // The list and the row every synchronous decision in the key handler resolves
  // against. `currentFindingsItems` recomputes only when the ref and the
  // render-time filter disagree — mid-burst — and otherwise hands back the memo.
  // `currentFindingsRow` mirrors the `dialogGroup`/`dialogRow` derivation above
  // exactly, only keyed off the ref-derived list and the ref-held cursor.
  const currentFindingsItems = () =>
    findingsFilterRef.current === findingsFilter ? findingsFiltered : filterDialogItems(findingsItems, findingsFilterRef.current);
  const currentFindingsRow = (): FindingsRow | null => {
    const visible = currentFindingsItems();
    const activeId = visible[clampDialogSelection(visible, indexRef.current)]?.id;
    if (!activeId) return null;
    if (options.all) {
      return activeId.startsWith("row:")
        ? rows.find((row) => row.id === activeId.slice("row:".length)) ?? null
        : null;
    }
    return activeId.startsWith("group:")
      ? groups.find((group) => group.fingerprint === activeId.slice("group:".length))?.latest ?? null
      : null;
  };
  const moveFindingsCursor = (step: number) => {
    const visible = currentFindingsItems();
    if (visible.length === 0) return;
    let next = clampDialogSelection(visible, indexRef.current);
    const dir: 1 | -1 = step >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(step); i += 1) next = moveDialogSelection(visible, next, dir);
    applyIndex(next);
  };
  const filterSummary = describeFindingsFilters(options);
  const itemCountLabel = options.all ? "rows " : "families ";

  // ── Source fix (`f`) ──
  const selectedFinding = useMemo(() => (selectedRow ? findingFromRow(selectedRow) : null), [selectedRow]);

  const palette = usePaletteController([
    {
      id: "accept-finding",
      title: "Accept finding family",
      category: "Triage",
      description: "Mark the selected fingerprint family as accepted",
      keybind: "a",
      suggested: true,
      action: () => { void mutateTriage("accepted"); },
    },
    {
      id: "suppress-finding",
      title: "Suppress finding family",
      category: "Triage",
      description: "Suppress the selected fingerprint family",
      keybind: "s",
      suggested: true,
      action: () => { void mutateTriage("suppressed"); },
    },
    {
      id: "reopen-finding",
      title: "Reopen finding family",
      category: "Triage",
      description: "Reset the selected fingerprint family back to new",
      keybind: "r",
      suggested: true,
      action: () => { void mutateTriage("new"); },
    },
    {
      id: "open-finding",
      title: "Inspect selected finding in chat",
      category: "Investigate",
      description: "Open evidence, then investigate or request a verified source fix in chat",
      keybind: "enter",
      suggested: true,
      action: () => {
        const row = currentFindingsRow();
        const finding = row === selectedRow ? selectedFinding : row ? findingFromRow(row) : null;
        if (row && finding) {
          shell?.openFindingDetail(row.id, finding);
        }
      },
    },
    {
      id: "fix-finding",
      title: "Generate source fix",
      category: "Remediation",
      description: "Generate and re-test a candidate source patch; never applies it",
      keybind: "f",
      suggested: true,
      action: () => { requestSourceFix(); },
    },
    {
      id: "back-findings",
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
    if (index >= itemCount && itemCount > 0) {
      applyIndex(itemCount - 1);
    }
  }, [index, itemCount]);

  const mutateTriage = async (triageStatus: FindingTriageStatus) => {
    // The family this writes to is resolved from the ref-derived list at press
    // time, never from a render-time selection a key burst may have left stale:
    // triage is a write, and a stale one lands on the wrong fingerprint.
    const selectedRow = currentFindingsRow();
    if (!selectedRow || triageBusy) return;
    if (!selectedRow.fingerprint) {
      setError(`Finding ${selectedRow.id} has no fingerprint and cannot be triaged as a family.`);
      return;
    }

    setTriageBusy(triageStatus);
    setError(null);
    setNotice(`Updating ${selectedRow.fingerprint.slice(0, 10)} to ${triageStatus}...`);

    try {
      const { osecDB } = await import("@0/db");
      const db = new osecDB(options.dbPath);
      try {
        db.updateFindingTriageByFingerprint(selectedRow.fingerprint, triageStatus);
      } finally {
        db.close();
      }
      setNotice(`Updated ${selectedRow.fingerprint.slice(0, 10)} to ${triageStatus}.`);
      setReloadNonce((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriageBusy(null);
    }
  };


  const requestSourceFix = (): void => {
    const row = currentFindingsRow();
    const finding = row === selectedRow ? selectedFinding : row ? findingFromRow(row) : null;
    const readiness = fixEligibility(finding);
    if (!readiness.eligible || !row) {
      setFixNotice(readiness.eligible ? "no finding selected" : readiness.reason);
      return;
    }
    if (!onSourceFix) {
      setFixNotice(`Open this finding in chat and use /fix ${row.id} to choose local inputs and approve execution.`);
      return;
    }
    onSourceFix(row.id);
  };


  // Open the highlighted finding in the persistent chat — the same action the
  // Enter key and the "open-finding" palette command perform.
  const openSelectedFinding = () => {
    const row = currentFindingsRow();
    const finding = row === selectedRow ? selectedFinding : row ? findingFromRow(row) : null;
    if (row && finding) shell?.openFindingDetail(row.id, finding);
  };

  // Copy a finding to the clipboard (title + severity + description + evidence).
  // This is the one context action the screen did not already expose; it is a
  // safe, backend-free default built on the shared clipboard util.
  const copyFinding = (row: FindingsRow) => {
    const text = [
      row.title,
      `${row.severity} · ${row.status} · ${row.triageStatus ?? "new"}`,
      "",
      row.description,
      "",
      "Evidence (request):",
      row.evidenceRequest,
      "",
      "Evidence (response):",
      row.evidenceResponse,
    ].join("\n");
    void copyToClipboard(text, { spawn: defaultSpawn, which: defaultWhich }).then((result) => {
      setNotice(result.ok ? "Copied finding to clipboard" : "Could not copy finding to clipboard");
    });
  };

  // The right-click menu for a finding row. Every action reuses an existing
  // screen handler; "Copy finding" is the safe default. Disabled states mirror
  // the reasons the keyboard paths would otherwise report (a family with no
  // fingerprint cannot be triaged; a finding the fixer rejects cannot be fixed).
  const buildFindingMenuItems = (row: FindingsRow | null): ContextMenuItem[] => {
    if (!row) return [];
    const canTriage = Boolean(row.fingerprint);
    const fixReady = fixEligibility(findingFromRow(row)).eligible;
    return [
      { label: "Open in chat", onSelect: openSelectedFinding },
      { label: "Accept family", disabled: !canTriage, onSelect: () => void mutateTriage("accepted") },
      { label: "Suppress family", disabled: !canTriage, onSelect: () => void mutateTriage("suppressed") },
      { label: "Reopen family", disabled: !canTriage, onSelect: () => void mutateTriage("new") },
      { label: "Generate source fix", disabled: !fixReady, onSelect: () => requestSourceFix() },
      { label: "Copy finding", onSelect: () => copyFinding(row) },
    ];
  };

  useKeyboard((key) => {
    // The context menu owns the keyboard while open (its own handler moves the
    // highlight / activates / closes); bail so the list beneath does not react.
    if (contextMenu.state.open) return;
    if (palette.handlePaletteKey(key)) return;
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    // Filter mode is entered only with "/". While it is open the triage and
    // fix letters are filter text, never actions, and esc clears the filter
    // before it can leave the screen.
    if (findingsFilteringRef.current) {
      if (key.name === "escape") {
        applyFindingsFiltering(false);
        applyFindingsFilter("");
        applyIndex(0);
        return;
      }
      if (key.name === "return") {
        applyFindingsFiltering(false);
        return;
      }
      if (key.name === "backspace") {
        applyFindingsFilter((current) => Array.from(current).slice(0, -1).join(""));
        applyIndex(0);
        return;
      }
      if (key.name === "up") return moveFindingsCursor(-1);
      if (key.name === "down") return moveFindingsCursor(1);
      if (key.name === "pageup") return moveFindingsCursor(-5);
      if (key.name === "pagedown") return moveFindingsCursor(5);
      const typed = typeof key.sequence === "string" ? key.sequence : "";
      if (!key.ctrl && !key.meta && typed.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(typed)) {
        applyFindingsFilter((current) => current + typed);
        applyIndex(0);
      }
      return;
    }
    if (key.name === "q") {
      onExit();
      return;
    }
    if (key.name === "escape") {
      if (findingsFilterRef.current.length > 0) {
        applyFindingsFilter("");
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
    if (key.name === "return") {
      const row = currentFindingsRow();
      const finding = row === selectedRow ? selectedFinding : row ? findingFromRow(row) : null;
      if (row && finding) shell?.openFindingDetail(row.id, finding);
      return;
    }
    if (key.name === "up") return moveFindingsCursor(-1);
    if (key.name === "down") return moveFindingsCursor(1);
    if (key.name === "pageup") return moveFindingsCursor(-5);
    if (key.name === "pagedown") return moveFindingsCursor(5);
    if (key.name === "home") return applyIndex(clampDialogSelection(currentFindingsItems(), 0));
    if (key.name === "end") {
      const visible = currentFindingsItems();
      return applyIndex(clampDialogSelection(visible, visible.length - 1));
    }
    if (key.sequence === "/") {
      applyFindingsFiltering(true);
      applyFindingsFilter("");
      applyIndex(0);
      return;
    }
    if (key.sequence === "a") void mutateTriage("accepted");
    if (key.sequence === "s") void mutateTriage("suppressed");
    if (key.sequence === "r") void mutateTriage("new");
    if (key.sequence === "f") requestSourceFix();
  });

  // Rows the picker may fill: the panel less the title row, the status line
  // and the single footer row the host draws.
  const findingsBodyRows = Math.max(1, height - 3);
  const findingsPanel = computeDialogPanel({
    width,
    height,
    size: "large",
    totalRows: dialogTotalRows(findingsFiltered),
    withDetail: true,
    bodyRows: findingsBodyRows,
  });
  const renderFindingsDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const inner = Math.max(1, pane.width - SCROLLBAR_COLUMN);
    const lines: DialogDetailLine[] = [];
    const group = item.id.startsWith("group:")
      ? groups.find((entry) => entry.fingerprint === item.id.slice("group:".length)) ?? null
      : null;
    const row = item.id.startsWith("row:")
      ? rows.find((entry) => entry.id === item.id.slice("row:".length)) ?? null
      : group?.latest ?? null;
    const finding = row === selectedRow ? selectedFinding : row ? findingFromRow(row) : null;
    const push = (value: string, fg?: string) => {
      lines.push(...wrapDialogLines(sanitizeTuiText(value), inner, fg));
    };

    lines.push({ text: options.all ? "FINDING" : "FAMILY", fg: row ? severityToneFor(theme, row.severity) : theme.PRIMARY });
    if (!row) {
      push("No finding selected", theme.MUTED);
    } else {
      push(row.title, theme.TEXT);
      push(`${row.severity} · ${row.status} · ${row.triageStatus ?? "new"}`, severityToneFor(theme, row.severity));
      if (group) push(`${group.count} hits / ${group.scans} scans`, theme.MUTED);
      push(`finding ${row.id} · scan ${row.scanId.slice(0, 8)} · fp:${(row.fingerprint ?? row.id).slice(0, 10)}`, theme.MUTED);
      if (row.triageNote) push(row.triageNote, theme.ACCENT);
    }

    lines.push({ text: "" });
    lines.push({ text: "DESCRIPTION", fg: theme.PRIMARY });
    push(row ? row.description : "-", theme.MUTED);

    lines.push({ text: "" });
    lines.push({ text: "IMPACT", fg: theme.PRIMARY });
    for (const line of finding ? findingImpactLines(finding) : ["Not assessed — no finding selected."]) {
      push(line, theme.MUTED);
    }

    lines.push({ text: "" });
    lines.push({ text: "EVIDENCE", fg: theme.PRIMARY });
    push("request", theme.TEXT);
    push(row ? row.evidenceRequest : "-", theme.MUTED);
    push("response", theme.TEXT);
    push(row ? row.evidenceResponse : "-", theme.MUTED);
    if (row?.evidenceAnalysis) {
      push("analysis", theme.TEXT);
      push(row.evidenceAnalysis, theme.MUTED);
    }

    if (finding) {
      const readiness = fixEligibility(finding);
      const sourceFile = findingSourcePath(finding);
      lines.push({ text: "" });
      lines.push({ text: "SOURCE FIX", fg: readiness.eligible ? theme.SUCCESS : theme.MUTED });
      push(readiness.eligible ? "Eligible for candidate generation" : `Unavailable — ${readiness.reason}`, theme.MUTED);
      if (sourceFile) push(`source ${sourceFile}`, theme.MUTED);
    }

    return <DialogDetailColumn lines={lines} pane={pane} />;
  };

  const findingsStatusLine = error
    ?? fixNotice
    ?? notice
    ?? `${itemCountLabel.trim()} ${itemCount} · loaded ${rows.length}`;
  const findingsStatusTone = error ? theme.ERROR : fixNotice ? theme.WARNING : notice ? theme.ACCENT : theme.MUTED;

  return (
    <ShellFrame view="findings" dialogContent>
      {palette.paletteOpen ? <PaletteOverlay title="Findings commands" query={palette.paletteQuery} selected={palette.paletteSelected} commands={palette.filteredPalette} /> : null}
      {contextMenu.state.open ? (
        <ContextMenu
          items={contextMenu.state.items}
          x={contextMenu.state.x}
          y={contextMenu.state.y}
          onClose={contextMenu.close}
        />
      ) : null}
      <box flexDirection="column" width="100%" height="100%" minWidth={0}>
        <DialogTitleRow
          screenKey="findings"
          width={width}
          meta={`scope ${filterSummary} · limit ${options.limit} · ${triageBusy ? `updating ${triageBusy} · ` : ""}${options.all ? "raw rows" : "grouped families"}`}
        />
        <DialogSelectBody
          items={findingsFiltered}
          cursor={findingsCursor}
          panel={findingsPanel}
          query={findingsFilter}
          placeholder={findingsFiltering ? "type to filter" : "/ to filter findings"}
          emptyText="No findings match this filter."
          gutter
          renderDetail={renderFindingsDetail}
          onActivateRow={(itemIndex) => applyIndex(itemIndex)}
          onHoverRow={(itemIndex) => applyIndex(itemIndex)}
          onScroll={moveFindingsCursor}
          onRowContextMenu={mouseSupport ? (itemIndex, event) => {
            // Select the right-clicked row first, so every reused action (which
            // resolves against the current selection) operates on it, then pop
            // the menu at the cursor.
            applyIndex(itemIndex);
            contextMenu.open(event.x, event.y, buildFindingMenuItems(currentFindingsRow()));
          } : undefined}
        />
        <Cells width={width} fg={findingsStatusTone}>
          {findingsStatusLine}
        </Cells>
        <FooterBar
          hint={findingsFiltering
            ? "type to filter · [⏎] keep · [esc] clear"
            : "[↑↓] move · [⏎] inspect · [f] fix setup · [/] filter · [esc] back"}
        />
      </box>
    </ShellFrame>
  );
}
