/** Explicit web capabilities: newly added terminal settings are never exposed automatically. */
export const settingsCategories = [
  { id: "general", label: "Updates" },
  { id: "appearance", label: "Appearance" },
  { id: "conversation", label: "Conversation" },
  { id: "agents", label: "Agents & execution" },
  { id: "privacy", label: "Data & privacy" },
] as const;
export type SettingsCategory = typeof settingsCategories[number]["id"];

type WebSetting = { category: SettingsCategory; label: string; description: string };
const sharedSettings = {
  busyInputMode: { category: "conversation", label: "Messages while working", description: "Interrupt with your next message, or queue it until the current response finishes." },
  autoCompaction: { category: "conversation", label: "Summarize long chats", description: "Summarize older messages when the chat context fills up." },
  compactionThreshold: { category: "conversation", label: "Start summarizing at", description: "How full the chat context can get before older messages are summarized." },
  allowSubagentPeerMessaging: { category: "agents", label: "Agent collaboration", description: "Let agents exchange findings and coordinate their work." },
  allowSubagentOperatorMessaging: { category: "agents", label: "Agent messages", description: "Let agents send you updates and questions while they work." },
  allowModelSelfExtension: { category: "agents", label: "Agent-created tools", description: "Let new chats create sandboxed tools when needed. Trusted code still requires workspace approval." },
  executionProfile: { category: "agents", label: "Run tools in", description: "Choose where tools run. Changes apply to new chats." },
  analyticsLevel: { category: "privacy", label: "Usage metrics", description: "Share counts, timing, costs, and error types. Code and tool content are excluded. Environment opt-outs take priority." },
  diagnosticReporting: { category: "privacy", label: "Problem reports", description: "Review reports before sending, send automatically, or keep them local. A reporting destination must be configured." },
  updatePolicy: { category: "general", label: "Engine updates", description: "Check for updates when this engine starts." },
} as const satisfies Record<string, WebSetting>;
const terminalSettings = new Set([
  "showStatusBar", "showComposerHints", "composerSuggestions", "mouseSupport", "showLogo", "showRuntimeNotices", "showTurnSummary", "showSubagents", "showTimestamps", "showObjective", "showScope", "density", "composerStyle", "transcriptStyle", "roleLabelStyle", "toolCardStyle", "richToolCards", "transcriptDetail", "theme", "allowDevSourceUpdates", "autoEvolveFinderLenses", "autoPromoteFinderLenses", "showTokenUsage", "showCost", "showContextMeter", "modelDisplay", "elapsedTimer", "logoAnimation", "reduceMotion", "symbolPreset", "rosterSort", "leaderKey",
]);
const browserSettings = new Set(["web-theme", "web-motion"]);
export function settingSurface(key: string): "shared" | "browser" | "terminal" | "unsupported" {
  if (Object.hasOwn(sharedSettings, key)) return "shared";
  if (browserSettings.has(key)) return "browser";
  if (terminalSettings.has(key)) return "terminal";
  return "unsupported";
}
export function visibleWebSetting(definition: { key: string }): boolean { return settingSurface(definition.key) === "shared"; }
/** Reset payloads are explicit, deduplicated, and cannot include terminal or browser preferences. */
export function sharedSettingKeys(keys: Iterable<string>): string[] { return [...new Set(keys)].filter(key => settingSurface(key) === "shared"); }
export function webSettingDetails(key: string): WebSetting | undefined { return Object.hasOwn(sharedSettings, key) ? sharedSettings[key as keyof typeof sharedSettings] : undefined; }
export function categoryFor(definition: { key: string }): SettingsCategory { return webSettingDetails(definition.key)?.category ?? "agents"; }
export function settingLabel(definition: { key: string; label: string }): string { return webSettingDetails(definition.key)?.label ?? definition.label; }
export function settingChoiceLabel(key: string, choice: string): string {
  const labels: Record<string, Record<string, string>> = {
    executionProfile: { local: "This host", smolvm: "Isolated workspace" },
    busyInputMode: { steer: "Interrupt", queue: "Queue" },
    diagnosticReporting: { off: "Keep local", ask: "Ask before sending", automatic: "Send automatically" },
    updatePolicy: { off: "Off", notify: "Notify me", automatic: "Install automatically" },
  };
  return labels[key]?.[choice] ?? choice.charAt(0).toUpperCase() + choice.slice(1);
}
