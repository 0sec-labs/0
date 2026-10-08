import { TeamAccount } from "@/components/team-access";
import { NavLink } from "react-router-dom";
import { BookOpen, MessageSquare, ShieldCheck, Plug, Settings, Workflow } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";

/** Navigation expands over the workspace, keeping the transcript in place. */
export function ConsoleNavigationRail({ settingsHref }: { settingsHref: string }) {
  const { getDashboard } = useBackendApi();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard, refetchInterval: 3000 });
  const findingCount = dashboard.data?.groups.filter(group => group.latest.triageStatus !== "suppressed").length ?? 0;
  const control = "flex h-10 w-full shrink-0 items-center gap-3 overflow-hidden rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
  const icon = "mx-[11px] size-[18px] shrink-0";
  const label = "whitespace-nowrap text-sm opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-has-[:focus-visible]:opacity-100 [@media(hover:hover)]:group-hover:opacity-100";
  const destinations = [
    { to: "/console?new=1", label: "Chat", icon: MessageSquare },
    { to: "/findings", label: "Findings", icon: ShieldCheck },
    { to: "/workflows", label: "Workflows", icon: Workflow },
    { to: "/plugins", label: "Plugins", icon: Plug },
    { to: "/learning", label: "Learning", icon: BookOpen },
  ];
  return <div className="relative hidden w-14 shrink-0 lg:block">
    <nav aria-label="Command Center navigation" className="group absolute inset-y-0 left-0 z-40 flex w-14 flex-col gap-2 overflow-hidden bg-background px-2 py-3 transition-[width,box-shadow] duration-150 ease-out motion-reduce:transition-none has-[:focus-visible]:w-56 has-[:focus-visible]:shadow-xl [@media(hover:hover)]:hover:w-56 [@media(hover:hover)]:hover:shadow-xl">
      <NavLink to="/console?new=1" aria-label="0.security home" className="relative mb-3 flex h-10 shrink-0 items-center overflow-hidden rounded-xl transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><BrandMark compact className="mx-1.5 size-7 shrink-0 transition-opacity duration-150 motion-reduce:transition-none group-has-[:focus-visible]:opacity-0 [@media(hover:hover)]:group-hover:opacity-0" /><BrandMark className={cn(label, "pointer-events-none absolute left-1 w-48 shrink-0")} /></NavLink>
      {destinations.map(({ to, label: text, icon: Icon }) => <NavLink key={to} to={to} title={text === "Findings" ? `${text} (${findingCount})` : text} aria-label={text === "Findings" ? `${text} (${findingCount})` : text} className={({ isActive }) => cn(control, "relative", isActive && "bg-muted text-foreground")}><Icon className={icon} />{text === "Findings" && findingCount > 0 && <span aria-hidden="true" className="absolute left-6 top-1 min-w-3 rounded-full bg-primary px-0.5 text-center text-[9px] leading-3 text-primary-foreground">{findingCount > 99 ? "99+" : findingCount}</span>}<span className={label}>{text}</span></NavLink>)}
      <div className="mt-auto flex flex-col gap-1">
        <span aria-label={`Version ${__ZERO_VERSION__}`} title={`0.security v${__ZERO_VERSION__}`} className="block text-center font-mono text-[9px] leading-4 tracking-tight text-muted-foreground/60">v{__ZERO_VERSION__}</span>
        <NavLink to={settingsHref} title="Settings" aria-label="Settings" className={({ isActive }) => cn(control, isActive && "bg-muted text-foreground")}><Settings className={icon} /><span className={label}>Settings</span></NavLink>
        <TeamAccount rail />
      </div>
    </nav>
  </div>;
}
