import { matchPath } from "react-router-dom";
import { VOCAB } from "@/lib/vocabulary";
import { CapyAgentIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyIssueDashedIcon, CapyPuzzleIcon, CapySettingsIcon, CapySparkleFourIcon, CapyThreadListIcon } from "@/ui/icons/capy";

/** One destination inventory for desktop and touch navigation. */
export const WORKSPACE_DESTINATIONS = [
  { to: "/chats", label: VOCAB.mission.Plural, icon: CapyThreadListIcon },
  { to: "/findings", label: "Findings", icon: CapyIssueDashedIcon },
  { to: "/sentinels", label: "Sentinels", icon: CapyAgentIcon },
  { to: "/skills", label: "Skills", icon: CapySparkleFourIcon },
  { to: "/computers", label: "Computers", icon: CapyDevicesIcon },
  { to: "/extensions", label: "Extensions", icon: CapyPuzzleIcon },
  { to: "/settings", label: "Settings", icon: CapySettingsIcon },
] as const;

/**
 * The sidebar: "New thread" (an action, not a route) followed by these five destinations, in this order. There is no More menu.
 * Sentinels are their own sidebar section below these (header, "+" and one row per Sentinel); automations live inside a Sentinel.
 * Skills is active on /skills* (installed, browse, catalog detail); Extensions on /extensions.
 */
export const SIDEBAR_DESTINATIONS = ["/findings", "/skills", "/computers", "/extensions"] as const;

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
 * Sunset: these exist for bookmarks, old emails, docs and CLI output from 0.33 and later. Rows for pages that were deleted
 * (reports, scans, engagements, the automations list, Explore and Plugins) land on the page that replaced them. Drop a row
 * once no supported release prints that URL; the 404 page then takes over. The current names are the ones in
 * WORKSPACE_DESTINATIONS plus /findings, /models, /settings, /team and /api-access.
 */
export interface LegacyRedirect { readonly from: string; readonly routes: readonly string[]; readonly to: string; readonly keep: "path" | "query" | "none" }
export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
  { from: "/onboarding", routes: ["/onboarding", "/setup", "/console/setup", "/console/onboarding"], to: "/chats", keep: "none" },
  { from: "/learning", routes: ["/learning", "/lessons", "/memory"], to: "/chats", keep: "none" },
  { from: "/runs", routes: ["/runs", "/runs/:scanId", "/dashboard", "/live", "/operations", "/scans", "/scans/:scanId", "/scope", "/engagements", "/engagements/*"], to: "/findings", keep: "none" },
  { from: "/agents", routes: ["/agents", "/agents/:sentinelId"], to: "/sentinels", keep: "path" },
  { from: "/threads", routes: ["/threads", "/threads/:fingerprint"], to: "/findings", keep: "path" },
  { from: "/automations", routes: ["/automations", "/workflows", "/audits", "/launcher", "/launch"], to: "/sentinels", keep: "query" },
  { from: "/console", routes: ["/console", "/console/*"], to: "/chats", keep: "path" },
  { from: "/workers", routes: ["/workers", "/workers/*"], to: "/computers", keep: "path" },
  { from: "/engines", routes: ["/engines"], to: "/computers", keep: "path" },
  { from: "/explore", routes: ["/explore", "/plugins/explore"], to: "/extensions", keep: "none" },
  { from: "/plugins/skills", routes: ["/plugins/skills", "/plugins/skills/*"], to: "/skills", keep: "path" },
  { from: "/plugins", routes: ["/plugins", "/plugins/:pluginId"], to: "/extensions", keep: "none" },
];

/** Compatibility URLs remain accepted, but share one canonical page identity. */
export function canonicalWorkspacePath(path: string): string {
  const row = LEGACY_REDIRECTS.find(item => item.keep === "path" && new RegExp(`^${item.from}(?=/|$)`).test(path));
  return row ? `${row.to}${path.slice(row.from.length)}` : path;
}

/** The three page layouts (components/page-shell.tsx). */
export type PageVariant = "list" | "form" | "full";
/** Content widths in px. styles.css publishes the same numbers as --page-width-list / --page-width-form; a test keeps them equal. */
export const PAGE_WIDTHS = { list: 872, form: 672 } as const;

/**
 * Every page route and the layout it uses. The shell is applied centrally (RoutedPageShell), so a page never sets its own width
 * or padding. First match wins; a path that matches nothing is the not-found page, which is `list`.
 * A page whose layout depends on its own state can override it with usePageVariant.
 */
export const PAGE_ROUTES: readonly { readonly path: string; readonly variant: PageVariant }[] = [
  { path: "/chats", variant: "full" },
  { path: "/chats/saved/:savedId", variant: "full" },
  { path: "/chats/:sessionId", variant: "full" },
  { path: "/sentinels", variant: "list" },
  { path: "/sentinels/:sentinelId", variant: "list" },
  { path: "/skills", variant: "list" },
  { path: "/skills/catalog/:id", variant: "list" },
  { path: "/memory", variant: "list" },
  { path: "/computers", variant: "list" },
  { path: "/extensions", variant: "list" },
  { path: "/findings", variant: "full" },
  { path: "/findings/:fingerprint", variant: "full" },
  { path: "/settings", variant: "form" },
  { path: "/connections", variant: "list" },
  { path: "/models", variant: "list" },
  { path: "/doctor", variant: "list" },
  { path: "/tools", variant: "list" },
  { path: "/project", variant: "list" },
  { path: "/team", variant: "list" },
  { path: "/api-access", variant: "list" },
];

export function pageVariantFor(pathname: string): PageVariant {
  return PAGE_ROUTES.find(route => matchPath({ path: route.path, end: true }, pathname))?.variant ?? "list";
}
