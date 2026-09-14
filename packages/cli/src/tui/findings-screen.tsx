/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useKeyboard } from "@opentui/react";
import type { Finding, FindingTriageStatus } from "@0sec/shared";
import { useTheme } from "./theme-context.js";
import { useSettings } from "./settings-store.js";
import { severityToneFor } from "./themes.js";
import { ContextMenu } from "./context-menu.js";
import { useContextMenu, type ContextMenuItem } from "./use-context-menu.js";
import { copyToClipboard, defaultSpawn, defaultWhich } from "./clipboard.js";
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
  describeFindingsFilters,
  findingFromRow,
  groupFindings,
  isNativeRuntime,
  resolveFixRepoRoot,
  type FindingsRow,
  type FindingsScreenOptions,
  type FixRunState,
} from "./findings-data.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import {
  describeFixStatus,
  findingSourcePath,
  fixEligibility,
  fixInputEligibility,
  fixResultLines,
} from "./fix-action.js";
import {
  DialogDetailColumn,
  DialogTitleRow,
  dialogTotalRows,
  wrapDialogLines,
  type DialogDetailLine,
} from "./dialog-screen-chrome.js";

// ── Source-fix action (`f` on the Findings screen) ──
//
// These mirror the defaults of `0sec fix` (packages/cli/src/commands/fix.ts)
// so the TUI and the CLI behave identically. `apply` is deliberately absent:
// the CLI defaults `--apply` to false and applying stays an explicit,
// separate operator action.
const FIX_MODEL_TIMEOUT_MS = 600_000;
const FIX_TEST_TIMEOUT_MS = 300_000;
const FIX_MAX_ATTEMPTS = 3;
/** Operator-owned regression command; `0sec fix` requires --test-command. */
const FIX_TEST_COMMAND_ENV = "0SEC_FIX_TEST_COMMAND";

// Upper bound on how far a wrapped finding detail may run inside its
// scrolling pane, expressed in rows of the pane's own width.
const FINDING_DETAIL_MAX_WRAPPED_ROWS = 40;

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

