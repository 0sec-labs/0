import { VOCAB, v } from "@/lib/vocabulary";
/** Explicit web capabilities: newly added terminal settings are never exposed automatically. */
export const settingsCategories = [
  { id: "general", label: "Updates" },
  { id: "appearance", label: "Appearance" },
  { id: "conversation", label: VOCAB.mission.Plural },
  { id: "transcript", label: "Transcript" },
  { id: "telemetry", label: "Cost & context" },
  { id: "agents", label: "Agents & execution" },
  { id: "privacy", label: "Data & privacy" },
] as const;
export type SettingsCategory = typeof settingsCategories[number]["id"];

/** `toggle` presents a many-valued engine setting as a switch: on writes `on`, off writes `off`. */
type WebSetting = { category: SettingsCategory; label: string; description: string; toggle?: { on: string; off: string } };
const sharedSettings = {
  busyInputMode: { category: "conversation", label: "Messages while working", description: "Interrupt the response or queue your next message." },
  autoCompaction: { category: "conversation", label: v("Summarize long {missions}"), description: v("Keep long {missions} within the model’s context limit.") },
  compactionThreshold: { category: "conversation", label: "Start summarizing at", description: "" },
  allowSubagentPeerMessaging: { category: "agents", label: "Agent collaboration", description: "Agents can share findings with one another." },
  allowSubagentOperatorMessaging: { category: "agents", label: "Agent messages", description: "Agents can send you updates and questions." },
  allowModelSelfExtension: { category: "agents", label: "Model-authored plugins", description: v("Let new {missions} author sandboxed plugins when needed. Trusted code still requires workspace approval.") },
  executionProfile: { category: "agents", label: "Run tools in", description: v("Changes apply to new {missions}.") },
  analyticsLevel: { category: "privacy", label: "Usage metrics", description: "Share counts, timing, costs, and error types. Code and tool content are excluded. Environment opt-outs take priority." },
  diagnosticReporting: { category: "privacy", label: "Problem reports", description: "Review reports before sending, send automatically, or keep them local. A reporting destination must be configured." },
  density: { category: "appearance", label: "Compact transcript", description: v("Tighter spacing between turns in a {mission}."), toggle: { on: "compact", off: "comfortable" } },
  transcriptDetail: { category: "transcript", label: "Expand work log", description: "Show each turn’s tool calls and reasoning by default instead of one summary line. Failures always show.", toggle: { on: "expanded", off: "collapsed" } },
  toolCardStyle: { category: "transcript", label: "Show tool calls", description: "Hide finished tool calls from the transcript. Running, failed and stopped calls always show.", toggle: { on: "compact", off: "hidden" } },
  showSubagents: { category: "transcript", label: "Agent list in transcript", description: "List the agents that worked on each turn. The Agents panel is unaffected." },
  showTimestamps: { category: "transcript", label: "Always show message times", description: "Keep the time above each message visible instead of only on hover." },
  elapsedTimer: { category: "transcript", label: "Elapsed time", description: "Show how long each turn ran, such as “Worked for 12s”." },
  showCost: { category: "telemetry", label: "Cost", description: "Show the estimated cost of a chat in its header." },
  showTokenUsage: { category: "telemetry", label: "Token counts", description: "Show input and output tokens in the cost details." },
  showContextMeter: { category: "telemetry", label: "Context meter", description: "Show how full the model’s context window is next to the composer." },
  updatePolicy: { category: "general", label: "Engine updates", description: "Applies when this engine starts." },
} as const satisfies Record<string, WebSetting>;
const terminalSettings = new Set([
  // Terminal chrome with no browser counterpart. See the classification note in the settings tests.
  "showStatusBar", "showComposerHints", "mouseSupport", "showLogo", "logoAnimation", "symbolPreset", "leaderKey", "showRuntimeNotices", "showObjective", "showScope", "composerStyle", "transcriptStyle", "roleLabelStyle", "theme", "rosterSort",
  // Terminal-rendered today, with a web equivalent not built yet: left out rather than shown as a dead toggle.
  "composerSuggestions", "showTurnSummary", "richToolCards", "modelDisplay",
  // Declared but read nowhere in the engine, so exposing them would be a dead toggle.
  "autoEvolveFinderLenses", "autoPromoteFinderLenses",
  // Loads and runs source from the host disk with full credentials. Operator-only; a web or team session must never flip it.
  "allowDevSourceUpdates",
]);
const browserSettings = new Set(["web-theme"]);
export function settingSurface(key: string): "shared" | "browser" | "terminal" | "unsupported" {
  if (Object.hasOwn(sharedSettings, key)) return "shared";
  if (browserSettings.has(key)) return "browser";
  if (terminalSettings.has(key)) return "terminal";
  return "unsupported";
}
export function visibleWebSetting(definition: { key: string }): boolean { return settingSurface(definition.key) === "shared"; }
/** Reset payloads are explicit, deduplicated, and cannot include terminal or browser preferences. */
export function sharedSettingKeys(keys: Iterable<string>): string[] { return [...new Set(keys)].filter(key => settingSurface(key) === "shared"); }
/** Switch mapping for settings the browser shows as on/off even though the engine stores more than two values. */
export function settingToggle(key: string): { on: string; off: string } | undefined { return webSettingDetails(key)?.toggle; }
export function webSettingDetails(key: string): WebSetting | undefined { return Object.hasOwn(sharedSettings, key) ? sharedSettings[key as keyof typeof sharedSettings] : undefined; }
export function categoryFor(definition: { key: string }): SettingsCategory { return webSettingDetails(definition.key)?.category ?? "agents"; }
export function settingLabel(definition: { key: string; label: string }): string { return webSettingDetails(definition.key)?.label ?? definition.label; }
export function settingChoiceLabel(key: string, choice: string): string {
  const labels: Record<string, Record<string, string>> = {
    executionProfile: { local: "This host", smolvm: "Isolated workspace" },
    busyInputMode: { steer: "Interrupt", queue: "Queue" },
    diagnosticReporting: { off: "Keep local", ask: "Ask before sending", automatic: "Send automatically" },
    updatePolicy: { off: "Off", notify: "Notify me", automatic: "Automatic" },
  };
  return labels[key]?.[choice] ?? choice.charAt(0).toUpperCase() + choice.slice(1);
}
/** Static catalogue of the web-managed shared settings, for search and navigation. */
export function sharedSettingCatalogue(): { key: string; category: SettingsCategory; label: string; description: string }[] {
  return Object.entries(sharedSettings).map(([key, value]) => ({ key, ...value }));
}
