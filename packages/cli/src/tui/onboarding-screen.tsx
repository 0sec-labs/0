/** @jsxImportSource @opentui/react */
/**
 * The guided first-run onboarding dialog.
 *
 * Walks through the essential setup steps — connect a provider, pick models,
 * review display settings — then marks onboarding as complete so subsequent
 * sessions skip this screen entirely.
 *
 * It is a pop-up now rather than a full-screen route: the host wraps it in
 * `DialogSurface`, `useSurfaceDimensions` reports that panel's inner box, and
 * the body is a dialog card — an icon+title row that names the step, a step
 * rail showing where in the flow the operator is, and the step's own prose
 * and actions. The footer of bindings is the HOST's single row, drawn from
 * the `hint` this card returns through `frame`, so it is not drawn twice.
 * Every line is wrapped to the surface and the words scroll inside the rows
 * the card was given, because OpenTUI paints an overflow through its
 * neighbours and a cut-off step would hide an action.
 *
 * The step machine itself is unchanged. Each step is self-contained in this
 * file and navigates to the relevant existing screen via `onNavigate`.
 * Cancelling leaves the user's choices intact (already-persisted
 * connection/model/setting changes stay) and does NOT mark onboarding as done,
 * so the next session will show it again.
 */

import React, { useCallback, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";

import { Cells, textCells } from "./primitives.js";
import { updateSetting } from "./settings-store.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import {
  DIALOG_HOST_FOOTER_ROWS,
  shellChromeRows,
  titleColumns,
  wrapCells,
} from "./settings-layout.js";
import { useTheme, type Theme } from "./theme-context.js";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type OnboardingStep =
  | "welcome"
  | "connect"
  | "models"
  | "settings"
  | "done";

export interface OnboardingFrameInput {
  body: React.ReactNode;
  hint: string;
}

export interface OnboardingScreenProps {
  /**
   * Wraps the body in the console shell.
   */
  frame: (input: OnboardingFrameInput) => React.ReactNode;
  /**
   * Navigate to another screen that still exists as its own route.
   * The onboarding screen does not leave — it waits for the user to return
   * before advancing to the next step.
   */
  onNavigate: (screen: "connect" | "models" | "settings") => void;
  /** Mark onboarding completed and transition to the chat screen. */
  onComplete: () => void;
  /** Leave onboarding without marking it done. Does NOT undo any choices. */
  onCancel: () => void;
  interactive: boolean;
}

/** Metadata for a single step. */
interface StepDef {
  key: OnboardingStep;
  label: string;
  skippable: boolean;
}

const STEPS: readonly StepDef[] = [
  { key: "welcome", label: "Welcome", skippable: false },
  { key: "connect", label: "Connect", skippable: true },
  { key: "models", label: "Models", skippable: true },
  { key: "settings", label: "Settings", skippable: true },
  { key: "done", label: "Done", skippable: false },
];

/** The step index that follows each navigated-to screen. */
const NEXT_STEP: Record<string, OnboardingStep> = {
  connect: "models",
  models: "settings",
  settings: "done",
};

// ---------------------------------------------------------------------------
// Step copy
// ---------------------------------------------------------------------------

type LineTone = "title" | "text" | "muted" | "accent";

interface StepLine {
  readonly text: string;
  readonly tone: LineTone;
}

/** A paragraph, wrapped to the card width rather than hard-broken by hand. */
function paragraph(text: string, tone: LineTone, width: number): StepLine[] {
  return wrapCells(text, width).map((line) => ({ text: line, tone }));
}

const BLANK: StepLine = { text: "", tone: "muted" };

