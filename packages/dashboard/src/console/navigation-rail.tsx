import { NavLink } from "react-router-dom";
import { MessageSquare, ShieldCheck, Plug, Settings, Workflow } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/** Navigation expands over the workspace, keeping the transcript in place. */
export function ConsoleNavigationRail({ settingsHref }: { settingsHref: string }) {
  const control = "flex h-9 w-full shrink-0 items-center gap-3 overflow-hidden rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
  const icon = "mx-[9px] size-[18px] shrink-0";
  const label = "whitespace-nowrap text-sm opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100";
  const destinations = [
    { to: "/console?new=1", label: "Home", icon: MessageSquare },
    { to: "/findings", label: "Findings", icon: ShieldCheck },
    { to: "/runs", label: "Activity", icon: Workflow },
    { to: "/plugins", label: "Integrations", icon: Plug },
  ];
  return <div className="relative hidden w-14 shrink-0 lg:block">
    <nav aria-label="Workspace navigation" className="group absolute inset-y-0 left-0 z-40 flex w-14 flex-col gap-2 overflow-hidden bg-background px-2 py-3 transition-[width,box-shadow] duration-150 ease-out motion-reduce:transition-none focus-within:w-56 focus-within:shadow-xl [@media(hover:hover)]:hover:w-56 [@media(hover:hover)]:hover:shadow-xl">
      <NavLink to="/console?new=1" title="0.security" aria-label="0.security home" className="mb-3 flex h-9 shrink-0 items-center gap-3 overflow-hidden rounded-xl transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><BrandMark compact className="mx-1 size-7 shrink-0" /><span className={cn(label, "font-medium")}>0.security</span></NavLink>
      {destinations.map(({ to, label: text, icon: Icon }) => <NavLink key={to} to={to} title={text} aria-label={text} className={({ isActive }) => cn(control, isActive && "bg-muted text-foreground")}><Icon className={icon} /><span className={label}>{text}</span></NavLink>)}
      <NavLink to={settingsHref} title="Settings" aria-label="Settings" className={({ isActive }) => cn(control, "mt-auto", isActive && "bg-muted text-foreground")}><Settings className={icon} /><span className={label}>Settings</span></NavLink>
    </nav>
  </div>;
}
