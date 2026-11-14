import { useState } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { Plus } from "lucide-react";
import { v } from "@/lib/vocabulary";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { SidebarGroup, SidebarLabel, sidebarItemClasses } from "@/ui/components/sidebar";
import { useSentinels } from "@/sentinels/api";
import { orderSentinels, presentStatus, sentinelHref } from "@/sentinels/model";
import { formatRelativeAge } from "@/lib/relative-time";
import { CreateSentinelDialog } from "./create-sentinel-dialog";
import { SentinelAvatar } from "./sentinel-avatar";

/** Sidebar group of Sentinels. Renders nothing on servers that predate them. */
export function SentinelSidebarSection() {
  const { supported, sentinels, isError, isLoading } = useSentinels();
  const navigate = useNavigate();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  if (!supported || isError || isLoading) return null;
  const rows = orderSentinels(sentinels);
  return <SidebarGroup aria-label={v("{Sentinels}")}>
    <div className="flex h-7 items-center justify-between pr-0.5 pl-2">
      <NavLink to="/sentinels" end className="text-xs font-medium text-muted-foreground-2 outline-none hover:text-foreground focus-visible:outline-ring-inset">{v("{Sentinels}")}</NavLink>
      <Tooltip content={v("New {sentinel}")} side="bottom"><Button type="button" variant="ghost" size="icon-xs" aria-label={v("New {sentinel}")} className="text-muted-foreground-1" onClick={() => setCreating(true)}><Plus /></Button></Tooltip>
    </div>
    {rows.length === 0 && <button type="button" className={sidebarItemClasses} onClick={() => setCreating(true)}><Plus aria-hidden="true" /><SidebarLabel>{v("Add {a sentinel}")}</SidebarLabel></button>}
    {rows.map(sentinel => {
      const status = presentStatus(sentinel);
      const href = sentinelHref(sentinel.id);
      const active = location.pathname.endsWith(`/sentinels/${encodeURIComponent(sentinel.id)}`);
      return <NavLink key={sentinel.id} to={href} data-active={active || undefined} aria-label={`${sentinel.name}, ${status.label}`} className={sidebarItemClasses}>
        <SentinelAvatar sentinel={sentinel} size="xs" dot />
        <SidebarLabel className={status.needsYou ? "font-semibold text-foreground" : undefined}>{sentinel.name}</SidebarLabel>
        {status.needsYou ? <span className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] leading-4 font-medium text-amber-700 dark:text-amber-200">Needs you</span>
          : <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground-2">{status.label === "Paused" ? "Paused" : formatRelativeAge(Date.parse(sentinel.updatedAt))}</span>}
      </NavLink>;
    })}
    <CreateSentinelDialog open={creating} onOpenChange={setCreating} onCreated={sentinel => { setCreating(false); navigate(sentinelHref(sentinel.id)); }} />
  </SidebarGroup>;
}
