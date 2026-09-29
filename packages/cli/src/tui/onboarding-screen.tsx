/** @jsxImportSource @opentui/react */
/**
 * Optional /onboard setup. Reuses the provider/model pickers and the settings
 * store; highlighted choices do not persist until confirmed. Back and Skip
 * retain saved choices. Only Finish marks setup complete.
 * The Plugins step is informational: it never installs or activates code.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sleekScrollbar } from "./scrollbar.js";
import { AppContext, useKeyboard } from "@opentui/react";
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core";
import { analyticsPipeline, getScopeEnforcementState } from "@0/core";

import { Cells, textCells } from "./primitives.js";
import { previewSetting, reloadSettings, updateSetting, useSettings } from "./settings-store.js";
import { SETTING_DEFS, type TuiSettings } from "./settings.js";
import { SettingsPreview } from "./settings-preview.js";
import { SurfaceContext, useSurfaceDimensions } from "./dialog-surface.js";
import { DialogActionButton } from "./dialog-screen-chrome.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import { computeDialogPanel } from "./dialog-select-layout.js";
import { Popup } from "./popup.js";
import { wrapCells } from "./settings-layout.js";
import { useTheme, type Theme } from "./theme-context.js";
import { Masthead } from "./chat/Masthead.js";
import { TERMINAL_BLOCK_LOGO, TERMINAL_BLOCK_LOGO_WIDTH } from "./chat/logo.js";
import { finalLogoFrame } from "./logo-animation.js";

const ONBOARDING_LOGO_FRAME = finalLogoFrame(TERMINAL_BLOCK_LOGO);

// ---------------------------------------------------------------------------
// Steps — the state machine
// ---------------------------------------------------------------------------

export type OnboardingStep =
  | "welcome"
  | "connect"
  | "models"
  | "preferences"
  | "analytics"
  | "plugins"
  | "done";

/** Metadata for a single step. */
interface StepDef {
  key: OnboardingStep;
  label: string;
  skippable: boolean;
}

/**
 * The guided flow, in order. Each window header names its current decision.
 */
export const ONBOARDING_STEPS: readonly StepDef[] = [
  { key: "welcome", label: "Welcome", skippable: false },
  { key: "connect", label: "Provider", skippable: true },
  { key: "models", label: "Model", skippable: true },
  { key: "preferences", label: "Display", skippable: true },
  { key: "analytics", label: "Data sharing", skippable: true },
  { key: "plugins", label: "Plugins", skippable: true },
  { key: "done", label: "Done", skippable: false },
];

/** The step that linearly follows `step`, or `undefined` at the end. */
export function stepAfter(step: OnboardingStep): OnboardingStep | undefined {
  const idx = ONBOARDING_STEPS.findIndex((s) => s.key === step);
  return idx >= 0 ? ONBOARDING_STEPS[idx + 1]?.key : undefined;
}

export function stepBefore(step: OnboardingStep): OnboardingStep | undefined {
  const idx = ONBOARDING_STEPS.findIndex((s) => s.key === step);
  return idx > 0 ? ONBOARDING_STEPS[idx - 1]?.key : undefined;
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
}

/** Picker-local actions consumed by the containing window's controls. */
interface OnboardingWindowActions {
  onBack?: () => void;
  backLabel?: string;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}

export interface OnboardingSubNav {
  /** Return to the previous decision without undoing confirmed choices. */
  onBack: () => void;
  /** The sub-step's decision was made (and already persisted/staged by the host). */
  onDone: () => void;
  /** Skip this step, keeping saved choices, and advance. */
  onSkip: () => void;
  /** Leave onboarding entirely, without completing it. */
  onExit: () => void;
  /** Expose the picker’s actual cancel and activation actions to the window. */
  registerActions: (actions?: OnboardingWindowActions) => void;
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
  onDismiss: () => void;
  /** Explicit application quit, separate from leaving setup. */
  onExit: () => void;
  interactive: boolean;
}

