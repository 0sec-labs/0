/** @jsxImportSource @opentui/react */
/**
 * Optional /onboard setup. Reuses the provider/model pickers and the settings
 * store; highlighted choices do not persist until confirmed. Back and Skip
 * retain saved choices. The final data-sharing decision completes setup.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { sleekScrollbar } from "./scrollbar.js";
import { AppContext, useKeyboard, useRenderer } from "@opentui/react";
import {
  CliRenderEvents,
  resolveImageRenderProtocol,
  TextAttributes,
  type KeyEvent,
  type NativeImage,
  type ScrollBoxRenderable,
} from "@opentui/core";

import { Cells, textCells } from "./primitives.js";
import {
  getSettingSources,
  previewSetting,
  reloadSettings,
  updateSetting,
  useSettings,
} from "./settings-store.js";
import { SETTING_DEFS, type TuiSettings } from "./settings.js";
import { SettingsPreview } from "./settings-preview.js";
import { SurfaceContext, useSurfaceDimensions } from "./dialog-surface.js";
import { DialogActionButton } from "./dialog-screen-chrome.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import { computeDialogPanel, type DialogPanel } from "./dialog-select-layout.js";
import { Popup } from "./popup.js";
import { buildConnectRows } from "./connect-layout.js";
import { loadAccountStore } from "./credential-store.js";
import { providerStates } from "./provider-status.js";
import { wrapCells } from "./settings-layout.js";
import { fitTuiText } from "./text.js";
import { useTheme, type Theme } from "./theme-context.js";
import {
  createZeroAxeImages,
  ZERO_AXE_FRAME_DURATIONS,
  ZERO_AXE_HEIGHT,
  ZERO_AXE_WIDTH,
} from "./chat/zero-axe-art.js";


// ---------------------------------------------------------------------------
// Steps — the state machine
// ---------------------------------------------------------------------------

export type OnboardingStep =
  | "welcome"
  | "connect"
  | "models"
  | "preferences"
  | "analytics";

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
  { key: "preferences", label: "Theme", skippable: true },
  { key: "analytics", label: "Data sharing", skippable: true },
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


/** Only finishing the final decision writes the operator-owned completion flag. */
export function finalizeOnboarding(): void {
  updateSetting("onboardingCompleted", true);
}

/** The two consent choices exposed by onboarding. */
export type AnalyticsLevel = "off" | "usage";

/** Usage analytics and problem/error reports use independent consent paths. */
export function recordAnalyticsConsent(level: AnalyticsLevel): void {
  updateSetting("analyticsLevel", level);
}


// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OnboardingFrameInput {
  body: React.ReactNode;
}

interface EmbeddedConnectFrameInput extends OnboardingFrameInput {
  hint: string;
  onBack?: () => void;
  backLabel?: string;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}

type EmbeddedConnectFrame = (input: EmbeddedConnectFrameInput) => React.ReactNode;

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


type LineTone = "title" | "text" | "muted" | "accent";

interface StepLine {
  readonly text: string;
  readonly tone: LineTone;
}

/** A paragraph, wrapped to the card width rather than hard-broken by hand. */
function paragraph(text: string, tone: LineTone, width: number): StepLine[] {
  return wrapCells(text, width).map((line) => ({ text: line, tone }));
}

/** Suppress browse-only connection prose while preserving entry/sign-in detail. */
function suppressConnectBrowseDetail(node: React.ReactNode): React.ReactNode {
  if (!React.isValidElement(node)) return node;
  const element = node as React.ReactElement<{ children?: React.ReactNode }>;
  if (element.type === DialogSelectBody) {
    const picker = element as React.ReactElement<React.ComponentProps<typeof DialogSelectBody>>;
    const panel = picker.props.panel;
    const compactPanel: DialogPanel = {
      ...panel,
      listWidth: panel.innerWidth,
      rowWidth: Math.max(1, panel.innerWidth - (panel.scrolls ? 1 : 0)),
      showDetail: false,
      detailWidth: 0,
      detailGap: 0,
    };
    return React.cloneElement(picker, { panel: compactPanel, renderDetail: undefined });
  }
  if (element.props.children === undefined) return element;
  let changed = false;
  const children = React.Children.map(element.props.children, (child) => {
    const next = suppressConnectBrowseDetail(child);
    if (next !== child) changed = true;
    return next;
  });
  return changed
    ? React.cloneElement(element, { children })
    : element;
}

