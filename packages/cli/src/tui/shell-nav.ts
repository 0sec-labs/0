import type { Finding } from "@0sec/shared";
import type { ChatScreenOptions } from "./chat-screen.js";

export interface ShellNav {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  /**
   * Returns to the chat route.
   *
   * The optional options are how a screen that outlives the chat component
   * hands something back to it — the model picker's selection, today. Passing
   * none re-enters chat with its defaults, which is what the palette does.
   */
  openChat: (options?: ChatScreenOptions) => void;
  openNewChat: () => void;
  openLauncher: () => void;
  openOps: () => void;
  openDoctor: () => void;
  openHistory: () => void;
  openFindings: () => void;
  openReplay: (scanId?: string) => void;
  openSettings: () => void;
  openHarness: () => void;
  /** Opens the model picker above the live conversation. */
  openModels: (chatOptions?: ChatScreenOptions) => void;
  openResume: (chatOptions?: ChatScreenOptions) => void;
  openOnboarding: () => void;
  /**
   * Opens the agent-herd overview: the roster of peers working this project
   * directory. Empty by default until the roster producer is wired.
   */
  openHerd: () => void;
  /**
   * Opens the full-screen marketplace browser: plugins and themes from the
   * configured registry. No endpoint ships by default, so it opens on an honest
   * empty state until `$0SEC_REGISTRY_URL` points at a registry the operator trusts.
   */
  openMarket: () => void;
  /**
   * Opens the full-screen provider connect / login screen: the write side of
   * `/providers`, where an operator connects a model provider by pasting an API
   * key or completing a subscription sign-in. Credentials go only to the
   * existing credential store.
   */
  openConnect: () => void;
  /**
   * Opens the full-screen session-usage report: context window, token totals,
   * estimated cost, active model and tool-health issues. The chat route's
   * options are carried through so the report can name the model in force; the
   * live token counts live in `ChatScreen` and reach the screen only once the
   * one-line chat-composer `case "usage"` hands them across, so until then the
   * palette route shows the model and `—` for the counts (never a fabricated
   * zero).
   */
  openUsage: (chatOptions?: ChatScreenOptions) => void;
  /**
   * Opens the full-screen finding-detail view for one finding: its full body
   * (severity, location, description, redacted evidence, remediation, CVSS,
   * references) plus the fix / copy-report / status actions. The chat route's
   * options are carried through so a fix request can re-enter chat with the same
   * target and model. The finding itself may be passed directly (the sidebar /
   * inline click hands its own record across) or by id, resolved lazily from
   * the findings store.
   */
  openFindingDetail: (findingId?: string, finding?: Finding, chatOptions?: ChatScreenOptions) => void;
}

export function leaveCurrentScreen(shell: ShellNav | undefined, onExit: () => void): void {
  if (shell) {
    shell.goBack();
    return;
  }
  onExit();
}
