import { VOCAB } from "@/lib/vocabulary";
import { CapyAutomationsIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyGlobeIcon, CapyIssueDashedIcon, CapyPlugIcon, CapySettingsIcon, CapySparkleFourIcon, CapyThreadListIcon } from "@/ui/icons/capy";

/** One destination inventory for desktop and touch navigation. */
export const WORKSPACE_DESTINATIONS = [
  { to: "/chats", label: VOCAB.mission.Plural, icon: CapyThreadListIcon },
  { to: "/findings", label: "Findings", icon: CapyIssueDashedIcon },
  { to: "/automations", label: "Automations", icon: CapyAutomationsIcon },
  { to: "/plugins/skills", label: "Skills", icon: CapySparkleFourIcon },
  { to: "/memory", label: "Memory", icon: CapyDatabaseIcon },
  { to: "/computers", label: "Computers", icon: CapyDevicesIcon },
  { to: "/plugins/explore", label: "Explore", icon: CapyGlobeIcon },
  { to: "/plugins", label: "Plugins", icon: CapyPlugIcon },
  { to: "/settings", label: "Settings", icon: CapySettingsIcon },
] as const;

/**
 * The sidebar: "New thread" (an action, not a route) followed by these six destinations, in this order. There is no More menu.
 * Skills is active on /plugins/skills* (installed, browse, catalog detail); Explore on every other /plugins* page.
 */
export const SIDEBAR_DESTINATIONS = ["/findings", "/automations", "/plugins/skills", "/memory", "/computers", "/plugins/explore"] as const;

/** Whether a sidebar destination is highlighted for the (canonical, basename-free) current path. */
export function isSidebarDestinationActive(to: string, currentPath: string): boolean {
  const under = (base: string) => currentPath === base || currentPath.startsWith(`${base}/`);
  if (to === "/plugins/explore") return under("/plugins") && !under("/plugins/skills");
  return under(to);
}

/** Compatibility URLs remain accepted, but share one canonical page identity. */
export function canonicalWorkspacePath(path: string): string {
  return path.replace(/^\/(operations|threads|scans|workflows|audits|launcher|launch|console|workers|engines|engagements|skills)(?=\/|$)/, (_, name: string) => {
    if (name === "operations") return "/dashboard";
    if (name === "threads") return "/findings";
    if (name === "scans") return "/runs";
    if (name === "console") return "/chats";
    if (name === "workers" || name === "engines") return "/computers";
    if (name === "engagements") return "/scope";
    if (name === "skills") return "/plugins/skills";
    return "/automations";
  });
}

/** Old Explore > Skills links (`/plugins/explore?tab=skills`) now land on Skills > Browse; null for every other Explore URL. */
export function legacyExploreSkillsRedirect(search: string): string | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (tab !== "skills" && tab !== "skill") return null;
  const target = new URLSearchParams({ tab: "browse" });
  const q = params.get("q");
  if (q) target.set("q", q);
  return `/plugins/skills?${target}`;
}
