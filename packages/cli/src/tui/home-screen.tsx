/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScanExecutionMode, ScanGoal } from "@0sec/shared";
import { resolveEngagement } from "../engagement-plan.js";
import { useTheme } from "./theme-context.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import { computeDialogPanel } from "./dialog-select-layout.js";
import { Cells } from "./primitives.js";
import { SCROLLBAR_COLUMN } from "./shell-geometry.js";
import { FooterBar, ShellFrame } from "./shell-frame.js";
import type { ShellNav } from "./shell-nav.js";
import {
  PaletteOverlay,
  createShellCommands,
  usePaletteController,
} from "./command-palette.js";
import { cycleChoice } from "./findings-data.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import {
  DialogDetailColumn,
  DialogTitleRow,
  dialogTotalRows,
  wrapDialogLines,
  type DialogDetailLine,
} from "./dialog-screen-chrome.js";
import {
  tuiLensEvolutionStatusLabel,
  type TuiLensEvolutionStatus,
} from "./lens-evolution.js";
import type { HomeSelection, LaunchDepth, LaunchRuntime } from "./run.js";
import {
  SCAN_COST_CAP_OPTIONS_USD,
  SCAN_EXECUTION_OPTIONS,
  SCAN_GOAL_OPTIONS,
  SCAN_RUN_COUNT_OPTIONS,
  SCAN_TIME_CAP_OPTIONS_MS,
  createScanPlan,
  formatExecutionMode,
  formatGoal,
  formatTimeCap,
  cycleNumber,
  recommendedScanDepth,
  recommendedScanGoal,
  recommendedTimeCapMs,
} from "./scan-plan.js";

const RUNTIME_OPTIONS: LaunchRuntime[] = ["auto", "api", "claude", "codex", "gemini"];
const DEPTH_OPTIONS: LaunchDepth[] = ["quick", "default", "deep"];

