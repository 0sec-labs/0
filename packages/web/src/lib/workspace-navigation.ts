import { VOCAB } from "@/lib/vocabulary";
import { CapyAutomationsIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyIssueDashedIcon, CapyPuzzleIcon, CapySettingsIcon, CapySparkleFourIcon, CapyThreadListIcon } from "@/ui/icons/capy";

/** One destination inventory for desktop and touch navigation. */
export const WORKSPACE_DESTINATIONS = [
  { to: "/chats", label: VOCAB.mission.Plural, icon: CapyThreadListIcon },
  { to: "/findings", label: "Findings", icon: CapyIssueDashedIcon },
  { to: "/automations", label: "Automations", icon: CapyAutomationsIcon },
  { to: "/plugins/skills", label: "Skills", icon: CapySparkleFourIcon },
  { to: "/memory", label: "Memory", icon: CapyDatabaseIcon },
  { to: "/computers", label: "Computers", icon: CapyDevicesIcon },
  { to: "/extensions", label: "Extensions", icon: CapyPuzzleIcon },
  { to: "/settings", label: "Settings", icon: CapySettingsIcon },
] as const;

/**
 * The sidebar: "New thread" (an action, not a route) followed by these six destinations, in this order. There is no More menu.
 * Skills is active on /plugins/skills* (installed, browse, catalog detail); Extensions on /extensions.
 */
export const SIDEBAR_DESTINATIONS = ["/findings", "/automations", "/plugins/skills", "/memory", "/computers", "/extensions"] as const;

/** Whether a sidebar destination is highlighted for the (canonical, basename-free) current path. */
export function isSidebarDestinationActive(to: string, currentPath: string): boolean {
  const under = (base: string) => currentPath === base || currentPath.startsWith(`${base}/`);
  return under(to);
}

/**
 * Every legacy URL the app still accepts, as data. Each row redirects `routes` (react-router patterns) to `to`:
 * - "path": keep the rest of the path, the query and the hash (`/threads/abc?x=1` becomes `/findings/abc?x=1`);
 * - "query": land on `to` and keep only the query and the hash;
 * - "none": land on `to` as written.
 * Sunset: these exist for bookmarks, old emails, docs and CLI output from before the current names. Drop a row once no
 * supported release prints that URL; the 404 page then takes over. The current names are the ones in WORKSPACE_DESTINATIONS
 * plus /agents, /findings, /scope and /runs/:scanId.
 */
export interface LegacyRedirect { readonly from: string; readonly routes: readonly string[]; readonly to: string; readonly keep: "path" | "query" | "none" }
export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
  { from: "/onboarding", routes: ["/onboarding", "/setup", "/console/setup", "/console/onboarding"], to: "/chats", keep: "none" },
  { from: "/learning", routes: ["/learning", "/lessons"], to: "/memory", keep: "query" },
  { from: "/runs", routes: ["/runs", "/dashboard", "/live"], to: "/findings", keep: "none" },
  { from: "/sentinels", routes: ["/sentinels", "/sentinels/:sentinelId"], to: "/agents", keep: "path" },
  { from: "/operations", routes: ["/operations"], to: "/dashboard", keep: "path" },
  { from: "/threads", routes: ["/threads", "/threads/:fingerprint"], to: "/findings", keep: "path" },
  { from: "/scans", routes: ["/scans", "/scans/:scanId"], to: "/runs", keep: "path" },
  { from: "/workflows", routes: ["/workflows"], to: "/automations", keep: "path" },
  { from: "/audits", routes: ["/audits"], to: "/automations", keep: "path" },
  { from: "/launcher", routes: ["/launcher"], to: "/automations", keep: "path" },
  { from: "/launch", routes: ["/launch"], to: "/automations", keep: "path" },
  { from: "/console", routes: ["/console", "/console/*"], to: "/chats", keep: "path" },
  { from: "/workers", routes: ["/workers", "/workers/*"], to: "/computers", keep: "path" },
  { from: "/engines", routes: ["/engines"], to: "/computers", keep: "path" },
  { from: "/engagements", routes: ["/engagements", "/engagements/*"], to: "/scope", keep: "path" },
  { from: "/explore", routes: ["/explore", "/plugins/explore"], to: "/extensions", keep: "none" },
  { from: "/plugins", routes: ["/plugins", "/plugins/:pluginId"], to: "/extensions", keep: "none" },
  { from: "/skills", routes: ["/skills", "/skills/*"], to: "/plugins/skills", keep: "path" },
];

/** Compatibility URLs remain accepted, but share one canonical page identity. */
export function canonicalWorkspacePath(path: string): string {
  const row = LEGACY_REDIRECTS.find(item => item.keep === "path" && new RegExp(`^${item.from}(?=/|$)`).test(path));
  return row ? `${row.to}${path.slice(row.from.length)}` : path;
}
