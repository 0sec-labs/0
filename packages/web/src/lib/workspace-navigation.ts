import { VOCAB } from "@/lib/vocabulary";
import { CapyAutomationsIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyGlobeIcon, CapyIssueDashedIcon, CapyPlugIcon, CapySettingsIcon, CapySparkleFourIcon, CapyThreadListIcon } from "@/ui/icons/capy";

/** One destination inventory for desktop and touch navigation. */
export const WORKSPACE_DESTINATIONS = [
  { to: "/chats", label: VOCAB.mission.Plural, icon: CapyThreadListIcon },
  { to: "/findings", label: "Findings", icon: CapyIssueDashedIcon },
  { to: "/automations", label: "Automations", icon: CapyAutomationsIcon },
  { to: "/plugins/skills", label: "Skills", icon: CapySparkleFourIcon },
  { to: "/engines", label: "Engines", icon: CapyDevicesIcon },
  { to: "/plugins/explore", label: "Explore", icon: CapyGlobeIcon },
  { to: "/plugins", label: "Plugins", icon: CapyPlugIcon },
  { to: "/learning", label: "Memory", icon: CapyDatabaseIcon },
  { to: "/settings", label: "Settings", icon: CapySettingsIcon },
] as const;

/** Compatibility URLs remain accepted, but share one canonical page identity. */
export function canonicalWorkspacePath(path: string): string {
  return path.replace(/^\/(operations|threads|scans|workflows|audits|launcher|launch|console|workers|engagements|skills)(?=\/|$)/, (_, name: string) => {
    if (name === "operations") return "/dashboard";
    if (name === "threads") return "/findings";
    if (name === "scans") return "/runs";
    if (name === "console") return "/chats";
    if (name === "workers") return "/engines";
    if (name === "engagements") return "/scope";
    if (name === "skills") return "/plugins/skills";
    return "/automations";
  });
}
