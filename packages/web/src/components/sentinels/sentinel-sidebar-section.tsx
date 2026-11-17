import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { v } from "@/lib/vocabulary";
import { SidebarGroup, SidebarScroll } from "@/ui/components/sidebar";
import { useSentinels } from "@/sentinels/api";
import { orderSentinels } from "@/sentinels/model";
import { agentRow, sortAgents, type AgentSort } from "@/lib/sidebar-rows";
import { SidebarListHeader } from "@/components/sidebar/sidebar-list-header";
import { RowAge, RowSubline, RowTitleLine, sidebarRowClasses } from "@/components/sidebar/sidebar-row";
import { rowNavigation } from "@/components/sidebar/use-row-navigation";
import { useAgentSort, useSidebarDensity } from "@/components/sidebar/use-sidebar-list";
import { openNewAgent } from "@/lib/new-agent";
import { SentinelAvatar } from "./sentinel-avatar";

const SORTS: ReadonlyArray<{ value: AgentSort; label: string }> = [{ value: "recent", label: "Recent" }, { value: "name", label: "Name" }];

/** The Agents list: header, then 52px rows (avatar with status badge, title and age, last activity or job line). */
export function SentinelSidebarSection() {
  const { supported, sentinels, isLoading } = useSentinels();
  const location = useLocation();
  const [sort, setSort] = useAgentSort();
  const [density, setDensity] = useSidebarDensity();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  if (!supported) return null;
  const now = Date.now();
  const items = sortAgents(orderSentinels(sentinels), sort).map(agent => ({ agent, row: agentRow(agent, now) })).filter(({ row, agent }) => !searching || !query.trim() || `${row.name} ${agent.mission}`.toLowerCase().includes(query.trim().toLowerCase()));
  const compact = density === "compact";
  return <>
    <SidebarListHeader title={v("{Sentinels}")} newLabel={v("New {sentinel}")} onNew={openNewAgent} sortLabel="Sort by" sortOptions={SORTS} sort={sort} onSort={setSort} density={density} onDensity={setDensity} searchLabel={v("Search {sentinels}")} searchActive={searching} onSearch={() => { setSearching(!searching); setQuery(""); }} />
    {searching && <div className="shrink-0 px-2 pb-1"><input autoFocus aria-label={v("Search {sentinels}")} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setSearching(false); setQuery(""); } }} placeholder="Filter by name" className="h-7 w-full rounded-md bg-secondary px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground-1 focus-visible:outline-ring-inset" /></div>}
    {/* Loading rule: nothing is drawn while the first list is in flight. */}
    <SidebarScroll id="navigation-agents" onKeyDown={rowNavigation}>
    <SidebarGroup aria-label={v("{Sentinels}")} className="gap-0 px-0.5 py-0">
      {!isLoading && items.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{v("No {sentinels} yet.")}</p>}
      {items.map(({ agent, row }) => {
        const active = location.pathname.endsWith(`/agents/${encodeURIComponent(row.id)}`);
        return <NavLink key={row.id} to={row.href} data-sidebar-row data-active={active || undefined} aria-label={`${row.name}, ${row.badgeLabel}`} className={sidebarRowClasses(density)}>
          <SentinelAvatar sentinel={agent} badge={row.badge} size={compact ? "xs" : "md"} />
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <RowTitleLine title={row.name} trailing={row.needsYou ? <RowAge className="text-primary-ink">needs you</RowAge> : <RowAge>{row.age}</RowAge>} />
            {!compact && <RowSubline className={row.subtitle.tone === "accent" ? "text-primary-ink" : undefined}>{row.subtitle.text}</RowSubline>}
          </span>
        </NavLink>;
      })}
    </SidebarGroup>
    </SidebarScroll>
  </>;
}
