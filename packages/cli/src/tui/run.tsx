/** @jsxImportSource @opentui/react */
import { randomUUID } from "node:crypto";
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { CliRenderEvents, createCliRenderer, type CliRenderer } from "@opentui/core";
import { AppContext, createRoot, useKeyboard } from "@opentui/react";
import { type Finding } from "@0/shared";
import { resolveEngagement } from "../engagement-plan.js";
import { getRuntimeAvailability } from "../utils.js";
import { buildFindingChatPrompt, loadFindingFocus } from "../finding-focus.js";
import { runUnified } from "../commands/run.js";
import { useTheme } from "./theme-context.js";
import { useMouseSupport } from "./mouse.js";
import {
  SHELL_HORIZONTAL_PADDING,
  getShellChromeHeight,
} from "./shell-geometry.js";
import { FooterBar, ShellFrame } from "./shell-frame.js";
import {
  TuiErrorBoundary,
  appendTuiCrash,
  appendTuiEvent,
  appendTuiTrace,
  installTuiCrashHandlers,
  serializeError,
} from "./tui-crash.js";
import { leaveCurrentScreen, type ShellNav } from "./shell-nav.js";
import { SessionScreen } from "./session-screen.js";
import { HomeScreen } from "./home-screen.js";
import { OpsScreen } from "./ops-screen.js";
import { DoctorScreen } from "./doctor-screen.js";
import { HistoryScreen } from "./history-screen.js";
import { FindingsScreen } from "./findings-screen.js";
import { ReplayScreen } from "./replay-screen.js";
import { PanePalette } from "./command-palette.js";
import { RouteHistoryKeys } from "./route-history-keys.js";
import { PopupStackProvider } from "./popup-stack.js";
import type { FindingsScreenOptions } from "./findings-data.js";
import { DialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { ShutdownDialog } from "./shutdown-dialog.js";
import {
  ChatScreen,
  type ChatDestination,
  type ChatScreenOptions,
} from "./chat-screen.js";
import { AuditWorkspace, type AuditRecord } from "./audit-workspace.js";
import type { HerdSubagentMap } from "./herd-layout.js";
import { AuditSwitcher } from "./audit-switcher.js";
import { OnboardingScreen, OnboardingSubstep } from "./onboarding-screen.js";
import { HerdScreen } from "./herd-screen.js";
import { AgentsCommsScreen } from "./agents-comms-screen.js";
import { SettingsScreen } from "./settings-screen.js";
import { KeybindingsEditorScreen } from "./keybindings-editor-screen.js";
import { HarnessProvider } from "./harness-context.js";
import { HarnessControlsPanel } from "./harness-trust-controls.js";
import { ModelScreen } from "./model-screen.js";
import { ResumeScreen } from "./resume-screen.js";
import { listSessions, loadSession, deleteSession } from "./session-store.js";
import { MarketScreen } from "./market-screen.js";
import { createPluginService } from "./plugin-service.js";
import { createSessionPluginHostManager, type SessionPluginHostManager } from "./session-plugin-host.js";
import { connectMcpServers, parseMcpConfig, DEFAULT_REGISTRY_URL, TOOL_DEFINITIONS } from "@0/core";
import { ConnectScreen } from "./connect-screen.js";
import type { ConnectionRecovery } from "./connection-recovery.js";
import { UsageScreen } from "./usage-screen.js";
import { FindingDetailScreen } from "./finding-detail-screen.js";
import { copyToClipboard, defaultSpawn, defaultWhich } from "./clipboard.js";
import { createSessionCloseGate } from "./session-close-gate.js";
import { reportHerdrSession, reportHerdrSessionClose } from "../herdr-state.js";
import { installTuiOutputGuard } from "./output-guard.js";
import {
  createTuiLensEvolutionController,
  tuiLensEvolutionStatusLabel,
  type TuiLensEvolutionController,
  type TuiLensEvolutionStatus,
} from "./lens-evolution.js";
import {
  applySessionEvent,
  applySessionReport,
  createInitialSessionState,
  type SessionEvent,
  type SessionMode,
  type SessionState,
  type TranscriptItem,
} from "./session-state.js";
import { projectSessionItem } from "./session-presentation.js";
import { createSessionPresentationAdapter } from "../presentation/session-adapter.js";
import {
  resumeProcessPresentationStreamBridge,
  suspendProcessPresentationStreamBridge,
} from "../presentation/process-output.js";

type HomeAction = "run" | "tui" | "doctor" | "replay" | "history" | "findings";
export type LaunchRuntime = "auto" | "api" | "claude" | "codex" | "gemini";
export type LaunchDepth = "quick" | "default" | "deep";

export interface HomeSelection {
  action: HomeAction;
  target?: string;
  runtime?: LaunchRuntime;
  depth?: LaunchDepth;
}

type ConsoleRoute = (
  | { type: "chat"; options?: ChatScreenOptions }
  | { type: "launcher" }
  | { type: "ops"; dbPath?: string; refreshMs: number }
  | { type: "doctor" }
  | { type: "history"; dbPath?: string; limit: number }
  | { type: "findings"; options: FindingsScreenOptions }
  | { type: "replay"; dbPath?: string; scanId?: string }
  | { type: "settings" }
  | { type: "keybindings" }
  | { type: "harness" }
  | { type: "herd" }
  | { type: "comms" }
  | { type: "audits" }
  | { type: "onboard" }
  | { type: "market" }
  | { type: "connect"; recovery?: ConnectionRecovery }
  | { type: "models"; chatOptions?: ChatScreenOptions }
  | { type: "resume"; chatOptions?: ChatScreenOptions }
  | { type: "usage"; chatOptions?: ChatScreenOptions }
  | { type: "finding"; findingId?: string; finding?: Finding; chatOptions?: ChatScreenOptions }
  | { type: "session"; initialState: SessionState; subscribe: (listener: (state: SessionState) => void) => () => void; queueUserMessage?: (text: string) => void; onClose: () => void | Promise<void> }
) & { auditId?: string };


const SCREENS_WITH_LOCAL_PALETTE: Partial<Record<ConsoleRoute["type"], true>> = {
  chat: true, launcher: true, ops: true, doctor: true,
  history: true, findings: true, replay: true, session: true,
};


function ConsoleSessionRoute({ route, shell }: { route: Extract<ConsoleRoute, { type: "session" }>; shell: ShellNav }) {
  const [state, setState] = useState(route.initialState);
  useEffect(() => route.subscribe(setState), [route]);
  return <SessionScreen state={state} onExit={route.onClose} shell={shell} queueUserMessage={route.queueUserMessage} />;
}


/**
 * Routes the settings screen, supplying the console shell around it.
 *
 * `SettingsScreen` takes the frame as a prop rather than importing
 * `ShellFrame` so that `settings-screen.tsx` does not have to import this
 * module — which owns every other screen — just to draw a header. The footer
 * text is handed back per render because the hint changes with the screen's
 * mode: browsing, filtering, and confirming a reset each bind different keys.
 *
 * The command palette is deliberately not mounted here. Every printable key
 * on this screen filters the list, so a second `useKeyboard` competing for
 * those keystrokes would make `p` both a filter character and a palette
 * toggle. Esc leaves, which is the binding the palette was mostly used for.
 */
function SettingsRoute({ onExit, shell }: { onExit: () => void; shell?: ShellNav }) {
  const theme = useTheme();
  useKeyboard((key) => {
    if (key.ctrl && key.name === "g") shell?.openHarness();
    // Ctrl+K opens the keybinding editor. The keybindings map is not a scalar
    // settings row (it is a map, not a boolean/enum the dialog can cycle), so it
    // lives on its own capture-oriented screen rather than in the table.
    if (key.ctrl && key.name === "k") shell?.openKeybindings();
  });
  return (
    <SettingsScreen
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="settings" dialogContent>
          {shell ? (
            <box flexDirection="row">
              <text fg={theme.ACCENT} onMouseDown={() => shell.openHarness()}>
                Live harness · [⌃G]
              </text>
              <text fg={theme.MUTED}>{"   "}</text>
              <text fg={theme.ACCENT} onMouseDown={() => shell.openKeybindings()}>
                Keybindings · [⌃K]
              </text>
            </box>
          ) : null}
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
    />
  );
}

/**
 * Routes the keybinding editor, supplying the console shell around it. Mirrors
 * `SettingsRoute`: the editor takes the frame as a prop so it does not import
 * this module. Like the settings screen, no command palette is mounted — the
 * screen captures raw chords, and a second `useKeyboard` competing for them
 * would make capture ambiguous.
 */
function KeybindingsRoute({ onExit, shell }: { onExit: () => void; shell?: ShellNav }) {
  return (
    <KeybindingsEditorScreen
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="keybindings" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
    />
  );
}

function HarnessRoute({ onBack }: { onBack: () => void }) {
  const { width } = useSurfaceDimensions();
  return (
    <ShellFrame view="Live harness" dialogContent>
      <HarnessControlsPanel contentWidth={Math.max(1, width - 4)} onBack={onBack} />
    </ShellFrame>
  );
}

/**
 * Routes the agent-herd overview, supplying the console shell around it.
 *
 * The active audit supplies its worker snapshot, parent identity and mailbox
 * namespace. Peer discovery remains separate from worker lifecycle ownership.
 */
function HerdRoute({ onExit, shell, parentScanId, readAgents, messagingHomeDir }: {
  onExit: () => void;
  shell?: ShellNav;
  parentScanId?: string;
  readAgents?: () => Readonly<HerdSubagentMap>;
  messagingHomeDir?: string;
}) {
  return (
    <HerdScreen
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="herd" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
      parentScanId={parentScanId}
      readAgents={readAgents}
      messagingHomeDir={messagingHomeDir}
    />
  );
}

/**
 * Routes the Agents Comms view — the live fleet of sub-agents plus the stream
 * of inter-agent messages — supplying the console shell around it.
 *
 * The active audit's mounted ChatScreen owns the live subagent map, handed here
 * through the SAME `readAgents` handle the herd overview reads. The message
 * stream and measured telemetry come off the event bus, which the screen
 * subscribes to itself, so nothing extra has to be threaded down.
 */
function AgentsCommsRoute({ onExit, shell, readAgents }: {
  onExit: () => void;
  shell?: ShellNav;
  readAgents?: () => Readonly<HerdSubagentMap>;
}) {
  return (
    <AgentsCommsScreen
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="comms" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
      readAgents={readAgents}
    />
  );
}

/** Select a future runtime without reconstructing the always-mounted live session. */
function ModelRoute({
  currentModel,
  providerId,
  codexCatalog,
  agentModels,
  singleModel,
  onAgentModelsChange,
  onSingleModelChange,
  onSelect,
  onExit,
  shell,
}: {
  currentModel?: string;
  providerId?: string;
  codexCatalog?: (signal?: AbortSignal) => Promise<import("@0/core").CodexCatalogModel[]>;
  agentModels?: ChatScreenOptions["agentModels"];
  singleModel?: boolean;
  onAgentModelsChange: (map: NonNullable<ChatScreenOptions["agentModels"]>) => void;
  onSingleModelChange: (enabled: boolean) => void;
  onSelect: (model: string, providerId?: ChatScreenOptions["providerId"]) => void;
  onExit: () => void;
  shell?: ShellNav;
}) {
  return (
    <ModelScreen
      currentModel={currentModel}
      providerId={providerId}
      codexCatalog={codexCatalog}
      agentModels={agentModels}
      singleModel={singleModel}
      onAgentModelsChange={onAgentModelsChange}
      onSingleModelChange={onSingleModelChange}
      onSelect={onSelect}
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="models" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
    />
  );
}

/**
 * Routes the full-screen resume browser. Unlike ModelRoute it does NOT add a
 * FooterBar — ResumeScreen renders its own footer/status lines — so ShellFrame
 * supplies only the header + canvas. Picking a session reopens the chat around
 * that stored transcript (openChat's initialMessages → ChatScreen mount-restore);
 * delete removes the file (the screen hides the row locally).
 */
function ResumeRoute({ onResume, protectedSessionIds, currentId, onExit, shell }: {
  onResume: (id: string) => boolean;
  protectedSessionIds: ReadonlySet<string>;
  currentId?: string;
  onExit: () => void;
  shell?: ShellNav;
}) {
  const theme = useTheme();
  return (
    <ShellFrame view="resume" dialogContent>
      <ResumeScreen
        sessions={listSessions(undefined, { limit: 50 })}
        currentId={currentId}
        protectedSessionIds={protectedSessionIds}
        currentCwd={process.cwd()}
        now={Date.now()}
        theme={theme}
        onResume={onResume}
        onDelete={(id) => deleteSession(id, undefined, { protectedIds: protectedSessionIds })}
        onBack={() => leaveCurrentScreen(shell, onExit)}
        onExit={onExit}
      />
    </ShellFrame>
  );
}

/**
 * Routes the marketplace browser, supplying the console shell around it.
 *
 * Like `SettingsRoute` and `ModelRoute`, the command palette is deliberately not
 * mounted here: every printable key on this screen filters the list, so a second
 * `useKeyboard` competing for those keystrokes would fight the filter. The
 * registry URL, install action and installed-state read are left at their
 * defaults — `MarketScreen` resolves `$ZERO_REGISTRY_URL` (empty by default) and
 * reuses the core install APIs — so this route is pure wiring and stays honest
 * with no endpoint configured.
 */
function MarketRoute({ onExit, shell, pluginHostManager }: { onExit: () => void; shell?: ShellNav; pluginHostManager?: SessionPluginHostManager }) {
  // The registry URL and the service that installs/enables/runs against it are
  // resolved together so the screen's empty-state URL and the service's fetch
  // target never diverge. The service is the ONE bridge to the plugin
  // machinery: install writes bytes, enable records approval, run loads via the
  // host, and a theme activate hands off to the theme setting. Built once so a
  // load host persists for the life of the overlay.
  const registryUrl = React.useMemo(
    // Unset → the default Hackstore index. An explicitly-set value (even empty)
    // is honoured verbatim, so `ZERO_REGISTRY_URL=` stays a deliberate "no
    // store" rather than silently reverting to the default.
    () => {
      const override = process.env["ZERO_REGISTRY_URL"];
      return (override !== undefined ? override : DEFAULT_REGISTRY_URL).trim();
    },
    [],
  );
  const service = React.useMemo(
    // Route ENABLE/RUN through the shell's plugin-host manager (when present) so
    // changed enablement is prepared for new audits while existing runtimes
    // retain their approved leases. Without a manager, the service owns only
    // this overlay's host.
    () =>
      createPluginService({
        registryUrl,
        pluginHostManager,
        isTurnActive: () => false,
        // Same reserved set the manager loads with, so the market's own
        // list/enable rejects a built-in-shadowing plugin instead of showing it
        // "enabled" for a plugin the host will refuse to load.
        reservedToolNames: Object.keys(TOOL_DEFINITIONS),
      }),
    [registryUrl, pluginHostManager],
  );
  return (
    <MarketScreen
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      registryUrl={registryUrl}
      service={service}
      frame={({ body, hint }) => (
        <ShellFrame view="marketplace" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
    />
  );
}

/**
 * Routes the provider connect / login screen, supplying the console shell.
 *
 * Pure wiring, like `ModelRoute` and `MarketRoute`: `ConnectScreen` reads and
 * writes credentials through the existing credential store on its own, so this
 * route hands it only a frame and the two ways out. The command palette is
 * deliberately not mounted here — every printable key on this screen filters
 * the provider list (or, in the input sub-step, is part of a pasted key), so a
 * second `useKeyboard` would fight it.
 */
function ConnectRoute({
  onExit,
  shell,
  recovery,
  onConnected,
}: {
  onExit: () => void;
  shell?: ShellNav;
  recovery?: ConnectionRecovery;
  onConnected?: (providerId: string) => void;
}) {
  return (
    <ConnectScreen
      recovery={recovery}
      onConnected={onConnected}
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="connect" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
    />
  );
}

/**
 * Routes the session-usage report, supplying the console shell around it.
 *
 * Pure wiring, like `ModelRoute` and `ConnectRoute`. The snapshot is built from
 * the chat options the router already holds — today only the active model, which
 * lets the report name the model and provider and price the session against it.
 * The live token / context counts live in `ChatScreen`'s own state and are not
 * reachable from this overlay (`ConsoleApp` renders one route at a time and the
 * chat is deaf beneath it), so they are left `undefined` and the screen shows
 * `—` for them rather than a fabricated zero — the same honesty rule the status
 * bar obeys. The one-line chat-composer `case "usage"` (see the follow-up note)
 * is what will later hand the real counts across at navigation time.
 */
function UsageRoute({
  chatOptions,
  onExit,
  shell,
}: {
  chatOptions?: ChatScreenOptions;
  onExit: () => void;
  shell?: ShellNav;
}) {
  return (
    <UsageScreen
      usage={{ model: chatOptions?.model }}
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="usage" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
    />
  );
}

/**
 * Routes the finding-detail view, supplying the console shell around it.
 *
 * Detail stays a read surface. Its investigation and remediation-planning
 * actions return to the persistent chat, where the normal scope and approval
 * gates apply. A source patch is never applied from this overlay.
 */
function FindingDetailRoute({
  findingId,
  finding,
  chatOptions,
  onExit,
  onInvestigate,
  onPlanFix,
  shell,
}: {
  findingId?: string;
  finding?: Finding;
  chatOptions?: ChatScreenOptions;
  onExit: () => void;
  onInvestigate?: (finding: Finding) => void;
  onPlanFix?: (finding: Finding) => void;
  shell?: ShellNav;
}) {
  const [resolved, setResolved] = useState<Finding | undefined>(finding);

  useEffect(() => {
    if (finding) {
      setResolved(finding);
      return;
    }
    if (!findingId) return;
    let alive = true;
    void (async () => {
      try {
        const focus = loadFindingFocus(findingId, { dbPath: chatOptions?.dbPath });
        if (alive) setResolved(focus.finding);
      } catch {
        // Leave unresolved; the screen shows its honest empty state.
      }
    })();
    return () => {
      alive = false;
    };
  }, [finding, findingId, chatOptions?.dbPath]);

  return (
    <FindingDetailScreen
      finding={resolved}
      findingId={findingId}
      onInvestigate={onInvestigate}
      onPlanFix={onPlanFix}
      onCopyReport={(_finding, markdown) => {
        void copyToClipboard(markdown, { spawn: defaultSpawn, which: defaultWhich });
      }}
      onBack={() => leaveCurrentScreen(shell, onExit)}
      onExit={onExit}
      frame={({ body, hint }) => (
        <ShellFrame view="finding" dialogContent>
          {body}
          <FooterBar hint={hint} />
        </ShellFrame>
      )}
    />
  );
}

type AppMode =
  | { type: "console"; initialRoute: ConsoleRoute; onResolve?: (selection: HomeSelection) => void; onExit: () => void }
  | { type: "session"; initialState: SessionState; subscribe: (listener: (state: SessionState) => void) => () => void; queueUserMessage?: (text: string) => void; onExit: () => void };

function AuditRoute({ render, onBack }: { render: (width: number, rows: number) => React.ReactNode; onBack: () => void }) {
  const { width, height } = useSurfaceDimensions();
  useKeyboard((key) => {
    if (key.name !== "escape") return;
    key.preventDefault();
    key.stopPropagation();
    onBack();
  });
  return <ShellFrame view="audits">{render(Math.max(1, width - SHELL_HORIZONTAL_PADDING * 2), Math.max(1, height - getShellChromeHeight(width)))}<FooterBar hint="Esc back · Ctrl+Alt+N new audit" /></ShellFrame>;
}
function ConsoleApp({
  initialRoute,
  onResolve,
  onExit,
  lensEvolution,
}: {
  initialRoute: ConsoleRoute;
  onResolve?: (selection: HomeSelection) => void;
  onExit: () => void;
  lensEvolution?: TuiLensEvolutionController;
}) {
  const { width: terminalWidth, height: terminalHeight } = useSurfaceDimensions();
  const initialChatOptions = initialRoute.type === "chat" ? initialRoute.options : undefined;
  const workspaceRef = useRef<AuditWorkspace | null>(null);
  if (!workspaceRef.current) workspaceRef.current = new AuditWorkspace(initialChatOptions);
  const workspace = workspaceRef.current;
  const rootRoute: ConsoleRoute = { type: "chat", auditId: workspace.selectedId };
  const [routes, setRoutes] = useState<ConsoleRoute[]>(() =>
    initialRoute.type === "chat" ? [rootRoute] : [rootRoute, { ...initialRoute, auditId: workspace.selectedId }]);
  const [routeIndex, setRouteIndex] = useState(() => initialRoute.type !== "chat" ? 1 : 0);
  const [lensEvolutionState, setLensEvolutionState] = useState<TuiLensEvolutionStatus | undefined>(
    () => lensEvolution?.getStatus(),
  );
  useEffect(() => {
    if (!lensEvolution) {
      setLensEvolutionState(undefined);
      return;
    }
    setLensEvolutionState(lensEvolution.getStatus());
    return lensEvolution.subscribe(setLensEvolutionState);
  }, [lensEvolution]);

  const [, forceVersion] = useState(0);
  useEffect(() => workspace.subscribe(() => forceVersion((n) => n + 1)), [workspace]);
  const records = workspace.records;
  const selectedId = workspace.selectedId;
  const selectedRecord = workspace.selected;
  // Link the herdr pane to the selected audit's agent session so herdr can tie
  // the pane to a 0 session (its lifecycle signal). Re-links whenever the
  // selected session changes (a new/resumed audit). No-op off-herdr, fail-soft.
  const selectedScanId = selectedRecord?.session?.scanId;
  useEffect(() => {
    if (!selectedScanId) return;
    reportHerdrSession({ sessionId: selectedScanId });
  }, [selectedScanId]);
  const [workspaceRoot] = useState(() => process.cwd());
  const [shellError, setShellError] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const exitRequested = useRef(false);
  const creations = useRef(new Set<Promise<AuditRecord | undefined>>());
  const openingSessions = useRef(new Map<string, Promise<AuditRecord | undefined>>());
  const legacyLaunches = useRef(new Map<ReturnType<typeof createSessionCloseGate>, Promise<void>>());
  const navigationEpoch = useRef(0);
  const reportError = (error: unknown) => setShellError(error instanceof Error ? error.message : String(error));
  const currentRoute = routes[routeIndex] ?? rootRoute;
  const routeOwner = currentRoute.type === "chat" ? selectedRecord : workspace.get(currentRoute.auditId);
  const showChat = (id = workspace.selectedId) => {
    if (exitRequested.current) return;
    navigationEpoch.current++;
    if (id) workspace.select(id);
    const closing = workspace.get(id)?.closeRequested;
    setRoutes(closing ? [{ type: "chat", auditId: id }, { type: "audits", auditId: id }] : [{ type: "chat", auditId: id }]);
    setRouteIndex(closing ? 1 : 0);
  };
  const requestExit = (selection?: HomeSelection) => {
    if (exitRequested.current) return;
    exitRequested.current = true;
    setClosingAll(true);
    // Release this pane's herdr agent slot on the way out so the sidebar stops
    // showing 0's stale state/topic. Fire-and-forget and fail-soft.
    reportHerdrSessionClose();
    appendTuiEvent({ kind: "shutdown", stage: "requested", audits: creations.current.size });
    for (const gate of legacyLaunches.current.keys()) gate.close();
    const sessionClosures = routes.filter((route) => route.type === "session")
      .map((route) => Promise.resolve().then(() => route.type === "session" ? route.onClose() : undefined));

    // Absolute guarantee the operator is never trapped on the "Stopping
    // audits…" screen: a wedged close, a plugin dispose that hangs, or a
    // lingering open handle (herdr child, browser/proxy server, a timer) that
    // keeps the event loop alive after teardown can all defeat a graceful
    // exit. This watchdog force-terminates the process after a hard deadline,
    // restoring the terminal first (leave the alternate screen, show the
    // cursor). `unref()` means it never keeps a healthy process alive — it only
    // fires if we are still running when the deadline hits.
    const HARD_EXIT_MS = 12000;
    const watchdog = setTimeout(() => {
      appendTuiEvent({ kind: "shutdown", stage: "watchdog-force-exit", afterMs: HARD_EXIT_MS });
      try { process.stdout.write("\x1b[?1049l\x1b[?25h"); } catch { /* best-effort terminal restore */ }
      process.exit(0);
    }, HARD_EXIT_MS);
    if (typeof watchdog.unref === "function") watchdog.unref();

    const withTimeout = <T,>(p: Promise<T>, ms: number, tag: string): Promise<T | "timeout"> =>
      Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))])
        .then((v) => { if (v === "timeout") appendTuiEvent({ kind: "shutdown", stage: `${tag}-timeout`, ms }); return v; });

    const cleanupAll = Promise.allSettled([workspace.closeAll(), ...creations.current, ...legacyLaunches.current.values(), ...sessionClosures]);
    void withTimeout(cleanupAll, 8000, "cleanup").then(async (outcome) => {
      appendTuiEvent({ kind: "shutdown", stage: "cleanup-settled", timedOut: outcome === "timeout" });
      if (outcome !== "timeout") {
        const failures = outcome.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        // A failed audit close is logged, not fatal: the operator asked to
        // leave, so a broken teardown must not cancel the exit and re-trap them.
        if (failures.length > 0) {
          appendTuiEvent({ kind: "shutdown", stage: "cleanup-failures", count: failures.length, reasons: failures.map((f) => String(f.reason)).slice(0, 5) });
        }
      }
      // Plugin dispose is bounded too — never `await` an unresolved prep
      // forever (that was a real trap: the cleanup timeout did not cover it).
      try {
        const prep = pluginPreparation.current?.catch(() => null) ?? Promise.resolve(null);
        const manager = await withTimeout(prep, 2000, "plugin-dispose");
        if (manager && manager !== "timeout") manager.dispose();
      } catch { /* dispose is best-effort on the way out */ }
      appendTuiEvent({ kind: "shutdown", stage: "onExit" });
      if (selection && onResolve) onResolve(selection);
      onExit();
      appendTuiEvent({ kind: "shutdown", stage: "onExit-returned" });
      clearTimeout(watchdog);
      // The terminal is restored and every reachable resource is drained. A
      // deliberately-abandoned cleanup (a wedged engine candidate we timed out
      // on) can still hold an open handle that keeps Node alive well past the
      // point the operator's shell should be back. Force a prompt exit; unref
      // so a genuinely-clean process still exits on its own first.
      const promptExit = setTimeout(() => {
        appendTuiEvent({ kind: "shutdown", stage: "prompt-exit" });
        process.exit(0);
      }, 250);
      if (typeof promptExit.unref === "function") promptExit.unref();
    }).catch((error) => {
      // Even an unexpected error in the shutdown chain must not strand the
      // operator: log it and force the exit rather than re-arming the screen.
      appendTuiEvent({ kind: "shutdown", stage: "error-forcing-exit", error: String(error) });
      try { process.stdout.write("\x1b[?1049l\x1b[?25h"); } catch { /* best-effort */ }
      clearTimeout(watchdog);
      process.exit(0);
    });
  };
  const appExit = () => requestExit();
  const createAudit = (source = workspace.selected, overrides?: ChatScreenOptions, sourceSessionId?: string) => {
    const base = { ...(source?.options ?? initialChatOptions) };
    delete base.initialMessages;
    delete base.initialPrompt;
    delete base.mcpHost;
    const runtime = source?.runtimeInfo.current;
    const options: ChatScreenOptions = {
      ...base,
      ...(runtime ? { model: runtime.model(), providerId: runtime.providerId() as ChatScreenOptions["providerId"] } : {}),
      ...source?.nextOptions,
      ...overrides,
    };
    const creation = (async (): Promise<AuditRecord | undefined> => {
      if (exitRequested.current) return undefined;
      const mcpHost = await connectMcpServers(parseMcpConfig(process.env["ZERO_MCP"]));
      if (exitRequested.current || !appAlive.current) {
        await mcpHost?.closeAll();
        return undefined;
      }
      try {
        return workspace.create({ ...options, mcpHost: mcpHost ?? undefined }, sourceSessionId, false);
      } catch (error) {
        await mcpHost?.closeAll();
        throw error;
      }
    })();
    creations.current.add(creation);
    void creation.then(() => creations.current.delete(creation), () => creations.current.delete(creation));
    return creation;
  };
  const openCreatedAudit = (creation: Promise<AuditRecord | undefined>) => {
    const requestedAt = ++navigationEpoch.current;
    void creation.then((record) => {
      if (record && requestedAt === navigationEpoch.current) showChat(record.id);
    }, reportError);
  };
  const openNewAudit = () => {
    openCreatedAudit(createAudit(routeOwner));
  };
  const closeAudit = (id: string) => {
    if (exitRequested.current) return;
    const closing = workspace.close(id);
    if (workspace.selectedId === id) {
      const next = workspace.records.find((record) => record.id !== id && !record.closeRequested);
      if (next) showChat(next.id);
      else navigate({ type: "audits", auditId: id });
    }
    const requestedAt = navigationEpoch.current;
    void closing.then(() => {
      if (requestedAt === navigationEpoch.current) showChat();
    }, reportError);
  };
  const resumeAudit = (id: string): boolean => {
    if (exitRequested.current) return false;
    const live = workspace.findSession(id);
    if (live) { showChat(live.id); return true; }
    const opening = openingSessions.current.get(id);
    if (opening) { openCreatedAudit(opening); return true; }
    const stored = loadSession(id);
    if (!stored) return false;
    workspace.protectedSessionIds.add(id);
    const creation = createAudit(routeOwner, {
      model: stored.model ?? routeOwner?.options?.model,
      target: stored.target ?? routeOwner?.options?.target,
      initialMessages: stored.messages as ChatScreenOptions["initialMessages"],
    }, id);
    openingSessions.current.set(id, creation);
    openCreatedAudit(creation);
    const releaseOpening = () => {
      openingSessions.current.delete(id);
      if (!workspace.findSession(id)) workspace.protectedSessionIds.delete(id);
    };
    void creation.then(releaseOpening, releaseOpening);
    return true;
  };

  // Workspace shortcuts remain available when either audit panel is collapsed.
  useKeyboard((key) => {
    if (closingAll || (currentRoute.type !== "chat" && currentRoute.type !== "audits")) return;
    if (!key.ctrl || !(key.option || key.meta) || !["up", "down", "n", "w"].includes(key.name)) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "n") openNewAudit();
    else if (key.name === "w") {
      if (selectedRecord && !selectedRecord.closeRequested) closeAudit(selectedRecord.id);
    } else if (records.length > 0) {
      const index = records.findIndex((record) => record.id === selectedId);
      const next = index < 0 ? 0 : (index + (key.name === "up" ? -1 : 1) + records.length) % records.length;
      showChat(records[next].id);
    }
  });
  const stageHarnessPrompt = (text: string) => {
    const owner = workspace.get(routeOwner?.id);
    if (!owner || owner.closeRequested || !owner.stagePrompt.current) { reportError("This audit is not ready for input."); return; }
    owner.stagePrompt.current(text);
    showChat(owner.id);
  };
  // Marketplace hosts belong to the shell; each session leases its initial
  // approved tool set. Refresh prepares the next chat without rebuilding this one.
  const [pluginHostManager, setPluginHostManager] = useState<SessionPluginHostManager | null>(null);
  const [pluginHostReady, setPluginHostReady] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const pluginPreparation = useRef<Promise<SessionPluginHostManager> | null>(null);
  const appAlive = useRef(true);
  useEffect(() => {
    appAlive.current = true;
    return () => { appAlive.current = false; };
  }, []);
  useEffect(() => {
    if (exitRequested.current) return;
    let disposed = false;
    let created: SessionPluginHostManager | undefined;
    const preparation = createSessionPluginHostManager({ reservedToolNames: Object.keys(TOOL_DEFINITIONS) });
    pluginPreparation.current = preparation;
    void preparation.then((mgr) => {
        if (disposed) {
          mgr.dispose();
          return;
        }
        created = mgr;
        setPluginHostManager(mgr);
        setPluginHostReady(true);
      })
      .catch((error) => {
        if (disposed) return;
        setPluginError(`Marketplace tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
        setPluginHostReady(true);
      });
    return () => {
      disposed = true;
      created?.dispose();
    };
  }, []);


  const navigate = (route: ConsoleRoute) => {
    if (exitRequested.current) return;
    navigationEpoch.current++;
    const captured = { ...route, auditId: route.auditId ?? routeOwner?.id ?? selectedId };
    setRoutes((current) => {
      const next = [...current.slice(0, routeIndex + 1), captured];
      setRouteIndex(next.length - 1);
      return next;
    });
  };
  const ownerForAction = () => {
    const owner = workspace.get(currentRoute.type === "chat" ? selectedId : currentRoute.auditId);
    if (exitRequested.current || !owner || owner.closeRequested) {
      reportError("The audit that opened this screen is no longer available.");
      return undefined;
    }
    return owner;
  };
  const stageNext = (selection: Parameters<AuditRecord["onNextOptions"]>[0]) => {
    const owner = ownerForAction();
    if (!owner) return false;
    owner.onNextOptions(selection);
    return true;
  };
  // Apply a selection LIVE to the audit's running runtime, and always stage it
  // so /new inherits it too. `applySelection` is a no-op that returns false when
  // the audit has no live session yet, leaving `stageNext` as the sole effect.
  const applyOrStage = (selection: Parameters<AuditRecord["onNextOptions"]>[0]) => {
    const owner = ownerForAction();
    if (!owner) return false;
    owner.onNextOptions(selection);
    owner.applySelection(selection);
    return true;
  };
  const shell: ShellNav = {
    canGoBack: routeIndex > 0,
    canGoForward: routeIndex < routes.length - 1,
    goBack: () => { navigationEpoch.current++; setRouteIndex((current) => Math.max(0, current - 1)); },
    goForward: () => { navigationEpoch.current++; setRouteIndex((current) => Math.min(routes.length - 1, current + 1)); },
    openChat: (options) => {
      if (options?.initialMessages !== undefined || options?.initialPrompt) {
        openCreatedAudit(createAudit(routeOwner, options));
        return;
      }
      if (options) stageNext({
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options.agentModels !== undefined ? { agentModels: options.agentModels } : {}),
        ...(options.singleModel !== undefined ? { singleModel: options.singleModel } : {}),
      });
      showChat(routeOwner?.id);
    },
    openNewChat: openNewAudit,
    openLauncher: () => navigate({ type: "launcher" }),
    openOps: () => navigate({ type: "ops", dbPath: routeOwner?.options?.dbPath, refreshMs: 4000 }),
    openDoctor: () => navigate({ type: "doctor" }),
    openHistory: () => navigate({ type: "history", dbPath: routeOwner?.options?.dbPath, limit: 12 }),
    openFindings: () => navigate({ type: "findings", options: { dbPath: routeOwner?.options?.dbPath, limit: 50 } }),
    openReplay: (scanId) => navigate({ type: "replay", dbPath: routeOwner?.options?.dbPath, scanId }),
    openSettings: () => navigate({ type: "settings" }),
    openKeybindings: () => navigate({ type: "keybindings" }),
    openHarness: () => navigate({ type: "harness" }),
    openModels: (chatOpts) => navigate({ type: "models", chatOptions: chatOpts ?? routeOwner?.options }),
    openResume: (chatOpts) => navigate({ type: "resume", chatOptions: chatOpts ?? routeOwner?.options }),
    openHerd: () => navigate({ type: "herd" }),
    openComms: () => navigate({ type: "comms" }),
    openMarket: () => navigate({ type: "market" }),
    openConnect: () => navigate({ type: "connect", recovery: routeOwner?.recovery }),
    openOnboarding: () => navigate({ type: "onboard" }),
    openUsage: (chatOpts) => navigate({ type: "usage", chatOptions: chatOpts ?? routeOwner?.options }),
    openFindingDetail: (findingId, finding, chatOpts) =>
      navigate({ type: "finding", findingId, finding, chatOptions: chatOpts ?? routeOwner?.options }),
  };
  const chatPaneActions: Record<Exclude<ChatDestination, "finding">, () => void> = {
    launcher: shell.openLauncher,
    ops: shell.openOps,
    history: shell.openHistory,
    findings: shell.openFindings,
    doctor: shell.openDoctor,
    replay: shell.openReplay,
    settings: shell.openSettings,
    keybindings: shell.openKeybindings,
    harness: shell.openHarness,
    "new-chat": openNewAudit,
    models: () => shell.openModels(selectedRecord?.options),
    market: shell.openMarket,
    usage: () => shell.openUsage(selectedRecord?.options),
    connect: shell.openConnect,
    herd: shell.openHerd,
    comms: shell.openComms,
    resume: () => shell.openResume(selectedRecord?.options),
    audits: () => navigate({ type: "audits" }),
    onboard: () => navigate({ type: "onboard" }),
  };

  const launchSelection = (selection: HomeSelection): Promise<void> => {
    const target = selection.target;
    if (exitRequested.current || !target) return Promise.resolve();
    const sessionGate = createSessionCloseGate();
    const launch: Promise<void> = Promise.resolve().then(async () => {
      if (exitRequested.current) return;
      const resolution = resolveEngagement(target);
      if (!resolution.ok) return;
      const plan = resolution.plan;
      const mode: SessionMode = plan.kind === "package"
        ? "audit"
        : plan.kind === "source"
          ? "review"
          : "scan";
      const depth = selection.depth ?? "deep";
      const runtime = selection.runtime ?? "auto";
      const availability = await getRuntimeAvailability();
      if (exitRequested.current) return;
      let state = createInitialSessionState(plan.target, depth, mode, {
        runtime,
        apiProviderLabel: availability.apiRuntime.providerLabel,
        apiConfigured: availability.apiRuntime.configured,
        apiConnected: availability.hasApiKey && availability.apiRuntime.valid,
        localRuntimes: availability.availableRuntimes,
      });
      const listeners = new Set<(value: SessionState) => void>();
      const subscribe = (listener: (value: SessionState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const emit = () => {
        for (const listener of listeners) listener(state);
      };
      navigate({
        type: "session",
        initialState: state,
        subscribe,
        onClose: () => {
          const newlyClosed = sessionGate.close();
          if (newlyClosed && !exitRequested.current) shell.goBack();
          return launch;
        },
      });

      const previousStartupLogSetting = process.env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"];
      const previousNativeTracePath = process.env["ZERO_TRACE_NATIVE_RESPONSES"];
      const previousTuiTracePath = process.env["ZERO_TRACE_TUI_EVENTS"];
      try {
        process.env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"] = "1";
        process.env["ZERO_TRACE_NATIVE_RESPONSES"] = `/tmp/0-native-responses-${Date.now()}.ndjson`;
        process.env["ZERO_TRACE_TUI_EVENTS"] = `/tmp/0-tui-events-${Date.now()}.ndjson`;
        appendTuiTrace({
          kind: "session-start",
          target: plan.target,
          mode,
          runtime,
          depth,
          nativeTrace: process.env["ZERO_TRACE_NATIVE_RESPONSES"],
        });
        await runUnified({
          target: plan.target,
          targetType: plan.targetType,
          reviewPackageEcosystem: plan.ecosystem,
          depth,
          format: "terminal",
          runtime,
          timeout: plan.kind === "web" ? 30000 : 600000,
          verbose: false,
          sessionUiFactory: async () => ({
            onEvent: (event) => {
              if (sessionGate.closed) return;
              appendTuiTrace({ kind: "session-event", event });
              try {
                state = applySessionEvent(state, event);
                appendTuiTrace({
                  kind: "session-state",
                  usage: state.usage,
                  thinking: state.thinking,
                  lastTranscript: state.transcript.at(-1)?.text,
                  transcriptCount: state.transcript.length,
                });
                emit();
                appendTuiTrace({ kind: "session-emit-complete", transcriptCount: state.transcript.length });
              } catch (error) {
                appendTuiCrash({
                  source: "session-onEvent",
                  event,
                  state: {
                    thinking: state.thinking,
                    usage: state.usage,
                    transcriptCount: state.transcript.length,
                    lastTranscript: state.transcript.at(-1)?.text,
                  },
                  error: serializeError(error),
                });
                throw error;
              }
            },
            setReport: (report) => {
              if (sessionGate.closed) return;
              try {
                state = applySessionReport(state, report);
                appendTuiTrace({ kind: "session-report", summary: state.summary, transcriptCount: state.transcript.length });
                emit();
              } catch (error) {
                appendTuiCrash({
                  source: "session-setReport",
                  report,
                  error: serializeError(error),
                });
                throw error;
              }
            },
            waitForExit: () => {
              if (exitRequested.current) sessionGate.close();
              return sessionGate.wait();
            },
          }),
        });
      } finally {
        if (previousStartupLogSetting === undefined) delete process.env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"];
        else process.env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"] = previousStartupLogSetting;
        if (previousNativeTracePath === undefined) delete process.env["ZERO_TRACE_NATIVE_RESPONSES"];
        else process.env["ZERO_TRACE_NATIVE_RESPONSES"] = previousNativeTracePath;
        if (previousTuiTracePath === undefined) delete process.env["ZERO_TRACE_TUI_EVENTS"];
        else process.env["ZERO_TRACE_TUI_EVENTS"] = previousTuiTracePath;
      }
    }).finally(() => {
      sessionGate.close();
      legacyLaunches.current.delete(sessionGate);
    });
    legacyLaunches.current.set(sessionGate, launch);
    return launch;
  };

  // The chat remains mounted beneath overlays, preserving each conversation.
  const routeType = currentRoute.type;
  const overlayActive = routeType !== "chat";
  const appContext = useContext(AppContext);
  const evolutionStatus = lensEvolutionState
    ? tuiLensEvolutionStatusLabel(lensEvolutionState)
    : undefined;
  const theme = useTheme();
  const renderAuditSwitcher = (width: number, rows: number) => (
    <AuditSwitcher records={records} selectedAuditId={selectedId} onSelect={showChat}
      onCreate={openNewAudit} onClose={closeAudit} width={width} rows={rows} theme={theme} />
  );

  // ── Audit chat screens ──
  // Each audit has its own HarnessProvider and gated AppContext.Provider.
  // Only the selected audit is interactive; hidden audits are zero-sized and
  // non-interactive, keeping React state alive without accepting input.
  const auditPanels = records.length > 0 ? (
    records.map((record) => {
      const isSelected = record.id === selectedId;
      const interactive = isSelected && !overlayActive && !closingAll && !record.closeRequested;
      return (
        <box
          key={record.id}
          position="absolute"
          top={0}
          left={0}
          width={isSelected ? "100%" : 0}
          height={isSelected ? "100%" : 0}
          overflow="hidden"
          zIndex={isSelected ? 1 : 0}
        >
          <HarnessProvider
            host={record.session?.harness ?? null}
            busy={record.busy || record.stopping}
            workspaceRoot={workspaceRoot}
            stagePrompt={(text: string) => record.stagePrompt.current?.(text)}
          >
            <AppContext.Provider
              value={interactive ? appContext : { ...appContext, keyHandler: null }}
            >
              {pluginHostReady && (record.closeHandle.current !== null || (!record.closeRequested && !closingAll)) ? (
                <ChatScreen
                  options={record.options}
                  interactive={interactive}
                  messagingHomeDir={record.messagingHomeDir}
                  protectedSessionIds={workspace.protectedSessionIds}
                  onAuditActivity={record.onActivity}
                  closeHandle={record.closeHandle}
                  herdHandle={record.herd}
                  runtimeInfoHandle={record.runtimeInfo}
                  submitHandle={record.submit}
                  stagePromptHandle={record.stagePrompt}
                  reconnectHandle={record.reconnect}
                  onSessionChange={record.onSessionChange}
                  onWorkingChange={record.onWorkingChange}
                  onNextChatOptions={record.onNextOptions}
                  renderAuditSwitcher={renderAuditSwitcher}
                  pluginHostManager={pluginHostManager ?? undefined}
                  evolutionStatus={evolutionStatus}
                  onGoBack={shell.goBack}
                  onNavigate={(destination, id) => {
                    if (exitRequested.current || record.id !== workspace.selectedId) return;
                    if (destination === "finding") {
                      shell.openFindingDetail(id, undefined, record.options);
                      return;
                    }
                    if (destination === "audits") {
                      navigate({ type: "audits", auditId: record.id });
                      return;
                    }
                    if (destination === "onboard") {
                      navigate({ type: "onboard" });
                      return;
                    }
                    chatPaneActions[destination]();
                  }}
                  onConnectionFailure={(recovery) => {
                    record.recovery = recovery;
                    record.onActivity({ waiting: true });
                    if (record.id === workspace.selectedId) navigate({ type: "connect", recovery, auditId: record.id });
                  }}
                  onExit={appExit}
                />
              ) : (
                <box flexDirection="column">
                  <text fg={record.outcome === "failed" ? theme.ERROR : theme.MUTED}>{record.closing || closingAll ? "Closing audit…" : record.outcome === "failed" ? "Audit cleanup failed. Retry closing this audit." : "Preparing approved tools…"}</text>
                  {isSelected && !overlayActive ? renderAuditSwitcher(terminalWidth, Math.max(1, terminalHeight - 1)) : null}
                </box>
              )}
            </AppContext.Provider>
          </HarnessProvider>
        </box>
      );
    })
  ) : null;

  let onboardingIndex = -1;
  for (let index = routeIndex; index >= 0; index--) {
    if (routes[index]?.type === "onboard") { onboardingIndex = index; break; }
  }
  const onboardingOwner = routes[onboardingIndex]?.auditId;
  const onboarding = onboardingIndex >= 0 ? (
    <OnboardingScreen
      key={`${onboardingOwner}:${onboardingIndex}`}
      interactive={routeType === "onboard" && !closingAll}
      frame={({ body, hint, actions }) => <ShellFrame view="onboarding" dialogContent>{body}{actions}<FooterBar hint={hint} /></ShellFrame>}
      renderConnect={(nav) => (
        <OnboardingSubstep nav={nav}>
        <ConnectScreen
          onConnected={(providerId) => {
            const owner = ownerForAction();
            if (owner) owner.onNextOptions({ providerId: providerId as ChatScreenOptions["providerId"] });
            nav.onDone();
          }}
          onBack={nav.onBack}
          onSkip={nav.onSkip}
          onExit={nav.onExit}
          frame={({ body, hint }) => (
            <ShellFrame view="connect" dialogContent>{body}<FooterBar hint={hint} /></ShellFrame>
          )}
        />
        </OnboardingSubstep>
      )}
      renderModels={(nav) => {
        const sel = routeOwner;
        return (
          <OnboardingSubstep nav={nav}>
          <ModelScreen
            currentModel={sel?.nextOptions.model ?? sel?.runtimeInfo.current?.model() ?? sel?.options?.model}
            providerId={sel?.nextOptions.providerId ?? sel?.runtimeInfo.current?.providerId() ?? sel?.options?.providerId}
            codexCatalog={sel?.runtimeInfo.current?.providerId() === "chatgpt-codex" ? sel.runtimeInfo.current.codexCatalog : undefined}
            agentModels={sel?.nextOptions.agentModels ?? sel?.options?.agentModels}
            singleModel={sel?.nextOptions.singleModel ?? sel?.options?.singleModel}
            onAgentModelsChange={(map) => { applyOrStage({ agentModels: map }); }}
            onSingleModelChange={(enabled) => { applyOrStage({ singleModel: enabled }); }}
            onSelect={(id, providerId) => { applyOrStage({ model: id, ...(providerId ? { providerId } : {}) }); nav.onDone(); }}
            onBack={nav.onBack}
            onSkip={nav.onSkip}
            onExit={nav.onExit}
            frame={({ body, hint }) => (
              <ShellFrame view="models" dialogContent>
                {body}
                <FooterBar hint={hint} />
              </ShellFrame>
            )}
          />
          </OnboardingSubstep>
        );
      }}
      onComplete={() => showChat(onboardingOwner)}
      onDismiss={() => showChat(onboardingOwner)}
      onExit={appExit}
    />
  ) : null;

  let overlay: React.ReactNode = null;
  if (routeType === "audits" || (routeType === "chat" && records.length === 0)) {
    overlay = <AuditRoute onBack={() => showChat()} render={renderAuditSwitcher} />;
  } else if (routeType === "launcher") {
    overlay = (
      <HomeScreen onResolve={(selection) => {
        if (selection.action === "tui") {
          shell.openOps();
          return;
        }
        if (selection.action === "doctor") {
          shell.openDoctor();
          return;
        }
        if (selection.action === "history") {
          shell.openHistory();
          return;
        }
        if (selection.action === "findings") {
          shell.openFindings();
          return;
        }
        if (selection.action === "replay") {
          shell.openReplay();
          return;
        }
        if (onResolve) {
          requestExit(selection);
          return;
        }
        void launchSelection(selection);
      }} onExit={appExit} shell={shell} evolutionStatus={lensEvolutionState} />
    );
  } else if (routeType === "ops") {
    overlay = <OpsScreen dbPath={currentRoute.dbPath} refreshMs={currentRoute.refreshMs} onExit={appExit} shell={shell} />;
  } else if (routeType === "doctor") {
    overlay = <DoctorScreen onExit={appExit} shell={shell} />;
  } else if (routeType === "history") {
    overlay = <HistoryScreen dbPath={currentRoute.dbPath} limit={currentRoute.limit} onExit={appExit} shell={shell} />;
  } else if (routeType === "findings") {
    overlay = <FindingsScreen options={currentRoute.options} onExit={appExit} shell={shell} />;
  } else if (routeType === "session") {
    overlay = <ConsoleSessionRoute route={currentRoute} shell={shell} />;
  } else if (routeType === "replay") {
    overlay = <ReplayScreen dbPath={currentRoute.dbPath} scanId={currentRoute.scanId} onExit={appExit} shell={shell} />;
  } else if (routeType === "settings") {
    overlay = <SettingsRoute onExit={appExit} shell={shell} />;
  } else if (routeType === "keybindings") {
    overlay = <KeybindingsRoute onExit={appExit} shell={shell} />;
  } else if (routeType === "harness") {
    overlay = <HarnessRoute onBack={shell.goBack} />;
  } else if (routeType === "models") {
    const sel = routeOwner;
    overlay = (
      <ModelRoute
        currentModel={sel?.nextOptions.model ?? sel?.runtimeInfo.current?.model() ?? sel?.options?.model}
        providerId={sel?.nextOptions.providerId ?? sel?.runtimeInfo.current?.providerId() ?? sel?.options?.providerId}
        codexCatalog={sel?.runtimeInfo.current?.providerId() === "chatgpt-codex" ? sel.runtimeInfo.current.codexCatalog : undefined}
        agentModels={sel?.nextOptions.agentModels ?? sel?.options?.agentModels}
        singleModel={sel?.nextOptions.singleModel ?? sel?.options?.singleModel}
        onAgentModelsChange={(map) => { applyOrStage({ agentModels: map }); }}
        onSingleModelChange={(enabled) => { applyOrStage({ singleModel: enabled }); }}
        onSelect={(id, providerId) => {
          if (applyOrStage({ model: id, ...(providerId ? { providerId } : {}) })) leaveCurrentScreen(shell, appExit);
        }}
        onExit={appExit}
        shell={shell}
      />
    );
  } else if (routeType === "resume") {
    overlay = <ResumeRoute onResume={resumeAudit} protectedSessionIds={workspace.protectedSessionIds}
      currentId={routeOwner?.session?.scanId ?? routeOwner?.sourceSessionId} onExit={appExit} shell={shell} />;
  } else if (routeType === "herd") {
    const sel = routeOwner;
    overlay = <HerdRoute onExit={appExit} shell={shell} parentScanId={sel?.session?.scanId ?? ""}
      readAgents={sel?.herd.current ?? undefined} messagingHomeDir={sel?.messagingHomeDir} />;
  } else if (routeType === "comms") {
    const sel = routeOwner;
    overlay = <AgentsCommsRoute onExit={appExit} shell={shell} readAgents={sel?.herd.current ?? undefined} />;
  } else if (routeType === "market") {
    overlay = <MarketRoute onExit={appExit} shell={shell} pluginHostManager={pluginHostManager ?? undefined} />;
  } else if (routeType === "connect") {
    overlay = (
      <ConnectRoute
        recovery={currentRoute.recovery}
        onConnected={(providerId) => {
          const owner = ownerForAction();
          if (!owner) return;
          owner.onNextOptions({ providerId: providerId as ChatScreenOptions["providerId"] });
          owner.recovery = undefined;
          owner.onActivity({ waiting: false });
          if (currentRoute.recovery) owner.reconnect.current?.(providerId);
          leaveCurrentScreen(shell, appExit);
        }}
        onExit={appExit}
        shell={shell}
      />
    );
  } else if (routeType === "usage") {
    overlay = <UsageRoute chatOptions={currentRoute.chatOptions} onExit={appExit} shell={shell} />;
  } else if (routeType === "finding") {
    overlay = (
      <FindingDetailRoute
        findingId={currentRoute.findingId}
        finding={currentRoute.finding}
        chatOptions={currentRoute.chatOptions}
        onExit={appExit}
        onInvestigate={(finding) => {
          const owner = ownerForAction();
          if (!owner?.submit.current) { reportError("This audit is not ready for input."); return; }
          owner.submit.current(buildFindingChatPrompt({ finding, target: currentRoute.chatOptions?.target }, "investigate"));
          showChat(owner.id);
        }}
        onPlanFix={(finding) => {
          const owner = ownerForAction();
          if (!owner?.submit.current) { reportError("This audit is not ready for input."); return; }
          owner.submit.current(buildFindingChatPrompt({ finding, target: currentRoute.chatOptions?.target }, "draft_fix"));
          showChat(owner.id);
        }}
        shell={shell}
      />
    );
  }


  // ── Render ──
  const selectedHost = routeOwner?.session?.harness ?? null;
  const selectedBusy = closingAll || (routeOwner?.busy ?? false) || (routeOwner?.stopping ?? false);
  return (
    <AppContext.Provider value={closingAll ? { ...appContext, keyHandler: null } : appContext}>
    <HarnessProvider
      host={selectedHost}
      busy={selectedBusy}
      workspaceRoot={workspaceRoot}
      stagePrompt={stageHarnessPrompt}
    >
    <box flexDirection="column" width="100%" height="100%">
    {/* The visual popup stack lives inside the full-screen box (like the
        shutdown dialog), so pushed sub-popups (levels ≥1) render ABOVE the
        level-0 route/DialogSurface with a sized parent for their absolute
        layout, and only the topmost one is interactive. Route stack = level 0. */}
    <PopupStackProvider>
      <RouteHistoryKeys shell={shell} enabled={!closingAll && routeType !== "onboard"}>
      {pluginError ? <text fg={theme.ERROR} wrapMode="word">{pluginError}</text> : null}
      {shellError ? <text fg={theme.ERROR} wrapMode="word">{shellError}</text> : null}
      {closingAll ? (
        <ShutdownDialog
          auditCount={records.length}
          onForceQuit={() => {
            appendTuiEvent({ kind: "shutdown", stage: "force-quit-button" });
            try { process.stdout.write("\x1b[?1049l\x1b[?25h"); } catch { /* best-effort terminal restore */ }
            process.exit(0);
          }}
        />
      ) : null}
      <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} position="relative" overflow="hidden">
        {auditPanels}
        {onboarding ? (
          <box position="absolute" top={0} left={0} width={routeType === "onboard" ? "100%" : 0}
            height={routeType === "onboard" ? "100%" : 0} overflow="hidden" zIndex={100}>
            <DialogSurface onDismiss={() => { if (!closingAll) showChat(onboardingOwner); }}>
              {onboarding}
            </DialogSurface>
          </box>
        ) : null}
        {overlay ? (
          <DialogSurface onDismiss={closingAll ? undefined : shell.goBack}>
            {SCREENS_WITH_LOCAL_PALETTE[routeType] ? overlay : (
              <PanePalette key={`${routeType}:${currentRoute.auditId ?? ""}`} shell={shell}>{overlay}</PanePalette>
            )}
          </DialogSurface>
        ) : null}
      </box>
      </RouteHistoryKeys>
    </PopupStackProvider>
    </box>
    </HarnessProvider>
    </AppContext.Provider>
  );
}

export function UnifiedApp({
  mode,
  lensEvolution,
}: {
  mode: AppMode;
  lensEvolution?: TuiLensEvolutionController;
}) {
  // Global mouse gate: mirror the `mouseSupport` setting onto the renderer so a
  // single toggle enables/disables all wheel/click behaviour (see mouse.ts).
  // First hook, before any branch, so its order is stable across renders.
  useMouseSupport();
  if (mode.type === "console") return <ConsoleApp initialRoute={mode.initialRoute} onResolve={mode.onResolve} onExit={mode.onExit} lensEvolution={lensEvolution} />;

  const [state, setState] = useState(mode.initialState);
  useEffect(() => mode.subscribe(setState), [mode]);
  return <SessionScreen state={state} onExit={mode.onExit} queueUserMessage={mode.queueUserMessage} />;
}

async function mountApp(mode: AppMode): Promise<void> {
  installTuiCrashHandlers();
  const traceRender = Boolean(process.env["ZERO_TRACE_TUI_RENDER"]);
  suspendProcessPresentationStreamBridge();
  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      // State the fullscreen contract rather than relying on OpenTUI's default:
      // this TUI owns a virtualized alternate-screen viewport, while non-TTY
      // command paths never construct it.
      screenMode: "alternate-screen",
      gatherStats: traceRender,
    });
  } catch (error) {
    resumeProcessPresentationStreamBridge();
    throw error;
  }
  let sampledFrames = 0;
  const traceFrame = () => {
    if (!traceRender || ++sampledFrames % 30 !== 0) return;
    const stats = renderer.getStats();
    appendTuiTrace({
      kind: "tui-render-sample",
      frameId: renderer.frameId,
      fps: stats.fps,
      averageFrameTime: stats.averageFrameTime,
      maxFrameTime: stats.maxFrameTime,
      frameCount: stats.frameCount,
    });
  };
  if (traceRender) renderer.on(CliRenderEvents.FRAME, traceFrame);
  // Claim stdout/stderr only AFTER the renderer exists. opentui saves the
  // real `stdout.write` in its constructor and emits every frame through
  // that saved reference, so installing here leaves rendering untouched
  // and captures just the application-level writes that would otherwise
  // overprint the framebuffer and desynchronize its differential repaint.
  const outputGuard = installTuiOutputGuard();
  const root = createRoot(renderer);
  const lensEvolution = createTuiLensEvolutionController();
  await new Promise<void>((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      appendTuiEvent({ kind: "shutdown", stage: "close-begin" });
      lensEvolution.stop();
      mode.onExit?.();
      if (traceRender) {
        const stats = renderer.getStats();
        appendTuiTrace({
          kind: "tui-render-summary",
          frameId: renderer.frameId,
          fps: stats.fps,
          averageFrameTime: stats.averageFrameTime,
          maxFrameTime: stats.maxFrameTime,
          frameCount: stats.frameCount,
        });
        renderer.off(CliRenderEvents.FRAME, traceFrame);
      }
      appendTuiEvent({ kind: "shutdown", stage: "unmount" });
      root.unmount();
      appendTuiEvent({ kind: "shutdown", stage: "destroy" });
      renderer.destroy();
      appendTuiEvent({ kind: "shutdown", stage: "destroyed" });
      // Released after destroy(): opentui resets the stream itself, and
      // the guard only reinstalls originals it still owns.
      outputGuard.restore();
      resumeProcessPresentationStreamBridge();
      // Anything captured during the session is replayed to the real
      // terminal on the way out, so an operator never loses a quota or
      // failure notice just because the TUI was on screen.
      const captured = outputGuard.drain();
      const dropped = outputGuard.droppedCount();
      if (captured.length > 0 || dropped > 0) {
        // Labelled so the replay reads as a session log rather than a
        // duplicate of what the transcript already showed.
        process.stderr.write(`[0] runtime output captured during this session:\n`);
      }
      if (dropped > 0) {
        process.stderr.write(`[0] ${dropped} earlier line(s) dropped (buffer full)\n`);
      }
      for (const line of captured) {
        const stream = line.stream === "stderr" ? process.stderr : process.stdout;
        stream.write(`${line.text}\n`);
      }
      appendTuiEvent({ kind: "shutdown", stage: "close-complete" });
      resolve();
    };
    try {
      root.render(
        <TuiErrorBoundary onQuit={close}>
          <UnifiedApp mode={{ ...mode, onExit: close } as AppMode} lensEvolution={lensEvolution} />
        </TuiErrorBoundary>,
      );
    } catch (error) {
      // Never leave the process with patched streams: the crash report
      // below and anything after it must reach the real terminal.
      outputGuard.restore();
      resumeProcessPresentationStreamBridge();
      lensEvolution.stop();
      appendTuiCrash({
        source: "mountApp.render",
        error: serializeError(error),
      });
      throw error;
    }
  });
}

export async function showOpenTuiHome(): Promise<void> {
  await mountApp({
    type: "console",
    initialRoute: { type: "chat" },
    onExit: () => {},
  });
}

export async function showOpenTuiConsole(options: ChatScreenOptions = {}): Promise<void> {
  await mountApp({
    type: "console",
    initialRoute: { type: "chat", options },
    onExit: () => {},
  });
}


export async function showOpenTuiDoctor(): Promise<void> {
  await mountApp({ type: "console", initialRoute: { type: "doctor" }, onResolve: () => {}, onExit: () => {} });
}

export async function showOpenTuiHistory(options: { dbPath?: string; limit: number }): Promise<void> {
  await mountApp({ type: "console", initialRoute: { type: "history", dbPath: options.dbPath, limit: options.limit }, onResolve: () => {}, onExit: () => {} });
}

/**
 * Opens the console straight onto the resume picker — the saved-session browser.
 * Picking a session reopens the chat around its stored transcript; `chatOptions`
 * seed a fresh chat if the operator backs out of the picker. Drives `0 -r` /
 * `console --resume` with no id.
 */
export async function showOpenTuiResume(options: ChatScreenOptions = {}): Promise<void> {
  await mountApp({ type: "console", initialRoute: { type: "resume", chatOptions: options }, onExit: () => {} });
}


export async function showOpenTuiFindings(options: FindingsScreenOptions): Promise<void> {
  await mountApp({ type: "console", initialRoute: { type: "findings", options }, onResolve: () => {}, onExit: () => {} });
}

export async function showOpenTuiReplay(options: { dbPath?: string; scanId?: string }): Promise<void> {
  await mountApp({ type: "console", initialRoute: { type: "replay", dbPath: options.dbPath, scanId: options.scanId }, onResolve: () => {}, onExit: () => {} });
}

export async function createOpenTuiSession(options: {
  target: string;
  depth: string;
  mode: SessionMode;
  runtime?: string;
  apiProviderLabel?: string;
  apiConfigured?: boolean;
  apiConnected?: boolean;
  localRuntimes?: string[];
  model?: string;
}): Promise<{
  onEvent: (event: SessionEvent) => void;
  setReport: (report: Record<string, unknown>) => void;
  waitForExit: () => Promise<void>;
  /** Drain and return all pending user messages (called by the agent loop at turn boundaries). */
  getPendingUserMessages: () => string[];
}> {
  let state = createInitialSessionState(options.target, options.depth, options.mode, {
    runtime: options.runtime,
    apiProviderLabel: options.apiProviderLabel,
    apiConfigured: options.apiConfigured,
    apiConnected: options.apiConnected,
    localRuntimes: options.localRuntimes,
    model: options.model,
  });
  const presentation = createSessionPresentationAdapter(randomUUID());
  presentation.opened({
    target: options.target,
    depth: options.depth,
    mode: options.mode,
    runtime: options.runtime ?? "auto",
  });
  for (const item of state.transcript) {
    presentation.transcriptAppend(projectSessionItem(item));
  }
  const listeners = new Set<(value: SessionState) => void>();
  const sessionGate = createSessionCloseGate();
  const subscribe = (listener: (value: SessionState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  const emitTranscriptChanges = (previous: readonly TranscriptItem[]) => {
    const previousById = new Map(previous.map((item) => [item.id, item]));
    for (const item of state.transcript) {
      const prior = previousById.get(item.id);
      if (!prior) {
        presentation.transcriptAppend(projectSessionItem(item));
      } else if (prior !== item) {
        presentation.transcriptReplace(projectSessionItem(item));
      }
    }
  };

  const queueUserMessage = (text: string) => {
    state = { ...state, pendingUserMessages: [...state.pendingUserMessages, text] };
    state = {
      ...state,
      transcript: [
        ...state.transcript,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: "status" as const,
          text: `message queued: ${text.length > 60 ? text.slice(0, 60) + "..." : text}`,
          tone: "info" as const,
        },
      ],
    };
    const appended = state.transcript.at(-1);
    if (appended) presentation.transcriptAppend(projectSessionItem(appended));
    emit();
  };

  void mountApp({
    type: "session",
    initialState: state,
    subscribe,
    queueUserMessage,
    onExit: () => {
      presentation.closed();
      sessionGate.close();
    },
  });

  return {
    onEvent: (event) => {
      if (sessionGate.closed) return;
      const previousTranscript = state.transcript;
      state = applySessionEvent(state, event);
      presentation.sessionEvent("session.event", {
        type: event.type,
        ...(event.stage ? { stage: event.stage } : {}),
        ...(event.message ? { message: event.message } : {}),
      });
      emitTranscriptChanges(previousTranscript);
      emit();
    },
    setReport: (report) => {
      if (sessionGate.closed) return;
      state = applySessionReport(state, report);
      presentation.sessionEvent("session.report", { report });
      emit();
    },
    waitForExit: () => sessionGate.wait(),
    getPendingUserMessages: () => {
      const msgs = state.pendingUserMessages;
      if (msgs.length > 0) {
        presentation.sessionEvent("session.message.drained", { count: msgs.length });
        state = { ...state, pendingUserMessages: [] };
        emit();
      }
      return msgs;
    },
  };
}
