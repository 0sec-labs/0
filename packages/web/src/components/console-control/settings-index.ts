import { VOCAB } from "@/lib/vocabulary";
import { sharedSettingCatalogue, settingsCategories, type SettingsCategory } from "./web-settings";

/** The settings pages, in sidebar order. Engine-backed categories (`settingsCategories`) are sections inside them. */
export const settingsPages = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "missions", label: VOCAB.mission.Plural },
  { id: "notifications", label: "Notifications" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "instructions", label: "Instructions" },
  { id: "agents", label: "Agents and privacy" },
  { id: "git", label: "Git and pull requests" },
  { id: "usage", label: "Usage" },
  { id: "audit-log", label: "Audit log" },
] as const;
export type SettingsPageId = typeof settingsPages[number]["id"];

/** Page that shows each engine-backed category as a section. */
const pageOfCategory: Record<SettingsCategory, SettingsPageId> = { general: "general", appearance: "appearance", conversation: "missions", transcript: "missions", telemetry: "missions", agents: "agents", privacy: "agents" };
export const categoriesOfPage = (page: SettingsPageId): SettingsCategory[] => settingsCategories.filter(category => pageOfCategory[category.id] === page).map(category => category.id);

/** Sections that no longer exist as pages, mapped to the closest page or route, so old links and bookmarks keep working. */
const removedSections: Record<string, string> = {
  conversation: "missions", transcript: "missions", telemetry: "missions", privacy: "agents",
  profile: "appearance", experiments: "general", activity: "usage", repositories: "git",
  "finding-states": "/findings", integrations: "/plugins", skills: "/plugins/skills", members: "/team",
};
/** Where `/settings?section=<section>` should go instead, when the section was removed or merged; undefined otherwise. */
export function settingsRedirect(section: string | null): string | undefined {
  const target = section ? removedSections[section] : undefined;
  return target ? (target.startsWith("/") ? target : settingsHref(target)) : undefined;
}
/** The page a `section` value shows; unknown values fall back to General. */
export function settingsPageId(section: string | null): SettingsPageId {
  const target = (section && removedSections[section]) || section;
  return settingsPages.find(page => page.id === target)?.id ?? "general";
}

/** One searchable row. `key` is the DOM anchor suffix (`#setting-<key>`); page-level entries have none. */
export type SettingsIndexEntry = { title: string; category: SettingsPageId; categoryLabel: string; keywords: string; key?: string; href: string };
export type SettingsSearchGroup = { category: { id: SettingsPageId; label: string }; categoryMatches: boolean; entries: SettingsIndexEntry[] };

export const settingsHref = (category: string, key?: string) => `/settings?section=${encodeURIComponent(category)}${key ? `#setting-${encodeURIComponent(key)}` : ""}`;

const categoryKeywords: Record<SettingsPageId, string> = {
  general: "updates engine update policy reset defaults development source",
  appearance: "theme light dark mode colors browser density compact spacing profile",
  missions: "mission missions chat chats messages queue interrupt summarize compaction context title titles name archive idle subagents concurrency depth fan out parallel transcript work log tool calls reasoning timestamps time elapsed timer cost spend tokens context window meter",
  usage: "usage spend cost tokens model chats billing credits activity",
  agents: "agents execution tools sandbox isolated host subagents plugins data privacy analytics metrics diagnostics problem reports telemetry",
  notifications: "notifications alerts browser notify sound chime sound permission desktop approval question finished scan fix pull request hidden tab",
  instructions: "instructions agents.md global workspace system prompt guidance rules markdown",
  git: "git github pull requests prs branch publish fixes connection token repository repositories repos commit visibility default branch sentinels",
  "audit-log": "audit log security history approvals denials settings changes mcp plugins connections sentinels export json actor action subject",
  shortcuts: "keyboard keys hotkeys bindings command search sidebar composer enter escape",
};
const labelOf = (id: string) => settingsPages.find(page => page.id === id)!.label;

/** Rows on the read-only pages, so deep search reaches them too. */
const pageRows: { title: string; category: SettingsPageId; keywords: string; key: string }[] = [
  { title: "Estimated spend", category: "usage", keywords: "cost money dollars total", key: "usage-cost" },
  { title: "Tokens", category: "usage", keywords: "input output", key: "usage-tokens" },
  { title: "Spend by model", category: "usage", keywords: "models breakdown", key: "usage-models" },
  { title: "Spend by chat", category: "usage", keywords: "chats missions conversations", key: "usage-chats" },
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
  { title: "GitHub connection", category: "git", keywords: "connected account permissions sign in token", key: "git-status" },
  { title: "Pull requests opened by 0", category: "git", keywords: "prs fixes branch merge links", key: "git-prs" },
  { title: "Repository search", category: "git", keywords: "owner name github visibility branch sentinels used by", key: "repositories-search" },
  { title: "Audit log search", category: "audit-log", keywords: "actions approvals denials history export json actor subject", key: "audit-log-search" },
];
const entries: SettingsIndexEntry[] = [
  ...settingsPages.map(page => ({ title: page.label, category: page.id, categoryLabel: page.label, keywords: categoryKeywords[page.id] ?? "", href: settingsHref(page.id) })),
  { title: "Theme", category: "appearance", categoryLabel: labelOf("appearance"), keywords: "colour color palette gallery dracula nord solarized catppuccin tokyo night rose pine one github gruvbox zero", key: "web-color-theme", href: settingsHref("appearance", "web-color-theme") },
  { title: "Mode", category: "appearance", categoryLabel: labelOf("appearance"), keywords: "theme light dark system mode web appearance browser", key: "web-theme", href: settingsHref("appearance", "web-theme") },
  { title: "Accent color", category: "appearance", categoryLabel: labelOf("appearance"), keywords: "accent color colour orange blue green violet rose neutral highlight", key: "web-accent", href: settingsHref("appearance", "web-accent") },
  { title: "Font size", category: "appearance", categoryLabel: labelOf("appearance"), keywords: "text size small large zoom scale", key: "web-font-size", href: settingsHref("appearance", "web-font-size") },
  { title: "Reduce motion", category: "appearance", categoryLabel: labelOf("appearance"), keywords: "animation motion reduced accessibility", key: "web-motion", href: settingsHref("appearance", "web-motion") },
  ...sharedSettingCatalogue().map(setting => ({ title: setting.label, category: pageOfCategory[setting.category], categoryLabel: labelOf(pageOfCategory[setting.category]), keywords: `${setting.description} ${setting.key}${setting.description.toLowerCase().includes(VOCAB.mission.singular) ? " chat chats" : ""}${setting.category === "conversation" ? " mission chat" : ""}`, key: setting.key, href: settingsHref(pageOfCategory[setting.category], setting.key) } satisfies SettingsIndexEntry)),
  ...pageRows.map(row => ({ ...row, categoryLabel: labelOf(row.category), href: settingsHref(row.category, row.key) } satisfies SettingsIndexEntry)),
  { title: "Reset shared preferences", category: "general", categoryLabel: labelOf("general"), keywords: "restore defaults", key: "reset", href: settingsHref("general", "reset") },
];

const normalize = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

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
