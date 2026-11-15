import { VOCAB, v } from "@/lib/vocabulary";
/** Explicit web capabilities: newly added terminal settings are never exposed automatically. */
export const settingsCategories = [
  { id: "general", label: "Updates" },
  { id: "input", label: "Input" },
  { id: "appearance", label: "Appearance" },
  { id: "conversation", label: "Behavior" },
  { id: "transcript", label: "Transcript" },
  { id: "telemetry", label: "Cost and context" },
  { id: "agents", label: "Helpers" },
  { id: "privacy", label: "Privacy" },
] as const;
export type SettingsCategory = typeof settingsCategories[number]["id"];

/** `toggle` presents a many-valued engine setting as a switch: on writes `on`, off writes `off`. */
type WebSetting = { category: SettingsCategory; label: string; description: string; toggle?: { on: string; off: string }; /** Shown as part of another setting's switch instead of its own row. */ into?: string };
/** Idle-archive choices, in days; 0 is off. */
export const archiveIdleChoices = [0, 7, 14, 30, 90].map(value => ({ value, label: value === 0 ? "Off" : `${value} days` }));
const sharedSettings = {
  busyInputMode: { category: "input", label: "Messages while working", description: "Interrupt the response or queue your next message." },
  autoCompaction: { category: "conversation", label: v("Summarize long {missions}"), description: v("Keep long {missions} within the model’s context limit.") },
  compactionThreshold: { category: "conversation", label: "Start summarizing at", description: "" },
  titleInstructions: { category: "conversation", label: v("{Mission} title instructions"), description: "" },
  archiveIdleDays: { category: "conversation", label: v("Archive idle {missions} after"), description: "" },
  subagentConcurrency: { category: "conversation", label: "Concurrent subagents", description: "Subagents that run at the same time." },
  subagentMaxDepth: { category: "conversation", label: "Nested subagent depth", description: "How many levels of subagents can spawn their own." },
  subagentFanOut: { category: "conversation", label: "Subagents per call", description: "Subagents one step can start." },
  allowSubagentPeerMessaging: { category: "agents", label: "Helpers share findings", description: "Helpers can share findings with one another." },
  allowSubagentOperatorMessaging: { category: "agents", label: "Helpers message you", description: "Helpers can send you updates and questions." },
  allowModelSelfExtension: { category: "agents", label: "Model-authored plugins", description: v("Let new {missions} write their own sandboxed plugins.") },
  executionProfile: { category: "agents", label: "Where helpers run", description: v("Changes apply to new {missions}.") },
  analyticsLevel: { category: "privacy", label: "Usage metrics", description: "Counts, timing, costs and error types. Never code or tool content.", toggle: { on: "usage", off: "off" } },
  diagnosticReporting: { category: "privacy", label: "Problem reports", description: "Review reports before sending, send them automatically, or keep them local." },
  density: { category: "appearance", label: "Compact transcript", description: v("Tighter spacing between turns in a {mission}."), toggle: { on: "compact", off: "comfortable" } },
  transcriptDetail: { category: "transcript", label: "Expand work log", description: "Show each turn’s tool calls and reasoning by default instead of one summary line. Failures always show.", toggle: { on: "expanded", off: "collapsed" } },
  toolCardStyle: { category: "transcript", label: "Show tool calls", description: "Hide finished tool calls from the transcript. Running, failed and stopped calls always show.", toggle: { on: "compact", off: "hidden" } },
  showSubagents: { category: "transcript", label: "Helper list in transcript", description: "List the helpers that worked on each turn. The Helpers panel is unaffected." },
  showTimestamps: { category: "transcript", label: "Always show message times", description: "Keep the time above each message visible instead of only on hover." },
  elapsedTimer: { category: "transcript", label: "Elapsed time", description: "Show how long each turn ran, such as “Worked for 12s”.", toggle: { on: "left", off: "off" } },
  showCost: { category: "telemetry", label: "Show cost and usage", description: "Cost, token counts and the context meter." },
  showTokenUsage: { category: "telemetry", label: "Token counts", description: "Show input and output tokens in the cost details.", into: "showCost" },
  showContextMeter: { category: "telemetry", label: "Context meter", description: "Show how full the model’s context window is next to the composer.", into: "showCost" },
  updatePolicy: { category: "general", label: "Updates", description: "" },
} as const satisfies Record<string, WebSetting>;
const terminalSettings = new Set([
  // Loads and runs source from the host disk with full credentials. Operator-only; a web or team session must never flip it.
  "allowDevSourceUpdates",
]);
const browserSettings = new Set(["web-theme", "web-color-theme", "web-accent", "web-font-size", "web-motion"]);
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
/** Keys that share one switch with `key`, itself included; just `key` when it stands alone. */
export function settingGroup(key: string): string[] { return Object.entries(sharedSettings).filter(([name, value]) => name === key || ("into" in value && value.into === key)).map(([name]) => name); }
export function hiddenInto(key: string): string | undefined { const details = webSettingDetails(key); return details && "into" in details ? details.into : undefined; }
export function categoryFor(definition: { key: string }): SettingsCategory { return webSettingDetails(definition.key)?.category ?? "agents"; }
export function settingLabel(definition: { key: string; label: string }): string { return webSettingDetails(definition.key)?.label ?? definition.label; }
export function settingChoiceLabel(key: string, choice: string): string {
  const labels: Record<string, Record<string, string>> = {
    executionProfile: { local: "This computer", smolvm: "Isolated environment" },
    busyInputMode: { steer: "Interrupt", queue: "Queue" },
    diagnosticReporting: { off: "Keep local", ask: "Ask before sending", automatic: "Send automatically" },
    updatePolicy: { off: "Off", notify: "Notify me", automatic: "Automatic" },
  };
  return labels[key]?.[choice] ?? choice.charAt(0).toUpperCase() + choice.slice(1);
}
/** Static catalogue of the web-managed shared settings, for search and navigation. */
export function sharedSettingCatalogue(): { key: string; category: SettingsCategory; label: string; description: string }[] {
  return Object.entries(sharedSettings).filter(([, value]) => !("into" in value)).map(([key, value]) => ({ key, ...value }));
}