export function HomeScreen({
  onResolve,
  onExit,
  shell,
  evolutionStatus,
}: {
  onResolve: (selection: HomeSelection) => void;
  onExit: () => void;
  shell?: ShellNav;
  evolutionStatus?: TuiLensEvolutionStatus;
}) {
  const theme = useTheme();
  const [inputValue, setInputValue] = useState("");
  const [focusIndex, setFocusIndex] = useState(0);
  const [runtime, setRuntime] = useState<LaunchRuntime>("auto");
  const [goal, setGoal] = useState<ScanGoal>("unknown-vulnerabilities");
  const [depth, setDepth] = useState<LaunchDepth>("deep");
  const [runCount, setRunCount] = useState<(typeof SCAN_RUN_COUNT_OPTIONS)[number]>(1);
  const [executionMode, setExecutionMode] = useState<ScanExecutionMode>("sequential");
  const [timeCapMs, setTimeCapMs] = useState<(typeof SCAN_TIME_CAP_OPTIONS_MS)[number]>(600_000);
  const [costCapUsd, setCostCapUsd] = useState<(typeof SCAN_COST_CAP_OPTIONS_USD)[number]>(5);
  const [goalEdited, setGoalEdited] = useState(false);
  const [depthEdited, setDepthEdited] = useState(false);
  const [timeEdited, setTimeEdited] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { width, height } = useSurfaceDimensions();
  const resolution = inputValue.trim() ? resolveEngagement(inputValue) : undefined;
  const targetKind = resolution?.ok
    ? resolution.plan.kind === "package"
      ? "package"
      : resolution.plan.kind === "web"
        ? "web"
        : "source"
    : "source";
  const recommendedGoal = recommendedScanGoal(targetKind);
  const recommendedDepth = recommendedScanDepth(goal);
  const recommendedTime = recommendedTimeCapMs(targetKind, depth);
  useEffect(() => {
    if (!goalEdited) setGoal(recommendedGoal);
  }, [goalEdited, recommendedGoal]);
  useEffect(() => {
    if (!depthEdited) setDepth(recommendedDepth);
  }, [depthEdited, recommendedDepth]);
  useEffect(() => {
    if (!timeEdited) setTimeCapMs(recommendedTime as (typeof SCAN_TIME_CAP_OPTIONS_MS)[number]);
  }, [recommendedTime, timeEdited]);
  const plan = createScanPlan({
    goal,
    depth,
    runCount,
    executionMode,
    timeCapMs,
    costCapUsd,
  });
  const planText = !resolution
    ? "Enter a URL, source path, git URL, or ecosystem-prefixed package."
    : resolution.ok
      ? `${resolution.plan.label} · ${formatGoal(goal)} · ${depth} · ${runCount} run${runCount === 1 ? "" : "s"} · ${formatExecutionMode(executionMode)} · ${formatTimeCap(timeCapMs)} · $${costCapUsd}`
      : resolution.message;
  const planTone = resolution?.ok ? theme.SUCCESS : resolution ? theme.WARNING : theme.MUTED;

  const submitLaunch = () => {
    if (!resolution) {
      setNotice("Enter an engagement target first.");
      return;
    }
    if (!resolution.ok) {
      setNotice(resolution.message);
      return;
    }
    if (!confirming) {
      setConfirming(true);
      setNotice("Plan ready. Press enter again to confirm.");
      return;
    }
    setNotice(null);
    onResolve({
      action: "run",
      target: inputValue.trim(),
      runtime,
      depth,
      plan,
    });
  };
  const palette = usePaletteController([
    {
      id: "run-engagement",
      title: "Run engagement",
      category: "Engagement",
      description: "Review and confirm the bounded scan plan",
      keybind: "enter",
      suggested: true,
      action: submitLaunch,
    },
    ...createShellCommands(shell),
  ]);

  const fields = useMemo(() => [
    {
      key: "target",
      label: "Target",
      value: inputValue,
      help: "URL · path · source: · npm: · pypi: · cargo: · oci:",
      editable: true,
    },
    { key: "goal", label: "Goal", value: formatGoal(goal), help: "left/right" },
    { key: "runtime", label: "Runtime", value: runtime, help: "left/right" },
    { key: "depth", label: "Depth", value: depth, help: "left/right" },
    { key: "runs", label: "Runs", value: String(runCount), help: "left/right" },
    { key: "mode", label: "Mode", value: formatExecutionMode(executionMode), help: "left/right" },
    { key: "time", label: "Time cap", value: formatTimeCap(timeCapMs), help: "left/right" },
    { key: "cost", label: "Cost cap", value: `$${costCapUsd}`, help: "left/right" },
  ], [costCapUsd, depth, executionMode, goal, inputValue, runCount, runtime, timeCapMs]);

  const adjustFocusedOption = (delta: 1 | -1) => {
    const field = fields[focusIndex]?.key;
    setConfirming(false);
    if (field === "goal") {
      setGoalEdited(true);
      setGoal((current) => cycleChoice(SCAN_GOAL_OPTIONS, current, delta));
    }
    if (field === "runtime") setRuntime((current) => cycleChoice(RUNTIME_OPTIONS, current, delta));
    if (field === "depth") {
      setDepthEdited(true);
      setDepth((current) => cycleChoice(DEPTH_OPTIONS, current, delta));
    }
    if (field === "runs") setRunCount((current) => cycleNumber(SCAN_RUN_COUNT_OPTIONS, current, delta));
    if (field === "mode") setExecutionMode((current) => cycleChoice(SCAN_EXECUTION_OPTIONS, current, delta));
    if (field === "time") {
      setTimeEdited(true);
      setTimeCapMs((current) => cycleNumber(SCAN_TIME_CAP_OPTIONS_MS, current, delta));
    }
    if (field === "cost") setCostCapUsd((current) => cycleNumber(SCAN_COST_CAP_OPTIONS_USD, current, delta));
  };


  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    if (palette.handlePaletteKey(key)) return;
    if (key.name === "escape") {
      shell?.goBack();
      return;
    }
    if (key.name === "up" || (key.name === "tab" && key.shift)) {
      setFocusIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.name === "down" || key.name === "tab") {
      setFocusIndex((current) => Math.min(fields.length - 1, current + 1));
      return;
    }
    if (key.name === "left") {
      adjustFocusedOption(-1);
      return;
    }
    if (key.name === "right") {
      adjustFocusedOption(1);
      return;
    }
    if (key.name === "return") {
      submitLaunch();
      return;
    }
    if (key.name === "backspace" && fields[focusIndex]?.key === "target") {
      setConfirming(false);
      setInputValue((current) => current.slice(0, -1));
      return;
    }
    if (fields[focusIndex]?.key === "target" && key.sequence && !key.ctrl && !key.meta && key.name !== "return") {
      setConfirming(false);
      setInputValue((current) => current + key.sequence);
    }
  });


  // ── dialog interior ──────────────────────────────────────────────────────
  // Inside `DialogSurface` the launcher is a pop-up: the `＋ New engagement`
  // title row, the shared picker over the three engagement choices with every
  // runtime and depth listed (a dot on the one in effect), a detail column
  // carrying the full target and the resolved plan, one status line and the
  // host's single footer row. The keyboard is untouched — up/down still moves
  // between the three fields, left/right still cycles the focused one, enter
  // still submits — so the cursor is derived from `focusIndex` and the current
  // values rather than owned by the list.
  const launchItems: DialogItem[] = [
    {
      id: "field:target",
      label: "Target",
      description: inputValue.length > 0 ? inputValue : "not set",
      meta: resolution ? (resolution.ok ? "resolved" : "unresolved") : undefined,
      category: "Scope",
      current: inputValue.length > 0,
      tone: resolution ? (resolution.ok ? theme.SUCCESS : theme.WARNING) : undefined,
    },
    ...SCAN_GOAL_OPTIONS.map((option) => ({
      id: `goal:${option}`,
      label: formatGoal(option),
      category: "Goal",
      current: option === goal,
    })),
    ...RUNTIME_OPTIONS.map((option) => ({
      id: `runtime:${option}`,
      label: option,
      category: "Runtime",
      current: option === runtime,
    })),
    ...DEPTH_OPTIONS.map((option) => ({
      id: `depth:${option}`,
      label: option,
      category: "Depth",
      current: option === depth,
    })),
    ...SCAN_RUN_COUNT_OPTIONS.map((option) => ({
      id: `runs:${option}`,
      label: String(option),
      category: "Runs",
      current: option === runCount,
    })),
    ...SCAN_EXECUTION_OPTIONS.map((option) => ({
      id: `mode:${option}`,
      label: formatExecutionMode(option),
      category: "Execution",
      current: option === executionMode,
    })),
    ...SCAN_TIME_CAP_OPTIONS_MS.map((option) => ({
      id: `time:${option}`,
      label: formatTimeCap(option),
      category: "Time cap",
      current: option === timeCapMs,
    })),
    ...SCAN_COST_CAP_OPTIONS_USD.map((option) => ({
      id: `cost:${option}`,
      label: `$${option}`,
      category: "Cost cap",
      current: option === costCapUsd,
    })),
  ];
  const activeField = fields[focusIndex]?.key;
  const groupStarts = {
    goal: 1,
    runtime: 1 + SCAN_GOAL_OPTIONS.length,
    depth: 1 + SCAN_GOAL_OPTIONS.length + RUNTIME_OPTIONS.length,
    runs: 1 + SCAN_GOAL_OPTIONS.length + RUNTIME_OPTIONS.length + DEPTH_OPTIONS.length,
    mode: 1 + SCAN_GOAL_OPTIONS.length + RUNTIME_OPTIONS.length + DEPTH_OPTIONS.length + SCAN_RUN_COUNT_OPTIONS.length,
    time: 1 + SCAN_GOAL_OPTIONS.length + RUNTIME_OPTIONS.length + DEPTH_OPTIONS.length + SCAN_RUN_COUNT_OPTIONS.length + SCAN_EXECUTION_OPTIONS.length,
    cost: 1 + SCAN_GOAL_OPTIONS.length + RUNTIME_OPTIONS.length + DEPTH_OPTIONS.length + SCAN_RUN_COUNT_OPTIONS.length + SCAN_EXECUTION_OPTIONS.length + SCAN_TIME_CAP_OPTIONS_MS.length,
  } as const;
  const dialogCursor = activeField === "goal"
    ? groupStarts.goal + Math.max(0, SCAN_GOAL_OPTIONS.indexOf(goal))
    : activeField === "runtime"
      ? groupStarts.runtime + Math.max(0, RUNTIME_OPTIONS.indexOf(runtime))
      : activeField === "depth"
        ? groupStarts.depth + Math.max(0, DEPTH_OPTIONS.indexOf(depth))
        : activeField === "runs"
          ? groupStarts.runs + Math.max(0, SCAN_RUN_COUNT_OPTIONS.indexOf(runCount))
          : activeField === "mode"
            ? groupStarts.mode + Math.max(0, SCAN_EXECUTION_OPTIONS.indexOf(executionMode))
            : activeField === "time"
              ? groupStarts.time + Math.max(0, SCAN_TIME_CAP_OPTIONS_MS.indexOf(timeCapMs))
              : activeField === "cost"
                ? groupStarts.cost + Math.max(0, SCAN_COST_CAP_OPTIONS_USD.indexOf(costCapUsd))
                : 0;
  // Rows the picker may fill: everything the panel has, less the title row,
  // the status line and the one footer row the host draws.
  const launchBodyRows = Math.max(1, height - 3);
  const launchPanel = computeDialogPanel({
    width,
    height,
    size: "large",
    totalRows: dialogTotalRows(launchItems),
    withDetail: true,
    bodyRows: launchBodyRows,
  });
  const renderLaunchDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const inner = Math.max(1, pane.width - SCROLLBAR_COLUMN);
    const lines: DialogDetailLine[] = [];
    const selectedLabel =
      item.id.startsWith("goal:") ? formatGoal(goal)
        : item.id.startsWith("runtime:") ? runtime
          : item.id.startsWith("depth:") ? depth
            : item.id.startsWith("runs:") ? String(runCount)
              : item.id.startsWith("mode:") ? formatExecutionMode(executionMode)
                : item.id.startsWith("time:") ? formatTimeCap(timeCapMs)
                  : item.id.startsWith("cost:") ? `$${costCapUsd}`
                    : inputValue.length > 0 ? inputValue : "not set";
    const heading = item.id.startsWith("field:target")
      ? "SCOPE"
      : (item.category ?? "OPTION").toUpperCase();
    lines.push({ text: heading, fg: theme.PRIMARY });
    lines.push(...wrapDialogLines(selectedLabel, inner, theme.TEXT));
    if (item.id.startsWith("field:target")) {
      lines.push({ text: resolution?.ok ? "resolved" : "enter and verify target", fg: resolution?.ok ? theme.SUCCESS : theme.MUTED });
    } else {
      lines.push({ text: "selected", fg: theme.MUTED });
    }
    lines.push({ text: "" });
    lines.push(...wrapDialogLines(planText, inner, planTone));
    lines.push({ text: "" });
    lines.push(...wrapDialogLines(`recommended: ${formatGoal(recommendedGoal)} · ${recommendedDepth} · ${formatTimeCap(recommendedTime)} · $5`, inner, theme.MUTED));
    lines.push(...wrapDialogLines(`runtime ${runtime} · ${runCount} run${runCount === 1 ? "" : "s"} · ${formatExecutionMode(executionMode)}`, inner, theme.MUTED));
    const help = fields[focusIndex]?.help;
    if (help) lines.push(...wrapDialogLines(help, inner, theme.MUTED));
    if (notice) lines.push(...wrapDialogLines(notice, inner, theme.WARNING));
    if (evolutionStatus) lines.push(...wrapDialogLines(evolutionStatus.message, inner, theme.MUTED));
    return <DialogDetailColumn lines={lines} pane={pane} />;
  };
  return (
    <ShellFrame view="engagement control" dialogContent>
      {palette.paletteOpen ? <PaletteOverlay title="Control plane" query={palette.paletteQuery} selected={palette.paletteSelected} commands={palette.filteredPalette} /> : null}
      <box flexDirection="column" width="100%" height="100%" minWidth={0}>
        <DialogTitleRow screenKey="launcher" width={width} meta={`${formatGoal(goal)} · ${depth} · ${formatTimeCap(timeCapMs)} · $${costCapUsd}`} />
        <DialogSelectBody
          items={launchItems}
          cursor={dialogCursor}
          panel={launchPanel}
          query=""
          hideSearch
          gutter
          renderDetail={renderLaunchDetail}
          emptyText="No engagement options."
        />
        <Cells width={width} fg={notice ? theme.WARNING : planTone}>
          {notice ?? planText}
        </Cells>
        <FooterBar hint="[⏎] review/confirm · [←→] change · [⌃P] workspace · [⌃C] exit" status={evolutionStatus ? tuiLensEvolutionStatusLabel(evolutionStatus) : undefined} />
      </box>
    </ShellFrame>
  );
}
