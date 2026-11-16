import { useState } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { v } from "@/lib/vocabulary";
import { SidebarGroup, SidebarScroll } from "@/ui/components/sidebar";
import { useSentinels } from "@/sentinels/api";
import { orderSentinels, sentinelHref } from "@/sentinels/model";
import { agentRow, sortAgents, type AgentSort } from "@/lib/sidebar-rows";
import { SidebarListHeader } from "@/components/sidebar/sidebar-list-header";
import { RowAge, RowSubline, RowTitleLine, sidebarRowClasses } from "@/components/sidebar/sidebar-row";
import { rowNavigation } from "@/components/sidebar/use-row-navigation";
import { useAgentSort, useSidebarDensity } from "@/components/sidebar/use-sidebar-list";
import { CreateSentinelDialog } from "./create-sentinel-dialog";
import { SentinelAvatar } from "./sentinel-avatar";

const SORTS: ReadonlyArray<{ value: AgentSort; label: string }> = [{ value: "recent", label: "Recent" }, { value: "name", label: "Name" }];

/** The Agents list: header, then 52px rows (avatar with status badge, title and age, last activity or job line). */
export function SentinelSidebarSection() {
  const { supported, sentinels, isLoading } = useSentinels();
  const navigate = useNavigate();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useAgentSort();
  const [density, setDensity] = useSidebarDensity();
  if (!supported) return null;
  const now = Date.now();
  const items = sortAgents(orderSentinels(sentinels), sort).map(agent => ({ agent, row: agentRow(agent, now) }));
  const compact = density === "compact";
  return <>
    <SidebarListHeader title={v("{Sentinels}")} newLabel={v("New {sentinel}")} onNew={() => setCreating(true)} sortLabel="Sort by" sortOptions={SORTS} sort={sort} onSort={setSort} density={density} onDensity={setDensity} />
    {/* Loading rule: nothing is drawn while the first list is in flight. */}
    <SidebarScroll id="navigation-agents" onKeyDown={rowNavigation}>
    <SidebarGroup aria-label={v("{Sentinels}")} className="gap-0 px-0.5 py-0">
      {!isLoading && items.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{v("No {sentinels} yet.")}</p>}
      {items.map(({ agent, row }) => {
        const active = location.pathname.endsWith(`/agents/${encodeURIComponent(row.id)}`);
        return <NavLink key={row.id} to={row.href} data-sidebar-row data-active={active || undefined} aria-label={`${row.name}, ${row.badgeLabel}`} className={sidebarRowClasses(density)}>
          <SentinelAvatar sentinel={agent} badge={row.badge} size={compact ? "xs" : "md"} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <RowTitleLine title={row.name} trailing={<RowAge>{row.age}</RowAge>} />
            {!compact && <RowSubline className={row.subtitle.tone === "accent" ? "text-primary-ink" : undefined}>{row.subtitle.text}</RowSubline>}
          </span>
        </NavLink>;
      })}
    </SidebarGroup>
    </SidebarScroll>
    <CreateSentinelDialog open={creating} onOpenChange={setCreating} onCreated={sentinel => { setCreating(false); navigate(sentinelHref(sentinel.id)); }} />
  </>;
}