export function FindingsScreen({ options, onExit, shell }: { options: FindingsScreenOptions; onExit: () => void; shell?: ShellNav }) {
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
  const [scanTargets, setScanTargets] = useState<Record<string, string>>({});
  const [fixRun, setFixRun] = useState<FixRunState | null>(null);
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
  // State updates are batched, so the re-entry guard cannot read `fixRun`:
  // two `f` presses in the same frame would both see `null`. The ref flips
  // synchronously inside the key handler instead.
  const fixBusyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { width, height } = useSurfaceDimensions();
  // The detail pane has no border or padding of its own; its PanelSections
  // supply the chrome, and the pane's scrollbar takes the remaining column.

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { osecDB } = await import("@0sec/db");
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
          // The scan's target doubles as the repo the source-fix action runs
          // in, mirroring the `<repo>` argument of `0sec fix`.
          const targets: Record<string, string> = {};
          for (const scanId of new Set(findings.map((row) => row.scanId))) {
            const scan = db.getScan(scanId);
            if (scan?.target) targets[scanId] = scan.target;
          }
          if (!alive) return;
          setRows(findings);
          setScanTargets(targets);
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
  // These wrap rather than truncate — the pane scrolls, so a description is
  // worth reading in full. `Math.max(width, value.length)` made that budget
  // unbounded though, and a finding's evidence can be an entire HTTP
  // response, so cap it at the rows the pane can plausibly be scrolled over.

  // ── Source fix (`f`) ──
  const selectedFinding = useMemo(() => (selectedRow ? findingFromRow(selectedRow) : null), [selectedRow]);
  const fixRepoRoot = useMemo(() => resolveFixRepoRoot(selectedRow, scanTargets), [selectedRow, scanTargets]);
  const fixTestCommand = process.env[FIX_TEST_COMMAND_ENV] ?? "";
  const fixSourceFile = useMemo(() => findingSourcePath(selectedFinding), [selectedFinding]);
  // The finding-level predicate runs first so the operator sees the same
  // reason `0sec fix` would report first.
  const fixReadiness = useMemo(() => {
    const findingCheck = fixEligibility(selectedFinding);
    if (!findingCheck.eligible) return findingCheck;
    return fixInputEligibility({ repoRoot: fixRepoRoot, testCommand: fixTestCommand });
  }, [selectedFinding, fixRepoRoot, fixTestCommand]);
  const activeFixRun = fixRun && selectedRow && fixRun.findingId === selectedRow.id ? fixRun : null;
  const fixRunning = fixRun?.status === "running";
  const fixPanelTone = !activeFixRun
    ? theme.BORDER
    : activeFixRun.status === "running"
      ? theme.PRIMARY
      : activeFixRun.status === "validated_candidate" || activeFixRun.status === "applied_and_retested"
        ? theme.SUCCESS
        : theme.ERROR;

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
      description: "Open evidence, then investigate or plan a fix in the persistent chat",
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
      const { osecDB } = await import("@0sec/db");
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

  /**
   * Run `runSourceFix` exactly as `0sec fix` does, minus `--apply`. The await
   * chain yields to the event loop, so the renderer keeps painting while the
   * model call and the regression command run.
   */
  const runSourceFixForRow = async (
    row: FindingsRow,
    finding: Finding,
    repoRoot: string,
    testCommand: string,
  ): Promise<void> => {
    try {
      const { createRuntime, runSourceFix } = await import("@0sec/core");
      const runtime = createRuntime({ type: "api", timeout: FIX_MODEL_TIMEOUT_MS });
      if (!isNativeRuntime(runtime)) {
        throw new Error("runtime 'api' does not support structured source remediation");
      }
      if (!(await runtime.isAvailable())) {
        throw new Error("runtime 'api' is not available");
      }
      const result = await runSourceFix({
        repoRoot,
        finding,
        runtime,
        testCommand,
        // `0sec fix` defaults --apply to false. Applying a validated patch
        // stays an explicit, separate operator action; the TUI never widens
        // that gate.
        apply: false,
        maxAttempts: FIX_MAX_ATTEMPTS,
        testTimeoutMs: FIX_TEST_TIMEOUT_MS,
      });
      if (!mountedRef.current) return;
      setFixRun({ findingId: row.id, status: result.status, result });
    } catch (err) {
      if (!mountedRef.current) return;
      setFixRun({
        findingId: row.id,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      fixBusyRef.current = false;
    }
  };

  const requestSourceFix = (): void => {
    if (fixBusyRef.current) {
      setFixNotice("a fix run is already in progress");
      return;
    }
    // The row this runs against is resolved from the ref-derived list at press
    // time. When that agrees with the render-time selection the memos above are
    // reused verbatim; when a burst has moved the cursor, the same predicates
    // run again over the same inputs in the same order — `fixEligibility`
    // first, then `fixInputEligibility` — so the gate is identical either way.
    const row = currentFindingsRow();
    const rendered = row === selectedRow;
    const finding = rendered ? selectedFinding : row ? findingFromRow(row) : null;
    if (!row || !finding) {
      setFixNotice("no finding selected");
      return;
    }
    const repoRoot = rendered ? fixRepoRoot : resolveFixRepoRoot(row, scanTargets);
    const testCommand = fixTestCommand;
    const findingCheck = rendered ? fixReadiness : fixEligibility(finding);
    const readiness = findingCheck.eligible && !rendered
      ? fixInputEligibility({ repoRoot, testCommand })
      : findingCheck;
    if (!readiness.eligible) {
      setFixNotice(readiness.reason);
      return;
    }
    if (!repoRoot || !testCommand) {
      setFixNotice("fix inputs went missing before the run started");
      return;
    }
    fixBusyRef.current = true;
    setFixNotice(null);
    setFixRun({ findingId: row.id, status: "running" });
    void runSourceFixForRow(row, finding, repoRoot, testCommand);
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
    // The same char budget the legacy pane used, so nothing that was
    // readable there stops being readable here; the column scrolls.
    const wrapBudget = inner * FINDING_DETAIL_MAX_WRAPPED_ROWS;
    const lines: DialogDetailLine[] = [];
    const group = item.id.startsWith("group:")
      ? groups.find((entry) => entry.fingerprint === item.id.slice("group:".length)) ?? null
      : null;
    const row = item.id.startsWith("row:")
      ? rows.find((entry) => entry.id === item.id.slice("row:".length)) ?? null
      : group?.latest ?? null;
    const push = (value: string, fg?: string) => {
      lines.push(...wrapDialogLines(fitTuiText(value, wrapBudget), inner, fg));
    };

    lines.push({ text: options.all ? "FINDING" : "FAMILY", fg: row ? severityToneFor(theme, row.severity) : theme.PRIMARY });
    if (!row) {
      push("No finding selected", theme.MUTED);
    } else {
      push(row.title, theme.TEXT);
      push(`${row.severity} · ${row.status} · ${row.triageStatus ?? "new"}`, severityToneFor(theme, row.severity));
      if (group) push(`${group.count} hits / ${group.scans} scans`, theme.MUTED);
      push(`scan ${row.scanId.slice(0, 8)} · fp:${(row.fingerprint ?? row.id).slice(0, 10)}`, theme.MUTED);
      if (row.triageNote) push(row.triageNote, theme.ACCENT);
    }

    // Source fix. The candidate patch body and the pre/postcondition
    // predicate arrays stay out for the same reason the legacy pane kept
    // them out: `0sec fix --output` is the supported way to get them.
    lines.push({ text: "" });
    lines.push({ text: "SOURCE FIX", fg: fixPanelTone });
    push(
      fixReadiness.eligible
        ? "ready — press f to generate a candidate fix"
        : `unavailable — ${fixReadiness.reason}`,
      fixReadiness.eligible ? theme.SUCCESS : theme.MUTED,
    );
    if (fixSourceFile) push(`source ${fixSourceFile}`, theme.MUTED);
    if (fixRepoRoot) push(`repo ${fixRepoRoot}`, theme.MUTED);
    if (fixNotice) push(fixNotice, theme.WARNING);
    if (activeFixRun) {
      push(describeFixStatus(activeFixRun.status, activeFixRun.result), fixPanelTone);
      if (activeFixRun.error) push(`error ${activeFixRun.error}`, theme.ERROR);
      if (activeFixRun.result) {
        for (const line of fixResultLines(activeFixRun.result)) push(line, theme.MUTED);
      }
    } else {
      // A finding whose fix has not run says exactly that, uncoloured: it
      // must never read like one that produced a validated candidate.
      push("no fix run for this finding", theme.MUTED);
    }
    if (fixRunning && !activeFixRun) push("a fix is running for another finding", theme.MUTED);

    lines.push({ text: "" });
    lines.push({ text: "FILTERS", fg: theme.PRIMARY });
    push(filterSummary, theme.MUTED);
    push(`limit ${options.limit}`, theme.MUTED);
    push(`mode ${options.all ? "raw rows" : "grouped families"}`, theme.MUTED);
    push("enter inspect/chat · a accept · s suppress · r reopen · f generate candidate", theme.MUTED);

    lines.push({ text: "" });
    lines.push({ text: "DESCRIPTION", fg: theme.PRIMARY });
    push(row ? row.description : "-", theme.MUTED);

    lines.push({ text: "" });
    lines.push({ text: "EVIDENCE", fg: theme.PRIMARY });
    push("request", theme.TEXT);
    push(row ? row.evidenceRequest : "-", theme.MUTED);
    push("response", theme.TEXT);
    push(row ? row.evidenceResponse : "-", theme.MUTED);

    return <DialogDetailColumn lines={lines} pane={pane} />;
  };

  const findingsStatusLine = error
    ?? fixNotice
    ?? notice
    ?? `scope ${filterSummary} · ${itemCountLabel.trim()} ${itemCount} · loaded ${rows.length}`;
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
          meta={fixRunning ? "generating fix" : triageBusy ? `updating ${triageBusy}` : options.all ? "raw rows" : "grouped families"}
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
            ? "type to filter · enter keep · esc clear"
            : "↑↓ move · enter inspect · a accept · s suppress · r reopen · f fix · / filter · esc back"}
        />
      </box>
    </ShellFrame>
  );
}
