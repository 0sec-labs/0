/** @jsxImportSource @opentui/react */
import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { getRuntimeAvailability } from "../utils.js";
import { useTheme } from "./theme-context.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import {
  clampDialogSelection,
  computeDialogPanel,
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
import type { DoctorState } from "./findings-data.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import {
  DialogDetailColumn,
  DialogTitleRow,
  dialogTotalRows,
  wrapDialogLines,
  type DialogDetailLine,
} from "./dialog-screen-chrome.js";

export function DoctorScreen({ onExit, shell }: { onExit: () => void; shell?: ShellNav }) {
  const theme = useTheme();
  const [state, setState] = useState<DoctorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The picker cursor.
  const [doctorSelected, setDoctorSelected] = useState(0);
  const { width, height } = useSurfaceDimensions();
  // As in mission control: fitTuiText trims, so labels carrying their own
  // trailing space came back without one and fused onto the value
  // ("nodev22.4.1"). The gap between them is a layout gap now.
  // Same unscrolled-section arithmetic as mission control. Only the sample
  // command block is optional, so that is what gives when the frame is short.
  const palette = usePaletteController([
    {
      id: "back-doctor",
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
    void getRuntimeAvailability()
      .then((result) => {
        if (!alive) return;
        const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
        setState({
          nodeOk: nodeMajor >= 24,
          nodeVersion: process.version,
          ...result,
        });
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  useKeyboard((key) => {
    if (palette.handlePaletteKey(key)) return;
    if ((key.ctrl && key.name === "c") || key.name === "q") {
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
    if (key.name === "up") return moveDoctorCursor(-1);
    if (key.name === "down") return moveDoctorCursor(1);
    if (key.name === "pageup") return moveDoctorCursor(-5);
    if (key.name === "pagedown") return moveDoctorCursor(5);
    if (key.name === "home") return setDoctorSelected(clampDialogSelection(doctorItems, 0));
    if (key.name === "end") return setDoctorSelected(clampDialogSelection(doctorItems, doctorItems.length - 1));
  });

  const nextStep = !state
    ? "Checking environment"
    : !state.nodeOk
      ? "Upgrade to Node 24+ before running 0sec."
      : state.apiRuntime.configured && !state.apiRuntime.valid && state.apiRuntime.error
        ? "Repair the configured API runtime before scanning."
        : state.hasApiKey || state.availableRuntimes.length > 0
          ? "Ready to scan. Try scan, review, or audit from the launcher."
          : "Install Claude/Codex/Gemini CLI or set an API key.";

  // ── dialog interior ──────────────────────────────────────────────────────
  // The three environment probes and the next-step guidance, projected onto
  // the shared picker. A probe that has not returned reads "checking" and
  // carries no tone: an unrun check is never a pass.
  const nodeStatus = !state ? "checking" : state.nodeOk ? "ok" : "bad";
  const apiStatus = !state ? "checking" : state.hasApiKey ? "ok" : state.apiRuntime.configured ? "bad" : "missing";
  const cliStatus = !state ? "checking" : state.availableRuntimes.length > 0 ? "ok" : "missing";
  const statusTone = (status: string): string | undefined => {
    if (status === "ok") return theme.SUCCESS;
    if (status === "bad") return theme.ERROR;
    if (status === "missing") return theme.WARNING;
    return undefined;
  };
  const showDoctorExamples = state != null && (state.hasApiKey || state.availableRuntimes.length > 0);
  const doctorItems: DialogItem[] = [
    {
      id: "check:node",
      label: "Node.js",
      description: state?.nodeVersion ?? "checking",
      meta: nodeStatus,
      category: "Environment",
      tone: statusTone(nodeStatus),
    },
    {
      id: "check:api",
      label: "API runtime",
      description: state?.apiRuntime.providerLabel ?? "checking",
      meta: apiStatus,
      category: "Environment",
      tone: statusTone(apiStatus),
    },
    {
      id: "check:cli",
      label: "CLI runtimes",
      description: state ? (state.availableRuntimes.join(", ") || "none") : "checking",
      meta: cliStatus,
      category: "Environment",
      tone: statusTone(cliStatus),
    },
    {
      id: "step:next",
      label: nextStep,
      category: "Next steps",
      tone: state && !state.nodeOk ? theme.ERROR : undefined,
    },
    ...(showDoctorExamples
      ? [
          { id: "step:scan", label: "0sec scan --target https://example.com --mode web", meta: "example", category: "Next steps" },
          { id: "step:review", label: "0sec review .", meta: "example", category: "Next steps" },
          { id: "step:audit", label: "0sec audit express", meta: "example", category: "Next steps" },
        ]
      : []),
  ];
  const doctorCursor = clampDialogSelection(doctorItems, doctorSelected);
  const moveDoctorCursor = (step: number) => {
    if (doctorItems.length === 0) return;
    let next = doctorCursor;
    const dir: 1 | -1 = step >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(step); i += 1) next = moveDialogSelection(doctorItems, next, dir);
    setDoctorSelected(next);
  };

  const doctorBodyRows = Math.max(1, height - 3); // title row + status line + host footer
  const doctorPanel = computeDialogPanel({
    width,
    height,
    size: "large",
    totalRows: dialogTotalRows(doctorItems),
    withDetail: true,
    bodyRows: doctorBodyRows,
  });
  const renderDoctorDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const inner = Math.max(1, pane.width - SCROLLBAR_COLUMN);
    const lines: DialogDetailLine[] = [];
    if (item.id === "check:node") {
      lines.push({ text: "NODE.JS", fg: theme.PRIMARY });
      lines.push({ text: nodeStatus, fg: statusTone(nodeStatus) ?? theme.MUTED });
      lines.push({ text: "" });
      lines.push(...wrapDialogLines(state ? `version ${state.nodeVersion}` : "version unknown", inner, theme.TEXT));
      lines.push(...wrapDialogLines("0sec requires Node 24 or newer.", inner, theme.MUTED));
    } else if (item.id === "check:api") {
      lines.push({ text: "API RUNTIME", fg: theme.PRIMARY });
      lines.push({ text: apiStatus, fg: statusTone(apiStatus) ?? theme.MUTED });
      lines.push({ text: "" });
      if (!state) {
        lines.push({ text: "provider unknown", fg: theme.MUTED });
      } else {
        lines.push(...wrapDialogLines(`provider ${state.apiRuntime.providerLabel}`, inner, theme.TEXT));
        lines.push(...wrapDialogLines(`configured ${state.apiRuntime.configured ? "yes" : "no"}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`valid ${state.apiRuntime.valid ? "yes" : "no"}`, inner, theme.MUTED));
        lines.push(...wrapDialogLines(`credentials ${state.hasApiKey ? "present" : "absent"}`, inner, theme.MUTED));
        if (state.apiRuntime.error) {
          lines.push({ text: "" });
          for (const raw of String(state.apiRuntime.error).split("\n")) {
            if (raw.trim().length === 0) lines.push({ text: "" });
            else lines.push(...wrapDialogLines(raw, inner, theme.ERROR));
          }
        }
      }
    } else if (item.id === "check:cli") {
      lines.push({ text: "CLI RUNTIMES", fg: theme.PRIMARY });
      lines.push({ text: cliStatus, fg: statusTone(cliStatus) ?? theme.MUTED });
      lines.push({ text: "" });
      if (!state) {
        lines.push({ text: "not probed yet", fg: theme.MUTED });
      } else if (state.availableRuntimes.length === 0) {
        lines.push({ text: "none detected", fg: theme.WARNING });
      } else {
        for (const runtime of state.availableRuntimes) {
          lines.push(...wrapDialogLines(runtime, inner, theme.TEXT));
        }
      }
    } else {
      lines.push({ text: "NEXT STEPS", fg: theme.PRIMARY });
      lines.push(...wrapDialogLines(item.label, inner, item.id === "step:next" ? theme.TEXT : theme.MUTED));
      if (item.id !== "step:next") {
        lines.push({ text: "" });
        lines.push(...wrapDialogLines(nextStep, inner, theme.MUTED));
      }
    }
    if (error) {
      lines.push({ text: "" });
      lines.push(...wrapDialogLines(error, inner, theme.ERROR));
    }
    return <DialogDetailColumn lines={lines} pane={pane} />;
  };

  const apiErrorLine = state?.apiRuntime.error ? String(state.apiRuntime.error).split("\n")[0] : undefined;
  const doctorStatusText = error ?? apiErrorLine ?? nextStep;
  const doctorStatusTone = error || apiErrorLine ? theme.ERROR : state && !state.nodeOk ? theme.ERROR : theme.MUTED;

  return (
    <ShellFrame view="doctor" dialogContent>
      {palette.paletteOpen ? <PaletteOverlay title="Doctor commands" query={palette.paletteQuery} selected={palette.paletteSelected} commands={palette.filteredPalette} /> : null}
      <box flexDirection="column" width="100%" height="100%" minWidth={0}>
        <DialogTitleRow screenKey="doctor" width={width} meta={state ? `node ${nodeStatus} · api ${apiStatus} · cli ${cliStatus}` : "checking"} />
        <DialogSelectBody
          items={doctorItems}
          cursor={doctorCursor}
          panel={doctorPanel}
          query=""
          hideSearch
          renderDetail={renderDoctorDetail}
          emptyText="No diagnostics available."
        />
        <Cells width={width} fg={doctorStatusTone}>
          {doctorStatusText}
        </Cells>
        <FooterBar hint="↑↓ move · esc back · ctrl+p commands · ctrl+c exit" />
      </box>
    </ShellFrame>
  );
}