/** The host's embedded ConnectScreen frame, wrapped only in provider browse mode. */
function suppressConnectBrowseDetails(connect: React.ReactNode): React.ReactNode {
  if (!React.isValidElement(connect)) return connect;
  const props = connect.props;
  if (props === null || typeof props !== "object" || !("frame" in props) || typeof props.frame !== "function") {
    return connect;
  }
  // `renderConnect` is the host's ConnectScreen element by contract.
  const frame = props.frame as EmbeddedConnectFrame;
  return React.cloneElement(
    connect as React.ReactElement<{ frame: EmbeddedConnectFrame }>,
    {
      frame: (input) => frame({
        ...input,
        body: suppressConnectBrowseDetail(input.body),
      }),
    },
  );
}


/** Return provider labels only; never carry credential values into the view. */
function detectedProviderLabels(): string[] {
  const accountStore = loadAccountStore();
  const rows = buildConnectRows({
    states: providerStates(process.env),
    stored: Object.keys(accountStore.providers),
  });
  const labels: string[] = [];
  for (const row of rows) {
    if (row.kind === "provider" && row.provider.connected) labels.push(row.provider.label);
  }
  return labels;
}

function providerSetupLines(labels: readonly string[], width: number): StepLine[] {
  const detected = labels.length > 0
    ? `Detected credentials: ${labels.join(", ")}.`
    : "No provider credentials detected.";
  const guidance = labels.length > 0
    ? "Connect another provider below."
    : "Select a provider below to connect one.";
  return [
    ...paragraph(detected, labels.length > 0 ? "accent" : "muted", width),
    ...paragraph(guidance, "muted", width),
  ];
}

// ---------------------------------------------------------------------------
// Analytics consent step
// ---------------------------------------------------------------------------

/** Only Off and pseudonymous usage metrics are offered during setup. */
const ANALYTICS_OPTIONS = [
  {
    level: "off",
    label: "Off",
    detail: "No analytics uploads.",
  },
  {
    level: "usage",
    label: "Yes, I’d like to help make 0 better!",
    detail: "Pseudonymous usage metrics to help improve 0.",
  },
] as const satisfies readonly { level: AnalyticsLevel; label: string; detail: string }[];

