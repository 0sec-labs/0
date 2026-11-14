import { Activity, BookOpen, Library, MessageSquare, Plug, Server, Settings, ShieldCheck, Workflow } from "lucide-react";

/** One destination inventory for desktop and touch navigation. */
export const WORKSPACE_DESTINATIONS = [
  { to: "/chats", label: "Chat", icon: MessageSquare },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/findings", label: "Findings", icon: ShieldCheck },
  { to: "/automations", label: "Automations", icon: Workflow },
  { to: "/plugins/skills", label: "Skills", icon: Library },
  { to: "/engines", label: "Engines", icon: Server },
  { to: "/plugins", label: "Plugins", icon: Plug },
  { to: "/learning", label: "Memory", icon: BookOpen },
  { to: "/settings", label: "Settings", icon: Settings },
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
