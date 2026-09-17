/** @jsxImportSource @opentui/react */
/**
 * The guided first-run onboarding dialog.
 *
 * A GUIDED, one-decision-per-step first run: welcome → connect → models →
 * preferences → analytics → done. Each step explains itself and collects its
 * own answer inline; onboarding never hands the operator the whole Settings
 * catalogue.
 *
 * It is a pop-up rather than a full-screen route: the host wraps it in
 * `DialogSurface`, `useSurfaceDimensions` reports that panel's inner box, and
 * the body is a dialog card — an icon+title row that names the step, a step
 * rail showing where in the flow the operator is, and the step's own prose,
 * selector and preview. The footer of bindings is the HOST's single row, drawn
 * from the `hint` this card returns through `frame`, so it is not drawn twice.
 *
 * Two of the steps ARE genuine one-decision pickers already, so this screen
 * reuses them verbatim instead of reimplementing them: the `connect` step
 * embeds the existing `ConnectScreen` (advancing on its `onConnected`), and the
 * `models` step embeds the existing `ModelScreen` (advancing on its
 * `onSelect`). The host supplies each through `renderConnect`/`renderModels`,
 * so this file owns the step machine and the host owns the runtime wiring
 * (which credentials, which audit's staged model) exactly as its `ConnectRoute`
 * and `ModelRoute` already do. The `preferences` step is built from the SAME
 * pieces the Settings screen is made of — `SETTING_DEFS` for the definition,
 * `updateSetting` to persist, `SettingsPreview` for a live preview — over just
 * `theme` and `density`, so it stays a focused two-decision pass and NEVER
 * mounts the full `SettingsScreen`.
 *
 * COMPLETION IS WRITTEN IN EXACTLY ONE PLACE. `onboardingCompleted` is set only
 * by `finalizeOnboarding()`, called only from the `done` step's Enter. Every
 * other choice (connection, model, each preference) persists at the moment it
 * is made, independently of completion. So cancelling — Ctrl+C, Esc, or a
 * dialog dismiss — leaves the user's choices intact (already-persisted
 * connection/model/setting changes stay) and does NOT mark onboarding as done,
 * so the next session shows it again. `onboardingCompleted` is operator-owned
 * and refused at project scope by the store; the completion write below is
 * un-scoped, so it always lands in the global layer.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sleekScrollbar } from "./scrollbar.js";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { analyticsPipeline } from "@0sec/core";

import { Cells, textCells } from "./primitives.js";
import { updateSetting, useSettings } from "./settings-store.js";
import { SETTING_DEFS, type TuiSettings } from "./settings.js";
import { SettingsPreview, previewRowCount } from "./settings-preview.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import {
  DIALOG_HOST_FOOTER_ROWS,
  shellChromeRows,
  wrapCells,
} from "./settings-layout.js";
import { useTheme, type Theme } from "./theme-context.js";

// ---------------------------------------------------------------------------
// Steps — the state machine
// ---------------------------------------------------------------------------

export type OnboardingStep =
  | "welcome"
  | "connect"
  | "models"
  | "preferences"
  | "analytics"
  | "done";

/** Metadata for a single step. */
interface StepDef {
  key: OnboardingStep;
  label: string;
  skippable: boolean;
}

/**
 * The guided flow, in order. The rail draws one dot per entry; the machine
 * walks it linearly (`stepAfter`). Exported so a test can assert the order and
 * labels without rendering the dialog.
 */
export const ONBOARDING_STEPS: readonly StepDef[] = [
  { key: "welcome", label: "Welcome", skippable: false },
  { key: "connect", label: "Connect", skippable: true },
  { key: "models", label: "Models", skippable: true },
  { key: "preferences", label: "Preferences", skippable: true },
  { key: "analytics", label: "Analytics", skippable: true },
  { key: "done", label: "Done", skippable: false },
];

/** The step that linearly follows `step`, or `undefined` at the end. */
export function stepAfter(step: OnboardingStep): OnboardingStep | undefined {
  const idx = ONBOARDING_STEPS.findIndex((s) => s.key === step);
  return idx >= 0 ? ONBOARDING_STEPS[idx + 1]?.key : undefined;
}