/** Register real picker actions without adding a second navigation row. */
export function OnboardingSubstep({ nav, children, ...actions }: OnboardingWindowActions & {
  nav: OnboardingSubNav;
  children: React.ReactNode;
}) {
  useLayoutEffect(() => { nav.registerActions(actions); });
  useLayoutEffect(() => () => { nav.registerActions(); }, [nav.registerActions]);
  return <>{children}</>;
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


function pluginsLines(width: number): StepLine[] {
  const scope = getScopeEnforcementState(process.cwd());
  return [
    ...paragraph("Plugins / Hackstore · optional", "title", width),
    BLANK,
    ...paragraph("/hackstore opens the plugin browser.", "accent", width),
    ...paragraph("Install saves files; Enable approves code for new audits.", "text", width),
    ...paragraph("Setup never installs, enables or runs plugins.", "muted", width),
    BLANK,
    ...paragraph(`Scope checks: ${scope.enabled ? "enabled" : "disabled"} for this project.`, scope.enabled ? "text" : "accent", width),
    ...(scope.enabled ? [] : paragraph("Target authorization, exclusions and local-path limits are not enforced.", "text", width)),
    ...(scope.enabled ? [] : paragraph("Enable explicitly: 0 plugin enable scope", "accent", width)),
    ...paragraph("Credential, sandbox and resource limits are independent.", "muted", width),
    BLANK,
    ...paragraph("Installed files: ~/.0/plugins/<id>/", "text", width),
    ...paragraph("Create: 0 hackstore init my-extension", "accent", width),
    ...paragraph("Check: 0 hackstore validate ./my-extension", "accent", width),
    ...paragraph("Try locally: 0 plugin install ./my-extension --local", "accent", width),
    ...paragraph("Submit: 0 hackstore prepare-submission --help", "accent", width),
    ...paragraph("Publishing is a reviewed Hackstore pull request.", "muted", width),
    ...paragraph("Author guide: https://docs.0.security/hackstore/", "accent", width),
  ];
}

function doneLines(width: number): StepLine[] {
  return [
    ...paragraph("Setup reviewed", "title", width),
    BLANK,
    ...paragraph("Finish returns to your main console.", "text", width),
    ...paragraph("Skipped choices are unchanged.", "muted", width),
    BLANK,
    ...paragraph("/connect · providers   /models · models", "accent", width),
    ...paragraph("/settings · preferences   /hackstore · plugins", "accent", width),
  ];
}

const STEP_LINES: Partial<Record<OnboardingStep, (width: number) => StepLine[]>> = {
  plugins: pluginsLines,
  done: doneLines,
};


// ---------------------------------------------------------------------------
// Analytics consent step
// ---------------------------------------------------------------------------

/** Every tier remains selectable; skipping preserves the current preference. */
const ANALYTICS_OPTIONS = [
  {
    level: "off",
    label: "Off",
    detail: "No analytics uploads. Also turns automatic problem reports off.",
  },
  {
    level: "usage",
    label: "Usage metrics",
    detail: "Counts, timing, cost and error categories. No tool content.",
  },
  {
    level: "commands",
    label: "Tools and code",
    detail: "Usage plus tool inputs, outputs and submitted code.",
  },
  {
    level: "full",
    label: "Full",
    detail: "Tools and code plus scope and findings.",
  },
] as const satisfies readonly { level: AnalyticsLevel; label: string; detail: string }[];

/** Disclose what each tier uploads and the effective process setting. */
function analyticsLines(width: number): StepLine[] {
  return [
    ...paragraph(`Data sharing · active: ${analyticsPipeline.getLevel()}`, "title", width),
    ...paragraph("Shared data supports model improvement and security research.", "text", width),
    ...paragraph("Credentials are scrubbed; identifying content may remain.", "text", width),
    ...paragraph("Uploads require an endpoint; delivery is not anonymous.", "muted", width),
    ...paragraph("Environment opt-outs win. Problem reports: /settings.", "muted", width),
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


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OnboardingScreen({
  frame,
  renderConnect,
  renderModels,
  onComplete,
  onDismiss,
  onExit,
  interactive,
}: OnboardingScreenProps) {
  const terminal = useSurfaceDimensions();
  const { keyHandler } = useContext(AppContext);
  const theme = useTheme();
  const settings = useSettings();
  const [stepIndex, setStepIndex] = useState(0);
  const [prefIndex, setPrefIndex] = useState(0);
  const [navFocus, setNavFocus] = useState<"back" | "skip" | "next" | null>(null);
  const registeredActions = useRef<OnboardingWindowActions | undefined>(undefined);
  const [actionMeta, setActionMeta] = useState({ backLabel: "Back", nextLabel: "Next", nextDisabled: false });
  const registerActions = useCallback((actions?: OnboardingWindowActions) => {
    registeredActions.current = actions;
    const backLabel = actions?.backLabel ?? "Back";
    const nextLabel = actions?.nextLabel ?? "Next";
    const nextDisabled = actions?.nextDisabled ?? false;
    setActionMeta((current) => current.backLabel === backLabel && current.nextLabel === nextLabel
      && current.nextDisabled === nextDisabled ? current : { backLabel, nextLabel, nextDisabled });
  }, []);
  const currentStep = ONBOARDING_STEPS[stepIndex]?.key ?? "done";
  const embedded = currentStep === "connect" || currentStep === "models";
  const outerWidth = Math.max(1, Math.min(currentStep === "welcome" ? 96 : 86,
    terminal.width - (terminal.width > 4 ? 4 : 0)));
  const preferredHeight = currentStep === "welcome" ? 28 : currentStep === "done" ? 20 : 26;
  const outerHeight = Math.max(1, Math.min(preferredHeight,
    terminal.height - (terminal.height > 10 ? 4 : 0)));
  const padded = outerWidth > 8 && outerHeight > 6;
  const paddingX = padded ? 2 : 0;
  const paddingY = padded ? 1 : 0;
  const contentWidth = Math.max(1, outerWidth - paddingX * 2);
  const contentHeight = Math.max(1, outerHeight - paddingY * 2);
  const actionRows = contentWidth >= 7 && contentHeight >= 2 ? 1 : 0;
  const headerRows = contentHeight - actionRows >= 2 ? 1 : 0;
  const separatorRows = headerRows > 0 && contentHeight - actionRows - headerRows >= 2 ? 1 : 0;
  const bodyRows = contentHeight - actionRows - headerRows - separatorRows;
  const textWidth = Math.max(1, contentWidth - 1);

  const advanceTo = useCallback((next: OnboardingStep) => {
    if (next === "preferences") setPrefIndex(0);
    const index = ONBOARDING_STEPS.findIndex((entry) => entry.key === next);
    if (index >= 0) setStepIndex(index);
  }, []);
  const advancePastCurrent = useCallback(() => {
    const next = stepAfter(currentStep);
    if (next) advanceTo(next);
  }, [currentStep, advanceTo]);
  const goBack = useCallback(() => {
    if (currentStep === "preferences" && prefIndex > 0) {
      setPrefIndex(prefIndex - 1);
      return;
    }
    if (currentStep === "analytics") setPrefIndex(ONBOARDING_PREFERENCE_KEYS.length - 1);
    const previous = stepBefore(currentStep);
    if (previous) setStepIndex(ONBOARDING_STEPS.findIndex((entry) => entry.key === previous));
    else onDismiss();
  }, [currentStep, prefIndex, onDismiss]);
  const handleBack = useCallback(() => {
    if (registeredActions.current?.onBack) registeredActions.current.onBack();
    else goBack();
  }, [goBack]);
  const prefKey = ONBOARDING_PREFERENCE_KEYS[prefIndex] as PreferenceKey | undefined;
  const prefDef = useMemo(() => SETTING_DEFS.find((entry) => entry.key === prefKey), [prefKey]);
  const prefChoices = prefDef?.choices ?? [];
  const [choiceIndex, setChoiceIndex] = useState(0);
  const choiceRef = useRef(choiceIndex);
  const themePreviewActive = useRef(false);
  const savedTheme = useRef<string | undefined>(undefined);

  // A reopened decision starts from its saved value, not an abandoned draft.
  useEffect(() => {
    setNavFocus(null);
    if (!interactive || currentStep !== "preferences" || !prefKey) return;
    if (prefKey === "theme") savedTheme.current = settings.theme;
    const index = prefChoices.indexOf(settings[prefKey]);
    choiceRef.current = index >= 0 ? index : 0;
    setChoiceIndex(choiceRef.current);
    return () => {
      if (themePreviewActive.current) {
        themePreviewActive.current = false;
        reloadSettings();
      }
    };
    // Only seed on opening a decision, never on a live preview notification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, currentStep, prefKey]);

  const commitPreference = useCallback(() => {
    const value = prefChoices[choiceIndex];
    themePreviewActive.current = false;
    if (prefKey && value !== undefined) updateSetting(prefKey, value as TuiSettings[PreferenceKey]);
    if (prefIndex + 1 < ONBOARDING_PREFERENCE_KEYS.length) setPrefIndex(prefIndex + 1);
    else advanceTo("analytics");
  }, [prefKey, prefChoices, choiceIndex, prefIndex, advanceTo]);
  const skipPreference = useCallback(() => {
    if (prefIndex + 1 < ONBOARDING_PREFERENCE_KEYS.length) setPrefIndex(prefIndex + 1);
    else advanceTo("analytics");
  }, [prefIndex, advanceTo]);
  const choosePreference = useCallback((index: number) => {
    choiceRef.current = index;
    setChoiceIndex(index);
    setNavFocus(null);
    if (prefKey === "theme") {
      const value = prefChoices[index];
      if (value !== undefined) {
        themePreviewActive.current = true;
        previewSetting("theme", value);
      }
    }
  }, [prefKey, prefChoices]);
  const cycleChoice = useCallback((delta: number) => {
    if (prefChoices.length) choosePreference((choiceRef.current + delta + prefChoices.length) % prefChoices.length);
  }, [choosePreference, prefChoices.length]);

  const [analyticsIndex, setAnalyticsIndex] = useState(() => Math.max(0,
    ANALYTICS_OPTIONS.findIndex((option) => option.level === settings.analyticsLevel)));
  useEffect(() => {
    if (currentStep === "analytics") setAnalyticsIndex(Math.max(0,
      ANALYTICS_OPTIONS.findIndex((option) => option.level === settings.analyticsLevel)));
  }, [currentStep, settings.analyticsLevel]);
  const cycleAnalytics = useCallback((delta: number) => {
    setAnalyticsIndex((index) => (index + delta + ANALYTICS_OPTIONS.length) % ANALYTICS_OPTIONS.length);
    setNavFocus(null);
  }, []);
  const commitAnalytics = useCallback(() => {
    recordAnalyticsConsent(ANALYTICS_OPTIONS[analyticsIndex]?.level ?? "off");
    advanceTo("plugins");
  }, [analyticsIndex, advanceTo]);
  const finishOrAdvance = useCallback(() => {
    if (currentStep === "done") {
      finalizeOnboarding();
      onComplete();
    } else advancePastCurrent();
  }, [currentStep, onComplete, advancePastCurrent]);
  const onNext = currentStep === "preferences" ? commitPreference
    : currentStep === "analytics" ? commitAnalytics : finishOrAdvance;
  const handleNext = useCallback(() => {
    const actions = registeredActions.current;
    if (actions?.nextDisabled) return;
    if (actions?.onNext) actions.onNext();
    else onNext();
  }, [onNext]);
  const onSkip = currentStep === "preferences" ? skipPreference
    : ONBOARDING_STEPS[stepIndex]?.skippable ? advancePastCurrent : undefined;
  const backButtonLabel = currentStep === "welcome" ? contentWidth < 36 ? "Skip" : "Skip setup" : actionMeta.backLabel;
  const nextButtonLabel = currentStep === "done" ? "Finish" : embedded ? actionMeta.nextLabel : "Next";
  const compactNavigation = contentWidth < textCells(backButtonLabel) + textCells(nextButtonLabel) + 5;
  const visibleSkip = Boolean(onSkip) && contentWidth >= textCells(backButtonLabel) + textCells(nextButtonLabel) + 12;

  // Model Tab still switches catalogues; Ctrl+Tab enters window controls.
  // Everywhere else Tab, Shift+Tab and focused Left/Right navigate buttons.
  useEffect(() => {
    if (!interactive || !keyHandler) return;
    const handle = (key: KeyEvent) => {
      if (key.name === "tab" && (currentStep !== "models" || key.ctrl || navFocus !== null)) {
        const controls: Array<"back" | "skip" | "next" | null> = visibleSkip
          ? ["back", "skip", "next", null] : ["back", "next", null];
        const index = controls.indexOf(navFocus);
        setNavFocus(controls[(index + (key.shift ? -1 : 1) + controls.length) % controls.length] ?? null);
      } else if (navFocus !== null && key.name === "return") {
        if (navFocus === "back") handleBack();
        else if (navFocus === "skip") onSkip?.();
        else handleNext();
      } else if (navFocus !== null && !key.ctrl && !key.meta && !key.option
        && (key.name === "left" || key.name === "right")) {
        const controls: Array<"back" | "skip" | "next"> = visibleSkip
          ? ["back", "skip", "next"] : ["back", "next"];
        const index = controls.indexOf(navFocus);
        setNavFocus(controls[(index + (key.name === "right" ? 1 : -1) + controls.length) % controls.length] ?? null);
      } else if (navFocus !== null && key.name === "escape") {
        setNavFocus(null);
      } else return;
      key.preventDefault();
      key.stopPropagation();
    };
    keyHandler.prependListener("keypress", handle);
    return () => { keyHandler.off("keypress", handle); };
  }, [interactive, keyHandler, currentStep, navFocus, visibleSkip, handleBack, onSkip, handleNext]);

  useKeyboard((key) => {
    if (!interactive || embedded) return;
    if (key.ctrl && key.name === "c") { onExit(); return; }
    if (key.name === "escape") { goBack(); return; }
    if (key.ctrl && key.name === "n") { onSkip?.(); return; }
    if (key.ctrl || key.meta || key.option) return;
    if (key.name === "return" && !key.shift) { onNext(); return; }
    if (key.name === "s") { onSkip?.(); return; }
    if (currentStep === "preferences") {
      if (key.name === "left" || key.name === "up" || key.name === "h" || key.name === "k") cycleChoice(-1);
      else if (key.name === "right" || key.name === "down" || key.name === "l" || key.name === "j") cycleChoice(1);
    } else if (currentStep === "analytics") {
      if (key.name === "up" || key.name === "left" || key.name === "k" || key.name === "h") cycleAnalytics(-1);
      else if (key.name === "down" || key.name === "right" || key.name === "j" || key.name === "l") cycleAnalytics(1);
    }
  });
  const subNav = useMemo<OnboardingSubNav>(() => ({
    onBack: goBack, onDone: advancePastCurrent, onSkip: advancePastCurrent, onExit, registerActions,
  }), [goBack, advancePastCurrent, onExit, registerActions]);

  let body: React.ReactNode;
  if (currentStep === "welcome") {
    const showMark = contentWidth >= TERMINAL_BLOCK_LOGO_WIDTH && bodyRows >= 10;
    const showMascot = showMark && bodyRows >= 20;
    body = <box width={contentWidth} height={bodyRows} flexDirection="column"
      alignItems="center" flexShrink={0} minWidth={0} overflow="hidden">
      <Masthead showTerminalMark={showMark} showMascot={showMascot} showTagline={false}
        contentWidth={contentWidth} logoFrameGrid={ONBOARDING_LOGO_FRAME} theme={theme} />
      {bodyRows >= (showMascot ? 20 : showMark ? 11 : 3) ? (
        <Cells width={contentWidth} align="center" fg={theme.MUTED}>
          {"Connect your provider. Make the console yours."}
        </Cells>
      ) : null}
    </box>;
  } else if (embedded) {
    body = <SurfaceContext.Provider value={{ width: contentWidth, height: bodyRows }}>
      {currentStep === "connect" ? renderConnect(subNav) : renderModels(subNav)}
    </SurfaceContext.Provider>;
  } else if (currentStep === "analytics") {
    body = <AnalyticsCard lines={analyticsLines(textWidth)} choiceIndex={analyticsIndex}
      theme={theme} contentWidth={contentWidth} textWidth={textWidth} bodyRows={bodyRows}
      onChoose={(index) => { setNavFocus(null); setAnalyticsIndex(index); }} />;
  } else if (currentStep === "preferences" && prefDef) {
    body = <PreferencesCard def={prefDef} choices={prefChoices} choiceIndex={choiceIndex}
      value={prefChoices[choiceIndex]} settings={settings} theme={theme}
      contentWidth={contentWidth} bodyRows={bodyRows}
      savedValue={prefKey === "theme" ? savedTheme.current ?? settings.theme : prefKey ? settings[prefKey] : undefined}
      onChoose={choosePreference} />;
  } else {
    body = <ProseCard lines={STEP_LINES[currentStep]?.(textWidth) ?? []}
      theme={theme} currentStep={currentStep} contentWidth={contentWidth}
      textWidth={textWidth} bodyRows={bodyRows} />;
  }

  const stepLabel = ONBOARDING_STEPS[stepIndex]?.label ?? "";
  const stepText = `Step ${stepIndex + 1} of ${ONBOARDING_STEPS.length} · ${stepLabel}`;
  const headerWidth = Math.max(1, contentWidth - stepText.length - 1);
  const content = (
    <box flexDirection="column" width={contentWidth} height={contentHeight} minWidth={0} overflow="hidden">
      {actionRows > 0 ? (
        <box flexDirection="row" width={contentWidth} height={1} flexShrink={0} minWidth={0} gap={1}>
          <DialogActionButton label={compactNavigation ? "‹" : backButtonLabel}
            onPress={handleBack} focused={navFocus === "back"} />
          {visibleSkip ? <DialogActionButton label="Skip" onPress={onSkip!} focused={navFocus === "skip"} /> : null}
          <DialogActionButton label={compactNavigation ? "›" : nextButtonLabel} variant="primary"
            onPress={handleNext} focused={navFocus === "next"} disabled={embedded && actionMeta.nextDisabled} />
        </box>
      ) : null}
      {headerRows > 0 ? (
        <box flexDirection="row" width={contentWidth} height={1} flexShrink={0} minWidth={0}>
          <Cells width={headerWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>{"0.security / setup"}</Cells>
          <Cells width={contentWidth - headerWidth} align="right" fg={theme.MUTED}>{stepText}</Cells>
        </box>
      ) : null}
      {separatorRows > 0 ? <box height={1} flexShrink={0} /> : null}
      <box width={contentWidth} height={bodyRows} flexShrink={0} minWidth={0} minHeight={0} overflow="hidden">
        {bodyRows > 0 ? body : null}
      </box>
    </box>
  );
  return interactive ? (
    <Popup variant="centered" width={outerWidth} height={outerHeight}
      paddingX={paddingX} paddingY={paddingY} dismissOnBackdrop={false}>
      <SurfaceContext.Provider value={{ width: contentWidth, height: contentHeight }}>
        {frame({ body: content })}
      </SurfaceContext.Provider>
    </Popup>
  ) : null;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function ProseCard({
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
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  useKeyboard((key) => {
    if (key.name === "pageup") scroll.current?.scrollBy(-1, "viewport");
    if (key.name === "pagedown") scroll.current?.scrollBy(1, "viewport");
    if (key.name === "up") scroll.current?.scrollBy(-1);
    if (key.name === "down") scroll.current?.scrollBy(1);
  });
  const rows = lines.map((line, index) => (
    <Cells key={`step-${index}`} width={textWidth} fg={toneColor(line.tone, theme)}
      attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}>
      {line.text}
    </Cells>
  ));

  // Short cards remain top-aligned; long disclosures are scrollable.
  if (lines.length <= bodyRows) {
    return (
      <box
        flexDirection="column"
        width={contentWidth}
        height={bodyRows}
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
      ref={scroll}
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

/** A draft-only picker alongside the shared live console preview. */
function PreferencesCard({
  def,
  choices,
  choiceIndex,
  value,
  savedValue,
  settings,
  theme,
  contentWidth,
  onChoose,
  bodyRows,
}: {
  def: (typeof SETTING_DEFS)[number];
  choices: readonly string[];
  choiceIndex: number;
  value: string | undefined;
  savedValue: unknown;
  settings: TuiSettings;
  theme: Theme;
  contentWidth: number;
  onChoose: (index: number) => void;
  bodyRows: number;
}) {
  const pickerRows = Math.max(1, bodyRows - 2);
  const items = useMemo<DialogItem[]>(() => choices.map((choice) => ({
    id: choice,
    label: choice.replace(/-/g, " "),
    current: choice === savedValue,
  })), [choices, savedValue]);
  const fullPanel = computeDialogPanel({
    width: contentWidth, height: pickerRows, totalRows: choices.length,
    bodyRows: pickerRows + 1, withDetail: true,
  });
  const stackedPreview = !fullPanel.showDetail && pickerRows >= 12;
  const listRows = stackedPreview ? Math.max(2, pickerRows - 10) : pickerRows;
  const panel = stackedPreview ? computeDialogPanel({
    width: contentWidth, height: listRows, totalRows: choices.length, bodyRows: listRows + 1,
  }) : fullPanel;
  return (
    <box flexDirection="column" width={contentWidth} height={bodyRows} flexShrink={0} minWidth={0} overflow="hidden">
      <Cells width={contentWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
        {`${def.label} · ${value ?? ""}`}
      </Cells>
      <Cells width={contentWidth} fg={theme.MUTED}>{"Choose a look. Next saves this choice."}</Cells>
      <DialogSelectBody items={items} cursor={choiceIndex} panel={panel} query="" hideSearch gutter
        onActivateRow={onChoose} onHoverRow={onChoose}
        renderDetail={(_item, pane) => <SettingsPreview def={def} value={value} settings={settings}
          theme={theme} width={pane.width} rowBudget={pane.height} />}
        onScroll={(delta) => onChoose((choiceIndex + delta + choices.length) % choices.length)} />
      {stackedPreview ? <SettingsPreview def={def} value={value} settings={settings} theme={theme}
        width={contentWidth} rowBudget={Math.max(0, pickerRows - listRows)} /> : null}
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
  onChoose,
}: {
  lines: StepLine[];
  choiceIndex: number;
  theme: Theme;
  contentWidth: number;
  textWidth: number;
  bodyRows: number;
  onChoose: (index: number) => void;
}) {
  const rows: React.ReactNode[] = [];
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  let selectedRow = 0;

  // Disclosures stay visible while the tier list scrolls in short terminals.
  const intro = lines.slice(0, Math.max(0, bodyRows - 3));
  const choiceRows = Math.max(1, bodyRows - intro.length);

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
        onMouseDown={() => onChoose(index)}
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
    viewport.scrollTo(Math.min(selectedRow, Math.max(0, rows.length - choiceRows)));
  }, [choiceIndex, selectedRow, rows.length, choiceRows]);
  useKeyboard((key) => {
    if (key.name === "pageup") scroll.current?.scrollBy(-1, "viewport");
    if (key.name === "pagedown") scroll.current?.scrollBy(1, "viewport");
  });

  return (
    <box flexDirection="column" width={contentWidth} height={bodyRows} flexShrink={0} minWidth={0} overflow="hidden">
      {intro.map((line, index) => (
        <Cells key={`analytics-intro-${index}`} width={textWidth} fg={toneColor(line.tone, theme)}
          attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}>
          {line.text}
        </Cells>
      ))}
      {rows.length > choiceRows ? (
        <scrollbox ref={scroll} width={contentWidth} height={choiceRows} flexShrink={0}
          scrollX={false} verticalScrollbarOptions={sleekScrollbar(theme)}>
          <box flexDirection="column" width={textWidth} flexShrink={0}>{rows}</box>
        </scrollbox>
      ) : (
        <box flexDirection="column" width={contentWidth} height={choiceRows} flexShrink={0} minWidth={0}>
          {rows}
        </box>
      )}
    </box>
  );
}
