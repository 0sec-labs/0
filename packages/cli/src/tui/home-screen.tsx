/** @jsxImportSource @opentui/react */
import { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
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
  const [depth, setDepth] = useState<LaunchDepth>("deep");
  const [notice, setNotice] = useState<string | null>(null);
  const { width, height } = useSurfaceDimensions();
  const resolution = inputValue.trim() ? resolveEngagement(inputValue) : undefined;
  const planText = !resolution
    ? "Enter a URL, source path, git URL, or ecosystem-prefixed package."
    : resolution.ok
      ? resolution.plan.label
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
    setNotice(null);
    onResolve({
      action: "run",
      target: inputValue.trim(),
      runtime,
      depth,
    });
  };

  const palette = usePaletteController([
    {
      id: "run-engagement",
      title: "Run engagement",
      category: "Engagement",
      description: "Submit the resolved target through the single control-plane runner",
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
    { key: "runtime", label: "Runtime", value: runtime, help: "left/right" },
    { key: "depth", label: "Depth", value: depth, help: "left/right" },
  ], [depth, inputValue, runtime]);

  const adjustFocusedOption = (delta: 1 | -1) => {
    const field = fields[focusIndex]?.key;
    if (field === "runtime") setRuntime((current) => cycleChoice(RUNTIME_OPTIONS, current, delta));
    if (field === "depth") setDepth((current) => cycleChoice(DEPTH_OPTIONS, current, delta));
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    if (palette.handlePaletteKey(key)) return;
    if (key.name === "escape") {
      if (shell?.canGoBack) shell.goBack();
      else onExit();
      return;
    }
    if (key.name === "up") {
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
      setInputValue((current) => current.slice(0, -1));
      return;
    }
    if (fields[focusIndex]?.key === "target" && key.sequence && !key.ctrl && !key.meta && key.name !== "return") {
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
      category: "Engagement",
      current: inputValue.length > 0,
      tone: resolution ? (resolution.ok ? theme.SUCCESS : theme.WARNING) : undefined,
    },
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
  ];
  const activeField = fields[focusIndex]?.key;
  const dialogCursor = activeField === "runtime"
    ? 1 + Math.max(0, RUNTIME_OPTIONS.indexOf(runtime))
    : activeField === "depth"
      ? 1 + RUNTIME_OPTIONS.length + Math.max(0, DEPTH_OPTIONS.indexOf(depth))
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
    if (item.id.startsWith("runtime:")) {
      lines.push({ text: "RUNTIME", fg: theme.PRIMARY });
      lines.push({ text: item.label, fg: item.label === runtime ? theme.SUCCESS : theme.TEXT });
      lines.push({ text: item.label === runtime ? "selected" : "not selected", fg: theme.MUTED });
    } else if (item.id.startsWith("depth:")) {
      lines.push({ text: "DEPTH", fg: theme.PRIMARY });
      lines.push({ text: item.label, fg: item.label === depth ? theme.SUCCESS : theme.TEXT });
      lines.push({ text: item.label === depth ? "selected" : "not selected", fg: theme.MUTED });
    } else {
      lines.push({ text: "TARGET", fg: theme.PRIMARY });
      if (inputValue.length > 0) lines.push(...wrapDialogLines(inputValue, inner, theme.TEXT));
      else lines.push({ text: "not set", fg: theme.MUTED });
    }
    lines.push({ text: "" });
    lines.push(...wrapDialogLines(planText, inner, planTone));
    lines.push({ text: "" });
    lines.push(...wrapDialogLines(`runtime ${runtime} · depth ${depth}`, inner, theme.MUTED));
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
        <DialogTitleRow screenKey="launcher" width={width} meta={`${runtime} · ${depth}`} />
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
        <FooterBar hint="enter run · ctrl+p workspace · ctrl+c exit" status={evolutionStatus ? tuiLensEvolutionStatusLabel(evolutionStatus) : undefined} />
      </box>
    </ShellFrame>
  );
}
