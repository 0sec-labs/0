import { VOCAB } from "@/lib/vocabulary";
import { CapyAutomationsIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyIssueDashedIcon, CapyPlayIcon, CapyPlugIcon, CapySettingsIcon, CapySparkleFourIcon, CapyThreadListIcon } from "@/ui/icons/capy";

/** One destination inventory for desktop and touch navigation. */
export const WORKSPACE_DESTINATIONS = [
  { to: "/console", label: VOCAB.mission.Plural, icon: CapyThreadListIcon },
  { to: "/runs", label: "Runs", icon: CapyPlayIcon },
  { to: "/findings", label: "Findings", icon: CapyIssueDashedIcon },
  { to: "/automations", label: "Automations", icon: CapyAutomationsIcon },
  { to: "/skills", label: "Skills", icon: CapySparkleFourIcon },
  { to: "/workers", label: "Hosts", icon: CapyDevicesIcon },
  { to: "/plugins", label: "Plugins", icon: CapyPlugIcon },
  { to: "/learning", label: "Memory", icon: CapyDatabaseIcon },
  { to: "/settings", label: "Settings", icon: CapySettingsIcon },
] as const;

/** Compatibility URLs remain accepted, but share one canonical page identity. */
export function canonicalWorkspacePath(path: string): string {
  return path.replace(/^\/(operations|threads|scans|workflows|audits|launcher|launch)(?=\/|$)/, (_, name: string) => {
    if (name === "operations") return "/dashboard";
    if (name === "threads") return "/findings";
    if (name === "scans") return "/runs";
    return "/automations";
  });
}
