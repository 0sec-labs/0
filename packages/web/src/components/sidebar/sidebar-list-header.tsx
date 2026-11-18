import { Ellipsis, Plus, Search } from "lucide-react";
import type { SidebarDensity } from "@/lib/sidebar-rows";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { SidebarModeToggle } from "./sidebar-mode-toggle";

/** Section header shared by both lists: 32px, with the list's name read by screen readers only (the active icon below says which list this is), then a fixed right-hand group in the same order and positions in both modes: the icon Sentinels|Threads toggle, a 28px search, a 28px "+" and a 28px "..." menu with Sort by and Density. */
export function SidebarListHeader<Sort extends string>({ title, newLabel, onNew, searchLabel, onSearch, searchActive, sortLabel, sortOptions, sort, onSort, density, onDensity }: {
  title: string;
  newLabel: string;
  onNew: () => void;
  sortLabel: string;
  sortOptions: ReadonlyArray<{ value: Sort; label: string }>;
  sort: Sort;
  onSort: (sort: Sort) => void;
  density: SidebarDensity;
  onDensity: (density: SidebarDensity) => void;
  searchLabel: string;
  onSearch: (trigger: HTMLElement) => void;
  searchActive?: boolean;
}) {
  return <div className="mt-4 mb-2 flex h-8 shrink-0 items-center gap-1 px-2">
    <h2 className="sr-only">{title}</h2>
    <SidebarModeToggle />
    <span aria-hidden="true" className="min-w-0 flex-1" />
    <Tooltip content={searchLabel} side="bottom"><Button type="button" variant="ghost" size="icon-sm" aria-label={searchLabel} aria-pressed={searchActive} className="text-muted-foreground-1 aria-pressed:bg-foreground/8 aria-pressed:text-foreground" onClick={event => onSearch(event.currentTarget)}><Search /></Button></Tooltip>
    <Tooltip content={newLabel} side="bottom"><Button type="button" variant="ghost" size="icon-sm" aria-label={newLabel} className="text-muted-foreground-1" onClick={onNew}><Plus /></Button></Tooltip>
    <DropdownMenu>
      <Tooltip content={`${title} options`} side="bottom">
        <DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`${title} options`} className="text-muted-foreground-1" />}><Ellipsis /></DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Content align="end" sideOffset={4} className="w-48">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Sort by</DropdownMenu.Label>
          {sortOptions.map(option => <DropdownMenu.Item key={option.value} selected={sort === option.value} onClick={() => onSort(option.value)}>{option.label}</DropdownMenu.Item>)}
        </DropdownMenu.Group>
        <DropdownMenu.Group>
          <DropdownMenu.Label>Density</DropdownMenu.Label>
          <DropdownMenu.Item selected={density === "comfortable"} onClick={() => onDensity("comfortable")}>Comfortable</DropdownMenu.Item>
          <DropdownMenu.Item selected={density === "compact"} onClick={() => onDensity("compact")}>Compact</DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  </div>;
}