/**
 * The setting keys the guided preferences step walks, in order. Deliberately
 * just the two most visible, lowest-risk Display cosmetics — never a Security
 * toggle, which belongs in the full Settings catalogue with its description.
 */
export const ONBOARDING_PREFERENCE_KEYS = ["theme", "density"] as const;
type PreferenceKey = (typeof ONBOARDING_PREFERENCE_KEYS)[number];

/**
 * THE ONLY place `onboardingCompleted` is written. Called solely from the
 * `done` step's Enter — never on skip, cancel, back, or a preference set — so
 * cancelling always leaves onboarding incomplete. The write is un-scoped, so
 * the store lands it in the global layer (it is operator-owned and refused at
 * project scope).
 */
export function finalizeOnboarding(): void {
  updateSetting("onboardingCompleted", true);
}

/** The four consent tiers, matching the `analyticsLevel` setting's choices. */
export type AnalyticsLevel = TuiSettings["analyticsLevel"];

/** Save the sharing tier without broadening a separate problem-report choice. */
export function recordAnalyticsConsent(level: AnalyticsLevel): void {
  updateSetting("analyticsLevel", level);
  if (level === "off") updateSetting("diagnosticReporting", "off");
}


// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OnboardingFrameInput {
  body: React.ReactNode;
  hint: string;
}

/**
 * How an embedded sub-step (connect/models) reports back to the machine. The
 * host wires the real screen's callbacks to these: a made decision → `onDone`
 * (advance), an explicit skip → `onSkip` (advance without a choice), leaving
 * the console → `onCancel`.
 */
export interface OnboardingSubNav {
  /** The sub-step's decision was made (and already persisted/staged by the host). */
  onDone: () => void;
  /** Skip this step, keeping defaults, and advance. */
  onSkip: () => void;
  /** Leave onboarding entirely, without completing it. */
  onCancel: () => void;
}

export interface OnboardingScreenProps {
  /** Wraps a prose/preferences card body in the console shell. */
  frame: (input: OnboardingFrameInput) => React.ReactNode;
  /**
   * Render the embedded `ConnectScreen` for the connect step. The host owns the
   * credential wiring (its `ConnectRoute` shape) and drives `nav` from the
   * screen's `onConnected`/`onBack`/`onExit`.
   */
  renderConnect: (nav: OnboardingSubNav) => React.ReactNode;
  /**
   * Render the embedded `ModelScreen` for the models step. The host owns the
   * staging wiring (its `ModelRoute` shape) and drives `nav` from the screen's
   * `onSelect`/`onBack`/`onExit`.
   */
  renderModels: (nav: OnboardingSubNav) => React.ReactNode;
  /** Mark onboarding completed and transition to the chat screen. */
  onComplete: () => void;
  /** Leave onboarding without marking it done. Does NOT undo any choices. */
  onCancel: () => void;
  interactive: boolean;
}

// ---------------------------------------------------------------------------
// Step copy (welcome / done prose)
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
    ...paragraph("Welcome to 0security", "title", width),
    BLANK,
    ...paragraph(
      "This console is your command center for self-improving, open-source security workflows.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph(
      "A few quick steps set you up: connect a provider, pick a model, and choose a couple of display preferences. One decision at a time.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph("Enter → begin", "accent", width),
    ...paragraph("Esc → skip onboarding for now", "muted", width),
  ];
}

