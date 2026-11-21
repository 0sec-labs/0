import { v } from "@/lib/vocabulary";
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
/** Disclosure shown above the privacy switches: what is automatic, and how to stop it. */
export const archiveIdleChoices = [0, 7, 14, 30, 90].map(value => ({ value, label: value === 0 ? "Off" : `${value} days` }));
const sharedSettings = {
  busyInputMode: { category: "input", label: "Messages while working", description: "Interrupt or queue." },
  autoCompaction: { category: "conversation", label: v("Summarize long {missions}"), description: v("Stay within the context limit.") },
  compactionThreshold: { category: "conversation", label: "Start summarizing at", description: "" },
  titleInstructions: { category: "conversation", label: v("{Mission} title instructions"), description: "" },
  archiveIdleDays: { category: "conversation", label: v("Archive idle {missions} after"), description: "" },
  subagentConcurrency: { category: "conversation", label: "Concurrent subagents", description: "Running at once." },
  subagentMaxDepth: { category: "conversation", label: "Nested subagent depth", description: "Levels of nested subagents." },
  subagentFanOut: { category: "conversation", label: "Subagents per call", description: "Per step." },
  allowSubagentPeerMessaging: { category: "agents", label: "Helpers share findings", description: "" },
  allowSubagentOperatorMessaging: { category: "agents", label: "Helpers message you", description: "" },
  approvals: { category: "agents", label: "Ask before running commands", description: v("Ask before each command or change."), toggle: { on: "ask", off: "auto" } },
  executionProfile: { category: "agents", label: "Where helpers run", description: v("Applies to new {missions}.") },
  analyticsLevel: { category: "privacy", label: "Usage metrics", description: "Anonymous counts, timing, cost and error types. Never targets, findings, code or tool content.", toggle: { on: "usage", off: "off" } },
  diagnosticReporting: { category: "privacy", label: "Problem reports", description: "Crash reports with error types only. Never messages, targets or findings." },
  density: { category: "appearance", label: "Compact transcript", description: "Tighter spacing.", toggle: { on: "compact", off: "comfortable" } },
  transcriptDetail: { category: "transcript", label: "Expand work log", description: "Show tool calls and reasoning by default.", toggle: { on: "expanded", off: "collapsed" } },
  toolCardStyle: { category: "transcript", label: "Show tool calls", description: "Hide finished tool calls.", toggle: { on: "compact", off: "hidden" } },
  showSubagents: { category: "transcript", label: "Helper list in transcript", description: "List the helpers for each turn." },
  showTimestamps: { category: "transcript", label: "Always show message times", description: "Not only on hover." },
  elapsedTimer: { category: "transcript", label: "Elapsed time", description: "How long each turn took.", toggle: { on: "left", off: "off" } },
  showCost: { category: "telemetry", label: "Show cost and usage", description: "Cost, tokens and context." },
  showTokenUsage: { category: "telemetry", label: "Token counts", description: "Input and output tokens.", into: "showCost" },
  showContextMeter: { category: "telemetry", label: "Context meter", description: "How full the context window is.", into: "showCost" },
  updatePolicy: { category: "general", label: "Updates", description: "Automatic installs when idle. Notify me only shows a card. Off never checks." },
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