/** Keep setup copy short; each choice names what it shares. */
function analyticsLines(width: number): StepLine[] {
  return [
    ...paragraph("Data sharing", "title", width),
    ...paragraph("You can change this choice in Settings.", "muted", width),
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

function WelcomeHero({
  contentWidth,
  bodyRows,
  theme,
  reduceMotion,
}: {
  contentWidth: number;
  bodyRows: number;
  theme: Theme;
  reduceMotion: boolean;
}) {
  const renderer = useRenderer();
  const subscribe = useCallback((changed: () => void) => {
    renderer.on(CliRenderEvents.CAPABILITIES, changed);
    renderer.on(CliRenderEvents.RESIZE, changed);
    renderer.on(CliRenderEvents.FRAME, changed);
    return () => {
      renderer.off(CliRenderEvents.CAPABILITIES, changed);
      renderer.off(CliRenderEvents.RESIZE, changed);
      renderer.off(CliRenderEvents.FRAME, changed);
    };
  }, [renderer]);
  const getProtocol = useCallback(() => {
    const resolution = renderer.resolution;
    const hasResolution = renderer.terminalWidth > 0 && renderer.terminalHeight > 0
      && Boolean(resolution && resolution.width > 0 && resolution.height > 0);
    return resolveImageRenderProtocol("auto", renderer.capabilities, hasResolution);
  }, [renderer]);
  const protocol = useSyncExternalStore(subscribe, getProtocol);
  const greetingLines = wrapCells("Hey there! Meet Zero.", contentWidth);
  const maxImageHeight = Math.min(
    ZERO_AXE_HEIGHT,
    Math.max(0, bodyRows - greetingLines.length - (greetingLines.length > 0 ? 1 : 0)),
  );
  let imageHeight = maxImageHeight;
  let imageWidth = Math.min(contentWidth, Math.round(imageHeight * ZERO_AXE_WIDTH / ZERO_AXE_HEIGHT));
  imageHeight = Math.min(imageHeight, Math.round(imageWidth * ZERO_AXE_HEIGHT / ZERO_AXE_WIDTH));
  const showImage = protocol !== "blocks" && imageWidth >= 12 && imageHeight >= 8;
  const [imageAssets, setImageAssets] = useState<{ canvas: string; images: NativeImage[] }>();
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!showImage) {
      setImageAssets(undefined);
      return;
    }
    const images = createZeroAxeImages(theme.PANEL);
    setImageAssets({ canvas: theme.PANEL, images });
    setFrameIndex(0);
    return () => { images.forEach((image) => image.dispose()); };
  }, [showImage, theme.PANEL]);

  useEffect(() => {
    if (!showImage || reduceMotion) {
      setFrameIndex(0);
      return;
    }
    let index = 0;
    let timer: NodeJS.Timeout;
    const schedule = () => {
      timer = setTimeout(() => {
        index = (index + 1) % ZERO_AXE_FRAME_DURATIONS.length;
        setFrameIndex(index);
        schedule();
      }, ZERO_AXE_FRAME_DURATIONS[index] ?? 1000);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [showImage, reduceMotion]);

  const images = imageAssets?.canvas === theme.PANEL ? imageAssets.images : undefined;
  const image = images?.[reduceMotion ? 0 : frameIndex];
  return (
    <box width={contentWidth} height={bodyRows} flexDirection="column" alignItems="center"
      flexShrink={0} minWidth={0} overflow="hidden">
      {showImage && image ? (
        <box width={imageWidth} height={imageHeight} flexShrink={0} marginBottom={1}
          backgroundColor={theme.PANEL}>
          <image source={image} protocol={protocol} fit="fit"
            width={imageWidth} height={imageHeight} flexShrink={0} />
        </box>
      ) : null}
      {greetingLines.slice(0, Math.max(0, bodyRows - (showImage ? imageHeight + 1 : 0))).map((line, index) => (
        <Cells key={`welcome-greeting-${index}`} width={contentWidth} align="center" fg={theme.TEXT}>
          {line}
        </Cells>
      ))}
    </box>
  );
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
  const currentStep = ONBOARDING_STEPS[stepIndex]?.key ?? "welcome";
  const embedded = currentStep === "connect" || currentStep === "models";
  const detectedProviders = useMemo(
    () => currentStep === "connect" ? detectedProviderLabels() : [],
    [currentStep],
  );
  const outerWidth = Math.max(1, Math.min(currentStep === "welcome" ? 96 : 86,
    terminal.width - (terminal.width > 4 ? 4 : 0)));
  const preferredHeight = currentStep === "welcome" ? 28 : 26;
  const outerHeight = Math.max(1, Math.min(preferredHeight,
    terminal.height - (terminal.height > 10 ? 4 : 0)));
  const padded = outerWidth > 8 && outerHeight > 6;
  const paddingX = padded ? 2 : 0;
  const paddingY = padded ? 1 : 0;
  const contentWidth = Math.max(1, outerWidth - paddingX * 2);
  const contentHeight = Math.max(1, outerHeight - paddingY);
  const actionRows = contentWidth >= 7 && contentHeight >= 2 ? 1 : 0;
  const primaryRows = contentWidth >= 7 && contentHeight >= 4 ? 1 : 0;
  const headerRows = contentHeight - actionRows - primaryRows >= 2 ? 1 : 0;
  const separatorRows = headerRows > 0 && contentHeight - actionRows - primaryRows - headerRows >= 2 ? 1 : 0;
  const bodyRows = contentHeight - actionRows - primaryRows - headerRows - separatorRows;
  const textWidth = Math.max(1, contentWidth - 1);
  const providerBrowseMode = currentStep === "connect"
    && actionMeta.nextLabel !== "Save" && actionMeta.nextLabel !== "Signing in";

  const advanceTo = useCallback((next: OnboardingStep) => {
    const index = ONBOARDING_STEPS.findIndex((entry) => entry.key === next);
    if (index >= 0) setStepIndex(index);
  }, []);
  const advancePastCurrent = useCallback(() => {
    const next = stepAfter(currentStep);
    if (next) advanceTo(next);
    else { finalizeOnboarding(); onComplete(); }
  }, [currentStep, advanceTo, onComplete]);
  const goBack = useCallback(() => {
    const previous = stepBefore(currentStep);
    if (previous) setStepIndex(ONBOARDING_STEPS.findIndex((entry) => entry.key === previous));
    else onDismiss();
  }, [currentStep, onDismiss]);
  const handleBack = useCallback(() => {
    if (embedded && registeredActions.current?.onBack) registeredActions.current.onBack();
    else goBack();
  }, [embedded, goBack]);
  const prefDef = useMemo(() => SETTING_DEFS.find((entry) => entry.key === "theme")!, []);
  const prefChoices = prefDef?.choices ?? [];
  const [choiceIndex, setChoiceIndex] = useState(0);
  const choiceRef = useRef(choiceIndex);
  const themePreviewActive = useRef(false);
  const savedTheme = useRef<string | undefined>(undefined);

  // A reopened decision starts from its saved value, not an abandoned draft.
  useEffect(() => {
    setNavFocus(null);
    if (!interactive || currentStep !== "preferences") return;
    savedTheme.current = settings.theme;
    const index = prefChoices.indexOf(settings.theme);
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
  }, [interactive, currentStep]);

  const commitPreference = useCallback(() => {
    const value = prefChoices[choiceRef.current];
    themePreviewActive.current = false;
    if (value !== undefined) updateSetting("theme", value);
    advanceTo("analytics");
  }, [prefChoices, advanceTo]);
  const skipPreference = useCallback(() => advanceTo("analytics"), [advanceTo]);
  const choosePreference = useCallback((index: number) => {
    choiceRef.current = index;
    setChoiceIndex(index);
    setNavFocus(null);
    const value = prefChoices[index];
    if (value !== undefined) {
      themePreviewActive.current = true;
      previewSetting("theme", value);
    }
  }, [prefChoices]);
  const cycleChoice = useCallback((delta: number) => {
    if (prefChoices.length) choosePreference((choiceRef.current + delta + prefChoices.length) % prefChoices.length);
  }, [choosePreference, prefChoices.length]);

  const analyticsLevelSource = getSettingSources().analyticsLevel;
  const persistedAnalyticsIndex = ANALYTICS_OPTIONS.findIndex(
    (option) => option.level === settings.analyticsLevel,
  );
  const defaultAnalyticsIndex = ANALYTICS_OPTIONS.findIndex((option) => option.level === "usage");
  const selectedAnalyticsIndex = analyticsLevelSource === "default"
    ? defaultAnalyticsIndex
    : Math.max(0, persistedAnalyticsIndex);
  const [analyticsIndex, setAnalyticsIndex] = useState(selectedAnalyticsIndex);
  useEffect(() => {
    if (currentStep === "analytics") setAnalyticsIndex(selectedAnalyticsIndex);
  }, [currentStep, selectedAnalyticsIndex]);
  const cycleAnalytics = useCallback((delta: number) => {
    setAnalyticsIndex((index) => (index + delta + ANALYTICS_OPTIONS.length) % ANALYTICS_OPTIONS.length);
    setNavFocus(null);
  }, []);
  const commitAnalytics = useCallback(() => {
    recordAnalyticsConsent(ANALYTICS_OPTIONS[analyticsIndex]?.level ?? "off");
    advancePastCurrent();
  }, [analyticsIndex, advancePastCurrent]);
  const onNext = currentStep === "preferences" ? commitPreference
    : currentStep === "analytics" ? commitAnalytics : advancePastCurrent;
  const handleNext = useCallback(() => {
    if (!embedded) {
      onNext();
      return;
    }
    const actions = registeredActions.current;
    if (actions?.nextDisabled) return;
    if (actions?.onNext) actions.onNext();
    else onNext();
  }, [embedded, onNext]);
  const onSkip = currentStep === "preferences" ? skipPreference
    : ONBOARDING_STEPS[stepIndex]?.skippable ? advancePastCurrent : undefined;
  const backButtonLabel = currentStep === "welcome" ? contentWidth < 36 ? "Skip" : "Skip setup" : actionMeta.backLabel;
  const nextButtonLabel = currentStep === "welcome" ? "Continue"
    : currentStep === "analytics" ? "Finish" : embedded ? actionMeta.nextLabel : "Next";
  const visibleSkip = Boolean(onSkip)
    && contentWidth >= textCells(backButtonLabel) + textCells("Skip") + 5;
  const compactNavigation = contentWidth < textCells(backButtonLabel)
    + (visibleSkip ? textCells("Skip") + 1 : 0) + 4;
  const compactPrimary = contentWidth < textCells(nextButtonLabel) + 4;

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
    body = <WelcomeHero contentWidth={contentWidth} bodyRows={bodyRows}
      theme={theme} reduceMotion={settings.reduceMotion} />;
  } else if (embedded) {
    if (currentStep === "connect") {
      const introLines = providerSetupLines(detectedProviders, textWidth);
      const introRows = Math.min(introLines.length, Math.max(0, bodyRows - 1));
      const pickerRows = bodyRows - introRows;
      const pickerSurfaceHeight = pickerRows;
      const connectScreen = renderConnect(subNav);
      const visibleConnectScreen = providerBrowseMode
        ? suppressConnectBrowseDetails(connectScreen) : connectScreen;
      body = (
        <box width={contentWidth} height={bodyRows} flexDirection="column" flexShrink={0}
          minWidth={0} overflow="hidden">
          {introLines.slice(0, introRows).map((line, index) => (
            <Cells key={`provider-intro-${index}`} width={textWidth}
              fg={toneColor(line.tone, theme)}>{line.text}</Cells>
          ))}
          <SurfaceContext.Provider value={{ width: contentWidth, height: pickerSurfaceHeight }}>
            {visibleConnectScreen}
          </SurfaceContext.Provider>
        </box>
      );
    } else {
      body = <SurfaceContext.Provider value={{ width: contentWidth, height: bodyRows }}>
        {renderModels(subNav)}
      </SurfaceContext.Provider>;
    }
  } else if (currentStep === "analytics") {
    body = <AnalyticsCard lines={analyticsLines(textWidth)} choiceIndex={analyticsIndex}
      theme={theme} contentWidth={contentWidth} textWidth={textWidth} bodyRows={bodyRows}
      onChoose={(index) => { setNavFocus(null); setAnalyticsIndex(index); }} />;
  } else {
    body = <PreferencesCard def={prefDef} choices={prefChoices} choiceIndex={choiceIndex}
      value={prefChoices[choiceIndex]} settings={settings} theme={theme}
      contentWidth={contentWidth} bodyRows={bodyRows}
      savedValue={savedTheme.current ?? settings.theme}
      onChoose={choosePreference} />;
  }

  const stepLabel = ONBOARDING_STEPS[stepIndex]?.label ?? "";
  const stepText = `Step ${stepIndex + 1} of ${ONBOARDING_STEPS.length} · ${stepLabel}`;
  const headerWidth = Math.max(1, contentWidth - stepText.length - 1);
  const content = (
    <box flexDirection="column" width={outerWidth} height={contentHeight} minWidth={0} overflow="hidden">
      {headerRows > 0 ? (
        <box flexDirection="row" width={outerWidth} height={1} flexShrink={0} minWidth={0}
          backgroundColor={theme.PANEL_ALT}>
          {paddingX > 0 ? <box width={paddingX} flexShrink={0} /> : null}
          <Cells width={headerWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
            {fitTuiText("0.security / setup", headerWidth)}
          </Cells>
          <Cells width={contentWidth - headerWidth} align="right" fg={theme.MUTED}>
            {fitTuiText(stepText, contentWidth - headerWidth)}
          </Cells>
          {paddingX > 0 ? <box width={paddingX} flexShrink={0} /> : null}
        </box>
      ) : null}
      <box flexDirection="column" width={contentWidth} height={contentHeight - headerRows}
        marginLeft={paddingX} flexShrink={0} minWidth={0} minHeight={0} overflow="hidden">
        {actionRows > 0 ? (
          <box flexDirection="row" width={contentWidth} height={1} flexShrink={0} minWidth={0} gap={1}>
            <DialogActionButton label={compactNavigation ? "‹" : backButtonLabel}
              onPress={handleBack} focused={navFocus === "back"} />
            {visibleSkip ? <DialogActionButton label="Skip" onPress={onSkip!} focused={navFocus === "skip"} /> : null}
            <box flexGrow={1} />
          </box>
        ) : null}
        {separatorRows > 0 ? <box height={1} flexShrink={0} /> : null}
        <box width={contentWidth} height={bodyRows} flexShrink={0} minWidth={0} minHeight={0} overflow="hidden">
          {bodyRows > 0 ? body : null}
        </box>
        {primaryRows > 0 ? (
          <box flexDirection="row" width={contentWidth} height={1} flexShrink={0} justifyContent="center">
            <DialogActionButton label={compactPrimary ? "›" : nextButtonLabel} variant="primary"
              onPress={handleNext} focused={navFocus === "next"} disabled={embedded && actionMeta.nextDisabled} />
          </box>
        ) : null}
      </box>
    </box>
  );
  return interactive ? (
    <Popup variant="centered" width={outerWidth} height={outerHeight}
      paddingX={0} paddingY={0} dismissOnBackdrop={false}>
      <SurfaceContext.Provider value={{ width: outerWidth, height: outerHeight }}>
        {frame({ body: content })}
      </SurfaceContext.Provider>
    </Popup>
  ) : null;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------


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
        onActivateRow={onChoose}
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