function doneLines(width: number): StepLine[] {
  return [
    ...paragraph("You're all set", "title", width),
    BLANK,
    ...paragraph(
      "Start an audit when you're ready. Revisit your connection, model, and every display setting anytime with /settings from the chat view.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph("Enter → start working", "accent", width),
  ];
}

const STEP_LINES: Partial<Record<OnboardingStep, (width: number) => StepLine[]>> = {
  welcome: welcomeLines,
  done: doneLines,
};

const STEP_HINT: Record<OnboardingStep, string> = {
  welcome: "[⏎] begin · [esc] skip onboarding",
  connect: "connect or [esc] to skip · [⌃C] cancel",
  models: "select a model or [esc] to skip · [⌃C] cancel",
  preferences: "[←→] change · [⏎] confirm · [s] skip · [esc] cancel",
  analytics: "[↑↓] choose · [PgUp/PgDn] read · [⏎] confirm · [s] skip · [esc] cancel",
  done: "[⏎] start working · [esc] review later",
};

// ---------------------------------------------------------------------------
// Analytics consent step
// ---------------------------------------------------------------------------

/** Every tier remains selectable; skipping preserves the current preference. */
const ANALYTICS_OPTIONS = [
  {
    level: "usage",
    label: "Usage metrics only",
    detail:
      "Feature counters and error categories. No tool content, code, scope or findings.",
  },
  {
    level: "commands",
    label: "Tool content and code",
    detail:
      "Also tool arguments/results and submitted code for training, with recognized credentials scrubbed.",
  },
  {
    level: "full",
    label: "Full training data (new-install default)",
    detail:
      "Usage, tool arguments/results, submitted code, scope and findings; recognized credentials scrubbed.",
  },
  {
    level: "off",
    label: "Off",
    detail: "No analytics or training uploads. Also turns automatic problem reports off.",
  },
] as const satisfies readonly { level: AnalyticsLevel; label: string; detail: string }[];

/** Disclose the default, actual data categories, and independent restrictions. */
function analyticsLines(width: number): StepLine[] {
  return [
    ...paragraph("Analytics and training data", "title", width),
    BLANK,
    ...paragraph(
      "Full sharing is on by default for new installs. Usage metrics are separate from training data: tool arguments/results, submitted code, scope and findings for model improvement and security research. Recognized credentials are scrubbed; emails, URLs, identifiers and other content are retained. This is not anonymous. Sending requires Cloud sign-in.",
      "text",
      width,
    ),
    BLANK,
    ...paragraph(
      `Active in this process: ${analyticsPipeline.getLevel()}. Saved choices and environment restrictions are preserved. 0SEC_ANALYTICS_LEVEL, 0SEC_OFFLINE, 0SEC_NO_TELEMETRY and DO_NOT_TRACK can restrict collection. Skip keeps the current setting; change it anytime in /settings.`,
      "muted",
      width,
    ),
  ];
}

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

/** Upper bound on the card's width: past this a wizard reads better centered
 *  with generous side gutters than stretched edge-to-edge, exactly the way the
 *  overlay caps and centers its own body. */
const CARD_MAX_WIDTH = 72;

/**
 * A centered progress row: a dot per step — filled for the steps reached,
 * hollow for the ones ahead — followed by a muted "Step X of N · Label"
 * counter. Everything is budgeted before it is painted; pieces drop (counter
 * first, then the whole row) rather than being squeezed when the surface cannot
 * pay for them, and the group is centered within `width`.
 */
function StepRail({ current, width, theme }: { current: number; width: number; theme: Theme }) {
  const total = ONBOARDING_STEPS.length;
  const done = Math.max(0, Math.min(current, total - 1)) + 1;
  const filled = Array.from({ length: done }, () => FILLED).join(" ");
  const rest = Array.from({ length: Math.max(0, total - done) }, () => HOLLOW).join(" ");
  const filledWidth = textCells(filled);
  const restWidth = textCells(rest);
  const gap = restWidth > 0 ? 1 : 0;
  const dots = filledWidth + gap + restWidth;
  if (width < dots) return null;

  const label = ONBOARDING_STEPS[current]?.label ?? "";
  const counter = `Step ${current + 1} of ${total}${label ? ` · ${label}` : ""}`;
  const sep = 2; // "  " between the dots and the counter
  const counterWidth = width >= dots + sep + counter.length ? counter.length : 0;

  return (
    <box flexDirection="row" width={width} justifyContent="center" flexShrink={0} minWidth={0}>
      <Cells width={filledWidth} fg={theme.ACCENT}>{filled}</Cells>
      {gap > 0 ? <Cells width={gap}>{""}</Cells> : null}
      {restWidth > 0 ? <Cells width={restWidth} fg={theme.MUTED}>{rest}</Cells> : null}
      {counterWidth > 0 ? (
        <>
          <Cells width={sep}>{""}</Cells>
          <Cells width={counterWidth} fg={theme.MUTED}>{counter}</Cells>
        </>
      ) : null}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OnboardingScreen({
  frame,
  renderConnect,
  renderModels,
  onComplete,
  onCancel,
  interactive,
}: OnboardingScreenProps) {
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const theme = useTheme();
  const settings = useSettings();

  // Inside a dialog the surface IS the panel's inner box — no header, no
  // padding — and the only row the host still spends is its single footer,
  // drawn from the `hint` this card returns. Outside a dialog the legacy shell
  // chrome applies.
  const contentWidth = Math.max(1, width - (inDialog ? 0 : 4));
  const availableRows = Math.max(
    0,
    height - (inDialog ? DIALOG_HOST_FOOTER_ROWS : shellChromeRows(width)),
  );
  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = ONBOARDING_STEPS[stepIndex]?.key ?? "done";

  const advanceTo = useCallback((next: OnboardingStep) => {
    const idx = ONBOARDING_STEPS.findIndex((s) => s.key === next);
    if (idx >= 0) setStepIndex(idx);
  }, []);

  const advancePastCurrent = useCallback(() => {
    const next = stepAfter(currentStep);
    if (next) advanceTo(next);
  }, [currentStep, advanceTo]);

  // Preferences step: which key we are on, and which of its choices is
  // highlighted. Nothing is persisted while cycling — only Enter writes — so a
  // skip or cancel leaves the on-disk value untouched.
  const [prefIndex, setPrefIndex] = useState(0);
  const prefKey: PreferenceKey | undefined = ONBOARDING_PREFERENCE_KEYS[prefIndex];
  const prefDef = useMemo(
    () => SETTING_DEFS.find((d) => d.key === prefKey),
    [prefKey],
  );
  const prefChoices = prefDef?.choices ?? [];
  const [choiceIndex, setChoiceIndex] = useState(0);

  // When we arrive at a preference (or open the step), start the highlight on
  // the value currently in effect, so Enter-through-defaults is a no-op change.
  useEffect(() => {
    if (currentStep !== "preferences" || !prefKey) return;
    const current = settings[prefKey] as string;
    const idx = prefChoices.indexOf(current);
    setChoiceIndex(idx >= 0 ? idx : 0);
    // Only re-seed when the target key changes or the step opens; not on every
    // settings notification (that would fight the operator's cycling).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, prefKey]);

  const handleEnter = useCallback(() => {
    if (currentStep === "welcome") {
      advanceTo("connect");
    } else if (currentStep === "done") {
      finalizeOnboarding();
      onComplete();
    }
  }, [currentStep, advanceTo, onComplete]);

  const commitPreference = useCallback(() => {
    if (prefKey) {
      const value = prefChoices[choiceIndex];
      if (value !== undefined) {
        // Persist immediately, exactly as the Settings screen does. This is
        // independent of completion, so a later cancel keeps it.
        updateSetting(prefKey, value as TuiSettings[PreferenceKey]);
      }
    }
    const next = prefIndex + 1;
    if (next < ONBOARDING_PREFERENCE_KEYS.length) {
      setPrefIndex(next);
    } else {
      advanceTo("analytics");
    }
  }, [prefKey, prefChoices, choiceIndex, prefIndex, advanceTo]);

  const cycleChoice = useCallback((delta: number) => {
    const n = prefChoices.length;
    if (n === 0) return;
    setChoiceIndex((i) => ((i + delta) % n + n) % n);
  }, [prefChoices.length]);

  // Analytics consent: which tier is highlighted. Seeded from the current
  // stored setting (full on a fresh install). Moving or skipping writes nothing.
  const [analyticsIndex, setAnalyticsIndex] = useState(() => {
    const idx = ANALYTICS_OPTIONS.findIndex((o) => o.level === settings.analyticsLevel);
    return idx >= 0 ? idx : 2; // index 2 = "full"
  });
  useEffect(() => {
    if (currentStep === "analytics") {
      setAnalyticsIndex(ANALYTICS_OPTIONS.findIndex((option) => option.level === settings.analyticsLevel));
    }
  }, [currentStep, settings.analyticsLevel]);

  const cycleAnalytics = useCallback((delta: number) => {
    const n = ANALYTICS_OPTIONS.length;
    setAnalyticsIndex((i) => ((i + delta) % n + n) % n);
  }, []);

  const commitAnalytics = useCallback(() => {
    const level = ANALYTICS_OPTIONS[analyticsIndex]?.level ?? "off";
    recordAnalyticsConsent(level);
    advanceTo("done");
  }, [analyticsIndex, advanceTo]);

  const skipAnalytics = useCallback(() => {
    advanceTo("done");
  }, [advanceTo]);

  useKeyboard((key) => {
    if (!interactive) return;
    // During an embedded sub-step, the mounted ConnectScreen/ModelScreen owns
    // every key. Handling them here too would double-fire.
    if (currentStep === "connect" || currentStep === "models") return;

    if (key.ctrl && key.name === "c") { onCancel(); return; }
    if (key.name === "escape") { onCancel(); return; }

    if (currentStep === "preferences") {
      if (key.name === "left" || key.name === "h") cycleChoice(-1);
      else if (key.name === "right" || key.name === "l") cycleChoice(1);
      else if (key.name === "return" && !key.shift) commitPreference();
      else if (key.name === "s") advanceTo("analytics");
      return;
    }

    if (currentStep === "analytics") {
      if (key.name === "up" || key.name === "k" || key.name === "left" || key.name === "h") cycleAnalytics(-1);
      else if (key.name === "down" || key.name === "j" || key.name === "right" || key.name === "l") cycleAnalytics(1);
      else if (key.name === "return" && !key.shift) commitAnalytics();
      else if (key.name === "s") skipAnalytics();
      return;
    }

    // welcome / done
    if (key.name === "return" && !key.shift) handleEnter();
  });

  // The nav an embedded sub-step reports through: a decision or a skip both
  // move the machine forward; cancel leaves onboarding.
  const subNav: OnboardingSubNav = useMemo(() => ({
    onDone: advancePastCurrent,
    onSkip: advancePastCurrent,
    onCancel,
  }), [advancePastCurrent, onCancel]);

  // Embedded pickers render themselves (they carry their own frame + footer);
  // only build the node when interactive so a hidden onboarding never mounts a
  // second keyboard.
  if (currentStep === "connect") {
    return interactive ? (renderConnect(subNav) as React.ReactElement) : null;
  }
  if (currentStep === "models") {
    return interactive ? (renderModels(subNav) as React.ReactElement) : null;
  }

  const hint = STEP_HINT[currentStep] ?? "[esc] to dismiss";

  // Cap the card and center it on a wide surface, the way the overlay does, so
  // no line runs edge-to-edge. Fully responsive: on a narrow (~60 col) dialog
  // the cap simply IS the whole width and the gutters vanish.
  const cardWidth = Math.min(contentWidth, CARD_MAX_WIDTH);
  const cardTextWidth = Math.max(1, cardWidth - 1);
  const sideGutter = Math.max(0, Math.floor((contentWidth - cardWidth) / 2));

  // Row budget: the title, the rail and the gap under them all give way before
  // the step's own content.
  const titleRows = availableRows >= 3 ? 1 : 0;
  const railRows = availableRows >= 7 ? 1 : 0;
  const headerRows = titleRows + railRows;
  const gapRow = headerRows > 0 && availableRows >= 9 ? 1 : 0;
  const bodyRows = Math.max(0, availableRows - headerRows - gapRow);

  const titleText = `${operatorIcon("onboarding")} ${operatorTitle("onboarding")}`;

  const chrome = (content: React.ReactNode) => (
    <box flexDirection="row" width={contentWidth} flexGrow={1} minWidth={0} overflow="hidden">
      {sideGutter > 0 ? <box width={sideGutter} flexShrink={0} /> : null}
      <box flexDirection="column" width={cardWidth} flexGrow={1} minWidth={0} overflow="hidden">
        {titleRows > 0 ? (
          <Cells width={cardWidth} align="center" fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
            {titleText}
          </Cells>
        ) : null}
        {railRows > 0 ? <StepRail current={stepIndex} width={cardWidth} theme={theme} /> : null}
        {gapRow > 0 ? <Cells width={cardWidth}>{""}</Cells> : null}
        {bodyRows > 0 ? content : null}
      </box>
      {sideGutter > 0 ? <box width={sideGutter} flexShrink={0} /> : null}
    </box>
  );

  let body: React.ReactNode;
  if (currentStep === "analytics") {
    body = <AnalyticsCard
      lines={analyticsLines(cardTextWidth)}
      choiceIndex={analyticsIndex}
      theme={theme}
      contentWidth={cardWidth}
      textWidth={cardTextWidth}
      bodyRows={bodyRows}
    />;
  } else if (currentStep === "preferences" && prefDef) {
    body = renderPreferences({
      def: prefDef,
      choices: prefChoices,
      choiceIndex,
      value: prefChoices[choiceIndex],
      settings,
      theme,
      contentWidth: cardWidth,
      textWidth: cardTextWidth,
      bodyRows,
    });
  } else {
    const render = STEP_LINES[currentStep];
    const lines = render ? render(cardTextWidth) : [];
    body = renderProse({ lines, theme, currentStep, contentWidth: cardWidth, textWidth: cardTextWidth, bodyRows });
  }

  return interactive ? (frame({ body: chrome(body), hint }) as React.ReactElement) : null;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function renderProse({
  lines,
  theme,
  currentStep,
  contentWidth,
  textWidth,
  bodyRows,
}: {
  lines: StepLine[];
  theme: Theme;
  currentStep: OnboardingStep;
  contentWidth: number;
  textWidth: number;
  bodyRows: number;
}) {
  const rows = lines.map((line, index) => (
    <Cells key={`step-${index}`} width={textWidth} align="center" fg={toneColor(line.tone, theme)}
      attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}>
      {line.text}
    </Cells>
  ));

  // When the prose fits, center it vertically for a polished hero look; only
  // when it overflows does it fall back to a top-anchored scrollbox.
  if (lines.length <= bodyRows) {
    return (
      <box
        flexDirection="column"
        width={contentWidth}
        height={bodyRows}
        justifyContent="center"
        alignItems="center"
        flexShrink={0}
        minWidth={0}
        overflow="hidden"
      >
        {rows}
      </box>
    );
  }

  return (
    <scrollbox
      key={currentStep}
      width={contentWidth}
      height={bodyRows}
      flexShrink={0}
      scrollX={false}
      verticalScrollbarOptions={sleekScrollbar(theme)}
    >
      <box flexDirection="column" width={textWidth} flexShrink={0} minWidth={0}>
        {rows}
      </box>
    </scrollbox>
  );
}

/**
 * The inline one-decision preference picker. Built entirely from the pieces the
 * Settings screen is made of — the `SETTING_DEFS` entry (`def`) for the label,
 * description and choices, and `SettingsPreview` for a live preview of the
 * highlighted value — with a simple left/right cycle over `def.choices`. It
 * writes nothing itself; the component's Enter handler calls `updateSetting`.
 */
function renderPreferences({
  def,
  choices,
  choiceIndex,
  value,
  settings,
  theme,
  contentWidth,
  textWidth,
  bodyRows,
}: {
  def: (typeof SETTING_DEFS)[number];
  choices: readonly string[];
  choiceIndex: number;
  value: string | undefined;
  settings: TuiSettings;
  theme: Theme;
  contentWidth: number;
  textWidth: number;
  bodyRows: number;
}) {
  const descLines = wrapCells(def.description, textWidth);
  const selectorLine = `‹ ${value ?? "—"} ›`;
  const counter = `${choiceIndex + 1} of ${choices.length}`;

  // Header (label) + description + selector row consume the top of the body;
  // whatever remains under a small floor goes to the live preview.
  const headerRows = 1 + descLines.length + 2; // label, desc, blank, selector
  const previewBudget = Math.max(0, bodyRows - headerRows - 1);
  const previewRows = previewBudget > 0
    ? Math.min(previewBudget, previewRowCount({ def, value, width: contentWidth, settings }))
    : 0;

  return (
    <box flexDirection="column" width={contentWidth} height={bodyRows} flexShrink={0} minWidth={0} overflow="hidden">
      <Cells width={textWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>{def.label}</Cells>
      {descLines.map((line, index) => (
        <Cells key={`desc-${index}`} width={textWidth} fg={theme.TEXT}>{line}</Cells>
      ))}
      <Cells width={textWidth}>{""}</Cells>
      <box flexDirection="row" width={textWidth} flexShrink={0} minWidth={0}>
        <Cells width={Math.max(1, textWidth - counter.length - 1)} fg={theme.ACCENT} attributes={TextAttributes.BOLD}>
          {selectorLine}
        </Cells>
        <Cells width={counter.length} align="right" fg={theme.MUTED}>{counter}</Cells>
      </box>
      {previewRows > 0 ? (
        <SettingsPreview
          def={def}
          value={value}
          width={contentWidth}
          settings={settings}
          rowBudget={previewRows}
          theme={theme}
        />
      ) : null}
    </box>
  );
}

/** Keep the tier choices reachable alongside the training-data disclosure. */
function AnalyticsCard({
  lines,
  choiceIndex,
  theme,
  contentWidth,
  textWidth,
  bodyRows,
}: {
  lines: StepLine[];
  choiceIndex: number;
  theme: Theme;
  contentWidth: number;
  textWidth: number;
  bodyRows: number;
}) {
  const rows: React.ReactNode[] = [];
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  let selectedRow = 0;

  lines.forEach((line, index) => {
    rows.push(
      <Cells key={`analytics-intro-${index}`} width={textWidth} align="center" fg={toneColor(line.tone, theme)}
        attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}>
        {line.text}
      </Cells>,
    );
  });
  rows.push(<Cells key="analytics-gap" width={textWidth}>{""}</Cells>);

  const detailWidth = Math.max(1, textWidth - 2);
  ANALYTICS_OPTIONS.forEach((option, index) => {
    const active = index === choiceIndex;
    if (active) selectedRow = rows.length;
    rows.push(
      <Cells
        key={`analytics-opt-${index}`}
        width={textWidth}
        fg={active ? theme.ACCENT : theme.TEXT}
        attributes={active ? TextAttributes.BOLD : undefined}
      >
        {`${active ? FILLED : HOLLOW} ${option.label}`}
      </Cells>,
    );
    if (active) {
      wrapCells(option.detail, detailWidth).forEach((detailLine, di) => {
        rows.push(
          <Cells key={`analytics-detail-${index}-${di}`} width={textWidth} fg={theme.MUTED}>
            {`  ${detailLine}`}
          </Cells>,
        );
      });
    }
  });

  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    viewport.scrollTo(Math.min(selectedRow, Math.max(0, rows.length - bodyRows)));
  }, [choiceIndex, selectedRow, rows.length, bodyRows]);
  useKeyboard((key) => {
    if (key.name === "pageup") scroll.current?.scrollBy(-1, "viewport");
    if (key.name === "pagedown") scroll.current?.scrollBy(1, "viewport");
  });

  if (rows.length > bodyRows) {
    return (
      <scrollbox ref={scroll} width={contentWidth} height={bodyRows} flexShrink={0}
        scrollX={false} verticalScrollbarOptions={sleekScrollbar(theme)}>
        <box flexDirection="column" width={textWidth} flexShrink={0}>{rows}</box>
      </scrollbox>
    );
  }
  return (
    <box
      flexDirection="column"
      width={contentWidth}
      height={bodyRows}
      justifyContent={rows.length <= bodyRows ? "center" : "flex-start"}
      flexShrink={0}
      minWidth={0}
      overflow="hidden"
    >
      {rows}
    </box>
  );
}