function welcomeLines(width: number): StepLine[] {
  return [
    ...paragraph("Welcome to 0sec", "title", width),
    BLANK,
    ...paragraph(
      "This console is your workspace for security assessments, audits, and red-team operations with AI agents.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph("Let's get you set up in a few quick steps.", "text", width),
    BLANK,
    ...paragraph("Enter → begin", "accent", width),
    ...paragraph("Esc → skip onboarding for now", "muted", width),
  ];
}

function connectLines(width: number): StepLine[] {
  return [
    ...paragraph("Connect a model provider", "title", width),
    BLANK,
    ...paragraph(
      "Sign in to 0sec Cloud, or use your own API key or supported provider subscription. Model access depends on the connection you choose.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph("Enter → choose a connection", "accent", width),
    ...paragraph("s → skip, I'll connect later", "muted", width),
  ];
}

function modelsLines(width: number): StepLine[] {
  return [
    ...paragraph("Configure models", "title", width),
    BLANK,
    ...paragraph(
      "Choose which AI model drives your sessions. You can select from built-in providers or bring your own API key.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph("Enter → configure models now", "accent", width),
    ...paragraph("s → skip, keep defaults", "muted", width),
  ];
}

function settingsLines(width: number): StepLine[] {
  return [
    ...paragraph("Review display settings", "title", width),
    BLANK,
    ...paragraph(
      "Tweak the console appearance and layout: themes, transcript style, sidebars, and how the composer behaves when the model is busy.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph("Enter → open settings now", "accent", width),
    ...paragraph("s → skip, keep defaults", "muted", width),
  ];
}

function doneLines(width: number): StepLine[] {
  return [
    ...paragraph("Walkthrough complete", "title", width),
    BLANK,
    ...paragraph(
      "Start an audit when you're ready. Revisit your choices anytime with /settings from the chat view.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph("Enter → start working", "accent", width),
  ];
}

const STEP_LINES: Record<OnboardingStep, (width: number) => StepLine[]> = {
  welcome: welcomeLines,
  connect: connectLines,
  models: modelsLines,
  settings: settingsLines,
  done: doneLines,
};

const STEP_HINT: Record<OnboardingStep, string> = {
  welcome: "enter continue · esc skip onboarding",
  connect: "enter to connect · s to skip",
  models: "enter to configure · s to skip",
  settings: "enter to review · s to skip",
  done: "enter to start working · esc to review later",
};

function toneColor(tone: LineTone, theme: Theme): string {
  switch (tone) {
    case "title":
      return theme.PRIMARY;
    case "accent":
      return theme.ACCENT;
    case "muted":
      return theme.MUTED;
    default:
      return theme.TEXT;
  }
}

// ---------------------------------------------------------------------------
// Step rail
// ---------------------------------------------------------------------------

const FILLED = "●";
const HOLLOW = "○";

/**
 * A dot per step — filled for the steps reached, hollow for the ones ahead —
 * followed by the current step's name.
 *
 * Both columns are budgeted before anything is painted, and the whole row is
 * dropped rather than squeezed when the surface cannot pay for it: a rail that
 * overflows would paint through the card beside it.
 */
function StepRail({ current, width, theme }: { current: number; width: number; theme: Theme }) {
  const total = STEPS.length;
  const done = Math.max(0, Math.min(current, total - 1)) + 1;
  const filled = Array.from({ length: done }, () => FILLED).join(" ");
  const rest = Array.from({ length: Math.max(0, total - done) }, () => HOLLOW).join(" ");
  const filledWidth = textCells(filled);
  const restWidth = textCells(rest);
  const gap = restWidth > 0 ? 1 : 0;
  const label = STEPS[current]?.label ?? "";
  const dots = filledWidth + gap + restWidth;
  if (width < dots) return null;
  const labelGap = width > dots && label.length > 0 ? 1 : 0;
  const labelWidth = Math.max(0, width - dots - labelGap);
  return (
    <box flexDirection="row" width={width} flexShrink={0} minWidth={0}>
      <Cells width={filledWidth} fg={theme.ACCENT}>{filled}</Cells>
      {gap > 0 ? <Cells width={gap}>{""}</Cells> : null}
      {restWidth > 0 ? <Cells width={restWidth} fg={theme.MUTED}>{rest}</Cells> : null}
      {labelGap > 0 ? <Cells width={labelGap}>{""}</Cells> : null}
      {labelWidth > 0 ? <Cells width={labelWidth} fg={theme.MUTED}>{label}</Cells> : null}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OnboardingScreen({
  frame,
  onNavigate,
  onComplete,
  onCancel,
  interactive,
}: OnboardingScreenProps) {
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const theme = useTheme();
  // Inside a dialog the surface IS the panel's inner box — the shell renders
  // with `dialogContent`, so it has no header and no padding — and the only
  // row the host still spends is its single footer, drawn from the `hint`
  // this card returns. Outside a dialog the legacy shell chrome applies.
  const contentWidth = Math.max(1, width - (inDialog ? 0 : 4));
  const availableRows = Math.max(
    0,
    height - (inDialog ? DIALOG_HOST_FOOTER_ROWS : shellChromeRows(width)),
  );
  // The step's words scroll rather than being cut off, so a short panel never
  // hides an action. A scrollbox shows its bar in the last column.
  const textWidth = Math.max(1, contentWidth - 1);

  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = STEPS[stepIndex]?.key ?? "done";

  const advanceTo = useCallback((next: OnboardingStep) => {
    const idx = STEPS.findIndex((s) => s.key === next);
    if (idx >= 0) setStepIndex(idx);
  }, []);

  const handleEnter = useCallback(() => {
    const step = currentStep;
    if (step === "welcome") {
      advanceTo("connect");
    } else if (step === "done") {
      updateSetting("onboardingCompleted", true);
      onComplete();
    } else {
      const next = NEXT_STEP[step];
      onNavigate(step);
      if (next) advanceTo(next);
    }
  }, [currentStep, advanceTo, onNavigate, onComplete]);

  const handleSkip = useCallback(() => {
    const def = STEPS[stepIndex];
    if (!def || !def.skippable) return;
    const next = NEXT_STEP[def.key];
    if (next) advanceTo(next);
  }, [stepIndex, advanceTo]);

  useKeyboard((key) => {
    if (!interactive) return;
    if (key.ctrl && key.name === "c") onCancel();
    else if (key.name === "return" && !key.shift) handleEnter();
    else if (key.name === "s") handleSkip();
    else if (key.name === "escape") onCancel();
  });

  const hint = STEP_HINT[currentStep] ?? "esc to dismiss";

  // Row budget: the title and the rail give way before the step's own words.
  // There is no hint row here — the host draws exactly one footer from the
  // `hint` this card returns, and a second would duplicate it.
  const titleRows = availableRows >= 3 ? 1 : 0;
  const railRows = availableRows >= 7 ? 1 : 0;
  const bodyRows = Math.max(0, availableRows - titleRows - railRows);

  const lines = useMemo(() => {
    const render = STEP_LINES[currentStep];
    return render ? render(textWidth) : [];
  }, [currentStep, textWidth]);

  const titleText = `${operatorIcon("onboarding")} ${operatorTitle("onboarding")}`;
  const titleMeta = `Step ${stepIndex + 1} of ${STEPS.length}`;
  const title = titleColumns(contentWidth, titleMeta.length);

  const body = (
    <box flexDirection="column" width={contentWidth} flexGrow={1} minWidth={0} overflow="hidden">
      {titleRows > 0 ? (
        <box flexDirection="row" width={title.width} flexShrink={0} minWidth={0}>
          <Cells width={title.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
            {titleText}
          </Cells>
          {title.metaWidth > 0 ? (
            <>
              <Cells width={title.gap}>{""}</Cells>
              <Cells width={title.metaWidth} align="right" fg={theme.MUTED}>
                {titleMeta}
              </Cells>
            </>
          ) : null}
        </box>
      ) : null}
      {railRows > 0 ? <StepRail current={stepIndex} width={contentWidth} theme={theme} /> : null}
      {bodyRows > 0 ? (
        <scrollbox
          key={currentStep}
          width={contentWidth}
          height={bodyRows}
          flexShrink={0}
          scrollX={false}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.PANEL,
              foregroundColor: theme.MUTED,
            },
            arrowOptions: {
              foregroundColor: theme.MUTED,
              backgroundColor: theme.PANEL,
            },
          }}
        >
          <box flexDirection="column" width={textWidth} flexShrink={0} minWidth={0}>
            {lines.map((line, index) => (
              <Cells key={`step-${index}`} width={textWidth} fg={toneColor(line.tone, theme)}
                attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}>
                {line.text}
              </Cells>
            ))}
          </box>
        </scrollbox>
      ) : null}
    </box>
  );

  return interactive ? frame({ body, hint }) as React.ReactElement : null;
}
