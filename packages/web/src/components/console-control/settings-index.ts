import { VOCAB } from "@/lib/vocabulary";
import { sharedSettingCatalogue, settingsCategories } from "./web-settings";

/** Everything the settings sidebar can navigate to: the engine-backed categories plus read-only pages. */
export const settingsPages = [...settingsCategories, { id: "shortcuts", label: "Shortcuts" }, { id: "notifications", label: "Notifications" }, { id: "usage", label: "Usage" }, { id: "members", label: "Members" }, { id: "integrations", label: "Integrations" }, { id: "skills", label: "Skills" }, { id: "instructions", label: "Instructions" }] as const;
export type SettingsPageId = typeof settingsPages[number]["id"];

/** One searchable row. `key` is the DOM anchor suffix (`#setting-<key>`); page-level entries have none. */
export type SettingsIndexEntry = { title: string; category: SettingsPageId; categoryLabel: string; keywords: string; key?: string; href: string };
export type SettingsSearchGroup = { category: { id: SettingsPageId; label: string }; categoryMatches: boolean; entries: SettingsIndexEntry[] };

export const settingsHref = (category: string, key?: string) => `/settings?section=${encodeURIComponent(category)}${key ? `#setting-${encodeURIComponent(key)}` : ""}`;

const categoryKeywords: Record<string, string> = {
  general: "updates engine update policy reset defaults development source",
  appearance: "theme light dark mode colors browser density compact spacing",
  transcript: "transcript work log tool calls reasoning agents subagents timestamps time elapsed timer duration details",
  telemetry: "cost spend price tokens context window meter usage display",
  usage: "usage spend cost tokens model chats billing credits",
  members: "members team users people teammates roles owner editor viewer workspace invite",
  integrations: "integrations plugins mcp connections providers models tools services marketplace",
  skills: "skills instructions library playbooks",
  conversation: "mission missions chat chats messages queue interrupt summarize compaction context",
  agents: "agents execution tools sandbox isolated host subagents plugins",
  privacy: "data privacy analytics metrics diagnostics problem reports telemetry",
  notifications: "notifications alerts browser notify sound chime sound permission desktop approval question finished scan fix pull request hidden tab",
  instructions: "instructions agents.md global workspace system prompt guidance rules markdown",
  shortcuts: "keyboard keys hotkeys bindings command search sidebar composer enter escape",
};
const labelOf = (id: string) => settingsPages.find(page => page.id === id)!.label;

/** Rows on the read-only pages, so deep search reaches them too. */
const pageRows: { title: string; category: SettingsPageId; keywords: string; key: string }[] = [
  { title: "Estimated spend", category: "usage", keywords: "cost money dollars total", key: "usage-cost" },
  { title: "Tokens", category: "usage", keywords: "input output", key: "usage-tokens" },
  { title: "Spend by model", category: "usage", keywords: "models breakdown", key: "usage-models" },
  { title: "Spend by chat", category: "usage", keywords: "chats missions conversations", key: "usage-chats" },
  { title: "Workspace members", category: "members", keywords: "people users roles", key: "members" },
  { title: "Add teammate", category: "members", keywords: "invite account team", key: "members-manage" },
  { title: "Findings API", category: "members", keywords: "tokens access api", key: "members-api" },
  { title: "Plugins", category: "integrations", keywords: "mcp services connectors marketplace install", key: "integrations-plugins" },
  { title: "Connections", category: "integrations", keywords: "provider sign in api key", key: "integrations-connections" },
  { title: "GitHub", category: "integrations", keywords: "publish pull request token fixes repository connect", key: "integrations-github" },
  { title: "Models", category: "integrations", keywords: "model reasoning provider", key: "integrations-models" },
  { title: "Tools", category: "integrations", keywords: "tool catalog", key: "integrations-tools" },
  { title: "Notify me", category: "notifications", keywords: "master switch enable alerts", key: "notifications-enabled" },
  { title: "Browser permission", category: "notifications", keywords: "allow blocked enable browser notifications", key: "notifications-permission" },
  { title: "Only when this tab is hidden", category: "notifications", keywords: "focus background visible", key: "notifications-hidden" },
  { title: "Play a sound", category: "notifications", keywords: "chime audio", key: "notifications-sound" },
  { title: "Send a test notification", category: "notifications", keywords: "try preview", key: "notifications-test" },
  { title: "Mission finished", category: "notifications", keywords: "complete done", key: "notifications-mission-finished" },
  { title: "Mission needs your approval", category: "notifications", keywords: "approve decision permission", key: "notifications-mission-approval" },
  { title: "Mission asked a question", category: "notifications", keywords: "ask answer", key: "notifications-mission-question" },
  { title: "Scan finished", category: "notifications", keywords: "scan complete", key: "notifications-scan-finished" },
  { title: "Fix ready or pull request opened", category: "notifications", keywords: "fix pr patch", key: "notifications-fix-ready" },
  { title: "Global instructions", category: "instructions", keywords: "agents.md system prompt every mission", key: "instructions-global" },
  { title: "Workspace instructions", category: "instructions", keywords: "agents.md system prompt folder project", key: "instructions-workspace" },
  { title: "Skills library", category: "skills", keywords: "create import edit instructions", key: "skills-library" },
];
const entries: SettingsIndexEntry[] = [
  ...settingsPages.map(page => ({ title: page.label, category: page.id, categoryLabel: page.label, keywords: categoryKeywords[page.id] ?? "", href: settingsHref(page.id) })),
  { title: "Theme", category: "appearance", categoryLabel: labelOf("appearance"), keywords: "light dark mode web appearance browser", key: "web-theme", href: settingsHref("appearance", "web-theme") },
  ...sharedSettingCatalogue().map(setting => ({ title: setting.label, category: setting.category, categoryLabel: labelOf(setting.category), keywords: `${setting.description} ${setting.key}${setting.description.toLowerCase().includes(VOCAB.mission.singular) ? " chat chats" : ""}${setting.category === "conversation" ? " mission chat" : ""}`, key: setting.key, href: settingsHref(setting.category, setting.key) } satisfies SettingsIndexEntry)),
  ...pageRows.map(row => ({ ...row, categoryLabel: labelOf(row.category), href: settingsHref(row.category, row.key) } satisfies SettingsIndexEntry)),
  { title: "Reset shared preferences", category: "general", categoryLabel: labelOf("general"), keywords: "restore defaults", key: "reset", href: settingsHref("general", "reset") },
];

const normalize = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/**
 * Deep search. Every whitespace-separated term must appear in a title, category label or keywords.
 * Returns matches grouped by category, in sidebar order, so a UI can show the page and its matching rows.
 */
export function searchSettings(query: string): SettingsSearchGroup[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matches = (entry: SettingsIndexEntry) => { const haystack = normalize(`${entry.title} ${entry.categoryLabel} ${entry.keywords}`); return terms.every(term => haystack.includes(term)); };
  const groups: SettingsSearchGroup[] = [];
  for (const page of settingsPages) {
    const own = entries.filter(entry => entry.category === page.id);
    const pageEntry = own.find(entry => !entry.key)!;
    const rows = own.filter(entry => entry.key && matches(entry));
    const categoryMatches = matches(pageEntry);
    if (categoryMatches || rows.length) groups.push({ category: { id: page.id, label: page.label }, categoryMatches, entries: rows });
  }
  return groups;
}
