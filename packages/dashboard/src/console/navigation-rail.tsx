import { NavLink } from "react-router-dom";
import { MessageSquare, Plus, Search, ShieldCheck, Workflow, Plug, Settings } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/** Compact workspace navigation; conversation history stays in its own sidebar. */
export function ConsoleNavigationRail({ onNew, onSearch, settingsHref }: {
  onNew: () => void;
  onSearch: () => void;
  settingsHref: string;
}) {
  const control = "flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
  return <nav aria-label="Workspace navigation" className="hidden w-14 shrink-0 flex-col items-center gap-2 bg-background px-2 py-3 lg:flex">
    <NavLink to="/console" title="0.security" aria-label="0.security home" className="mb-3 flex size-9 items-center justify-center rounded-full transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><BrandMark compact className="size-7" /></NavLink>
    <NavLink to="/console" title="Chats" aria-label="Chats" className={({ isActive }) => cn(control, isActive && "bg-muted text-foreground")}><MessageSquare className="size-[18px]" /></NavLink>
    <button type="button" title="New chat" aria-label="New chat" className={control} onClick={onNew}><Plus className="size-[18px]" /></button>
    <button type="button" title="Search chats" aria-label="Search chats" className={control} onClick={onSearch}><Search className="size-[18px]" /></button>
    <div className="h-2" />
    <NavLink to="/findings" title="Findings" aria-label="Findings" className={({ isActive }) => cn(control, isActive && "bg-muted text-foreground")}><ShieldCheck className="size-[18px]" /></NavLink>
    <NavLink to="/runs" title="Runs" aria-label="Runs" className={({ isActive }) => cn(control, isActive && "bg-muted text-foreground")}><Workflow className="size-[18px]" /></NavLink>
    <NavLink to="/plugins" title="Integrations" aria-label="Integrations" className={({ isActive }) => cn(control, isActive && "bg-muted text-foreground")}><Plug className="size-[18px]" /></NavLink>
    <NavLink to={settingsHref} title="Settings" aria-label="Settings" className={({ isActive }) => cn(control, "mt-auto", isActive && "bg-muted text-foreground")}><Settings className="size-[18px]" /></NavLink>
  </nav>;
}
