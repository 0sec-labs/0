import { useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { CapyCheckIcon as Check, CapyChevronRightIcon as ChevronRight, CapyPlusIcon as Plus, CapySearchIcon as Search } from "@/ui/icons/capy";
import { Button } from "@/ui/components/button";
import { Popover } from "@/ui/components/popover";
import { Tooltip } from "@/ui/components/tooltip";
import { cn } from "@/ui/lib/utils";
import { AGENT_ROW_CAP, buildViewMenu, flattenMenuRows, handleMenuKey, type PanelViewCounts, type ViewMenuRow } from "./view-menu-model";
import { shortcutLabel } from "./shortcut-label";
import type { PanelAgentSummary, PanelViewId } from "./types";

const STATUS_DOT: Record<PanelAgentSummary["status"], string> = {
  queued: "bg-muted-foreground-3", running: "bg-success", parked: "bg-warning", completed: "bg-muted-foreground-2", failed: "bg-destructive", stopped: "bg-muted-foreground-3",
};

export type ViewMenuContentProps = {
  /** Popover title, normally the chat title. */
  title?: string;
  counts?: PanelViewCounts;
  agents?: readonly PanelAgentSummary[];
  /** Views that already have a tab; they get a check. */
  openViews?: ReadonlySet<PanelViewId> | readonly PanelViewId[];
  onSelect: (id: PanelViewId, row: ViewMenuRow) => void;
  className?: string;
};

const rowClass = "flex h-7 w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 text-left text-sm outline-none select-none data-[highlighted]:bg-[var(--popover-hover,color-mix(in_oklch,var(--foreground)_8%,transparent))]";

/** Searchable view list: Views and Agents sections, shortcut hints, check on open views. Arrow keys and Enter work from the search field. */
export function ViewMenuContent({ title, counts, agents, openViews, onSelect, className }: ViewMenuContentProps) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const listId = useId();
  const sections = useMemo(() => buildViewMenu({ counts, agents, query, showAllAgents: showAll }), [counts, agents, query, showAll]);
  const rows = useMemo(() => flattenMenuRows(sections), [sections]);
  const open = useMemo(() => new Set(openViews ?? []), [openViews]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { setHighlight(query ? 0 : -1); }, [query, showAll]);
  useEffect(() => { list.current?.querySelector("[data-highlighted]")?.scrollIntoView({ block: "nearest" }); }, [highlight]);
  const choose = (row: ViewMenuRow) => {
    if (row.kind === "show-all") { setShowAll(true); return; }
    onSelect(row.id, row);
  };
  let index = -1;
  return <div className={cn("flex w-72 max-w-[calc(100vw-2rem)] flex-col", className)} data-slot="view-menu">
    {title && <div className="truncate px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground-1">{title}</div>}
    <div className="flex h-8 items-center gap-2 px-3 text-muted-foreground-2">
      <Search aria-hidden="true" className="size-(--icon-sm) shrink-0" />
      <input
        autoFocus
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          const result = handleMenuKey(event.key, highlight, rows);
          if (!result) return;
          event.preventDefault();
          setHighlight(result.highlight);
          if (result.select) choose(result.select);
        }}
        placeholder="Search views..."
        aria-label="Search views"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground-3"
      />
    </div>
    <div ref={list} id={listId} role="listbox" aria-label="Views" className="flex max-h-80 min-h-0 flex-col overflow-y-auto overscroll-contain scroll-fade-y px-1 pb-1">
      {sections.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground-2">No matching views</p>}
      {sections.map(section => <div key={section.label} role="group" aria-label={section.label} className="flex flex-col">
        <div className="px-2 pt-2 pb-1 text-2xs text-muted-foreground-2">{section.label}</div>
        {section.rows.map(row => {
          index += 1;
          const current = index;
          const common = { id: `${listId}-${current}`, role: "option" as const, "aria-selected": row.kind !== "show-all" && open.has(row.id), "data-highlighted": highlight === current ? "" : undefined, onMouseMove: () => setHighlight(current), onClick: () => choose(row) };
          if (row.kind === "show-all") return <button key="show-all" type="button" {...common} className={cn(rowClass, "text-xs text-muted-foreground-1")}>Show all {row.hidden + AGENT_ROW_CAP}</button>;
          if (row.kind === "agent") return <button key={row.id} type="button" {...common} className={rowClass}>
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[row.agent.status])} />
            <span className="shrink-0 font-medium">{row.agent.name}</span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground-2">{row.agent.task}</span>
            <ChevronRight aria-hidden="true" className="size-(--icon-xs) shrink-0 text-muted-foreground-3" />
          </button>;
          const Icon = row.view.icon;
          return <button key={row.id} type="button" {...common} className={rowClass}>
            <Icon aria-hidden="true" className="size-(--icon-sm) shrink-0 text-muted-foreground-1" />
            <span className="min-w-0 flex-1 truncate">{row.view.title}</span>
            {open.has(row.id) && <Check aria-label="Open" className="size-(--icon-sm) shrink-0 text-muted-foreground-1" />}
            {row.badge && <span className="shrink-0 text-2xs text-muted-foreground-2 tabular-nums">{row.badge}</span>}
            {row.view.shortcut && <span className="shrink-0 text-2xs text-muted-foreground-2">{shortcutLabel(row.view.shortcut)}</span>}
          </button>;
        })}
      </div>)}
    </div>
  </div>;
}

export type ViewMenuProps = Omit<ViewMenuContentProps, "onSelect" | "className"> & {
  onSelect: ViewMenuContentProps["onSelect"];
  /** Replace the default 28px ghost `+` button. */
  trigger?: ReactElement;
  /** Extra content for the trigger tooltip. */
  tooltip?: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
};

/** Standalone `+` button with the view popover. Also what the Dockview group header action renders. */
export function ViewMenu({ trigger, tooltip = "Add view", align = "end", side = "bottom", onSelect, ...content }: ViewMenuProps) {
  const [open, setOpen] = useState(false);
  const button = trigger ?? <Button variant="ghost" size="icon-sm" aria-label="Add view"><Plus aria-hidden="true" /></Button>;
  return <Popover open={open} onOpenChange={setOpen}>
    <Tooltip content={tooltip}><Popover.Trigger render={button} /></Tooltip>
    <Popover.Content align={align} side={side} sideOffset={6} className="p-0 py-1">
      <ViewMenuContent {...content} onSelect={(id, row) => { setOpen(false); onSelect(id, row); }} />
    </Popover.Content>
  </Popover>;
}
