import { Columns3, Download, List } from "lucide-react";
import { CapyDocumentIcon as FileText, CapyMoreIcon as MoreHorizontal, CapySearchIcon as Search, CapySlidersIcon as SlidersHorizontal, CapyFilterIcon as ListFilter, CapyCloseIcon as X } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { REPORT_FORMATS, useReportDownload } from "@/components/report-export-control";
import { cn } from "@/lib/utils";
import { missionLabel } from "@/lib/vocabulary";
import { SeverityIcon, StatusIcon } from "./finding-icons";
import {
  GROUP_BY_OPTIONS, ORDER_BY_OPTIONS, PRESETS, SEVERITY_LABELS, SEVERITY_ORDER, STATUS_LABEL, STATUS_ORDER, activeFilterCount, missionName, toggleValue,
  type DisplayOptions, type FindingFilters, type FindingPreset, type MissionLabels,
} from "./findings-model";

type Facet = { value: string; count: number };

export type FindingsToolbarProps = {
  total: number;
  shown: number;
  preset: FindingPreset;
  presetCounts: Record<FindingPreset, number>;
  onPreset: (preset: FindingPreset) => void;
  display: DisplayOptions;
  onDisplay: (patch: Partial<DisplayOptions>) => void;
  filters: FindingFilters;
  onFilters: (next: FindingFilters) => void;
  categories: Facet[];
  missions: Facet[];
  missionNames: MissionLabels;
  search: string;
  onSearch: (value: string) => void;
  exportPath: string;
  exportCount: number;
  onOpenReports: () => void;
  searchRef?: React.Ref<HTMLInputElement>;
};

const iconButton = "size-7 text-muted-foreground-1";

export function FindingsToolbar(props: FindingsToolbarProps) {
  const { total, shown, preset, presetCounts, onPreset, display, onDisplay, filters, onFilters, search, onSearch } = props;
  const count = activeFilterCount(filters);
  const exporting = useReportDownload(props.exportPath);
  return (
    <div className="shrink-0">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1">
        <h1 className="mr-1 flex items-baseline gap-2 text-[13px] font-medium text-foreground">
          Findings
          <span className="text-xs font-normal tabular-nums text-muted-foreground-2" aria-label={`${shown} of ${total} findings`}>{shown === total ? total : `${shown} / ${total}`}</span>
        </h1>
        <div role="group" aria-label="Finding views" className="flex items-center gap-1">
          {PRESETS.map(item => (
            <button
              key={item.value}
              type="button"
              aria-pressed={preset === item.value}
              onClick={() => onPreset(item.value)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border-[0.5px] px-2.5 text-xs font-medium outline-none transition-colors duration-100 focus-visible:outline-ring-inset",
                preset === item.value ? "border-border-2 bg-secondary text-foreground" : "border-border-1 text-muted-foreground-1 hover:bg-section hover:text-foreground",
              )}
            >
              {item.label}
              {item.value !== "all" && presetCounts[item.value] > 0 ? <span className="tabular-nums text-muted-foreground-2">{presetCounts[item.value]}</span> : null}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <label className="relative hidden sm:block">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground-2" />
            <input
              ref={props.searchRef}
              type="search"
              aria-label="Search findings"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              value={search}
              onChange={event => onSearch(event.target.value)}
              placeholder="Search"
              className="h-7 w-40 rounded-md border-[0.5px] border-border-1 bg-transparent pr-2 pl-7 text-xs text-foreground outline-none transition-[width,background-color] duration-150 placeholder:text-muted-foreground-2 hover:bg-section focus:w-56 focus:bg-section focus-visible:outline-ring-inset"
            />
          </label>
          <FilterMenu {...props} />
          <DisplayMenu display={display} onDisplay={onDisplay} />
          <div role="group" aria-label="Layout" className="flex items-center rounded-md border-[0.5px] border-border-1 p-px">
            <Button variant="ghost" size="icon-xs" aria-label="List layout" aria-pressed={display.layout === "list"} data-selected={display.layout === "list" ? "" : undefined} className="size-6" onClick={() => onDisplay({ layout: "list" })}><List /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Board layout" aria-pressed={display.layout === "board"} data-selected={display.layout === "board" ? "" : undefined} className="size-6" onClick={() => onDisplay({ layout: "board" })}><Columns3 /></Button>
          </div>
          <DropdownMenu>
            <DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="More actions" className={iconButton} />}><MoreHorizontal /></DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" className="w-56">
              <DropdownMenu.Item icon={<FileText />} onClick={props.onOpenReports}>Assessment reports</DropdownMenu.Item>
              <DropdownMenu.Label>Export {props.exportCount} finding{props.exportCount === 1 ? "" : "s"}</DropdownMenu.Label>
              {REPORT_FORMATS.map(([format, label]) => (
                <DropdownMenu.Item key={format} icon={<Download />} disabled={props.exportCount === 0 || exporting.busy} onClick={() => void exporting.download(format)}>{label}</DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      </div>
      {exporting.error ? <p role="alert" className="px-3 pb-1 text-xs text-destructive">{exporting.error}</p> : null}
      {count > 0 ? <FilterChips {...props} /> : null}
    </div>
  );
}

function DisplayMenu({ display, onDisplay }: Pick<FindingsToolbarProps, "display" | "onDisplay">) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="Display options" className={iconButton} />}><SlidersHorizontal /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="w-60">
        <DropdownMenu.Label>Group by</DropdownMenu.Label>
        {GROUP_BY_OPTIONS.map(option => <DropdownMenu.Item key={option.value} selected={display.groupBy === option.value} onClick={() => onDisplay({ groupBy: option.value })}>{option.label}</DropdownMenu.Item>)}
        <DropdownMenu.Label>Order by</DropdownMenu.Label>
        {ORDER_BY_OPTIONS.map(option => <DropdownMenu.Item key={option.value} selected={display.orderBy === option.value} onClick={() => onDisplay({ orderBy: option.value })}>{option.label}</DropdownMenu.Item>)}
        <DropdownMenu.Label>Direction</DropdownMenu.Label>
        <DropdownMenu.Item selected={display.direction === "desc"} onClick={() => onDisplay({ direction: "desc" })}>Descending</DropdownMenu.Item>
        <DropdownMenu.Item selected={display.direction === "asc"} onClick={() => onDisplay({ direction: "asc" })}>Ascending</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function FilterMenu({ filters, onFilters, categories, missions, missionNames }: FindingsToolbarProps) {
  const count = activeFilterCount(filters);
  const keep = { closeOnClick: false } as const;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="Filter findings" className={cn(iconButton, count > 0 && "text-foreground")} />}>
        <ListFilter />
        {count > 0 ? <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" /> : null}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="w-60">
        <DropdownMenu.Label>Severity</DropdownMenu.Label>
        {SEVERITY_ORDER.map(level => (
          <DropdownMenu.Item key={level} {...keep} icon={<SeverityIcon severity={level} />} selected={filters.severity.includes(level)} onClick={() => onFilters({ ...filters, severity: toggleValue(filters.severity, level) })}>{SEVERITY_LABELS[level]}</DropdownMenu.Item>
        ))}
        <DropdownMenu.Label>Status</DropdownMenu.Label>
        {STATUS_ORDER.map(status => (
          <DropdownMenu.Item key={status} {...keep} icon={<StatusIcon status={status} />} selected={filters.status.includes(status)} onClick={() => onFilters({ ...filters, status: toggleValue(filters.status, status) })}>{STATUS_LABEL[status]}</DropdownMenu.Item>
        ))}
        <DropdownMenu.Label>Fix</DropdownMenu.Label>
        <DropdownMenu.Item {...keep} selected={filters.hasFixPr} onClick={() => onFilters({ ...filters, hasFixPr: !filters.hasFixPr })}>Has fix PR</DropdownMenu.Item>
        {categories.length > 0 ? <DropdownMenu.Label>Category</DropdownMenu.Label> : null}
        {categories.map(item => (
          <DropdownMenu.Item key={item.value} {...keep} selected={filters.category.includes(item.value)} onClick={() => onFilters({ ...filters, category: toggleValue(filters.category, item.value) })}>
            <span className="min-w-0 flex-1 truncate">{item.value}</span><span className="text-xs tabular-nums text-muted-foreground-2">{item.count}</span>
          </DropdownMenu.Item>
        ))}
        {missions.length > 0 ? <DropdownMenu.Label>{missionLabel}</DropdownMenu.Label> : null}
        {missions.map(item => (
          <DropdownMenu.Item key={item.value} {...keep} selected={filters.mission.includes(item.value)} onClick={() => onFilters({ ...filters, mission: toggleValue(filters.mission, item.value) })}>
            <span className="min-w-0 flex-1 truncate">{missionName(item.value, missionNames)}</span><span className="text-xs tabular-nums text-muted-foreground-2">{item.count}</span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

const chip = "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border-[0.5px] border-border-2 bg-card pr-0.5 pl-2 text-xs text-foreground";

function FilterChip({ label, values, onRemove }: { label: string; values: string; onRemove: () => void }) {
  return (
    <span className={chip}>
      <span className="text-muted-foreground-1">{label}</span>
      <span className="text-muted-foreground-2">{values.includes(", ") ? "is either of" : "is"}</span>
      <span className="min-w-0 truncate">{values}</span>
      <button type="button" aria-label={`Remove ${label} filter`} onClick={onRemove} className="grid size-5 place-items-center rounded-sm text-muted-foreground-2 outline-none hover:bg-secondary hover:text-foreground focus-visible:outline-ring-inset"><X className="size-3" /></button>
    </span>
  );
}

function FilterChips({ filters, onFilters, missionNames }: FindingsToolbarProps) {
  const multiple = activeFilterCount(filters) > 1;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5" role="group" aria-label="Active filters">
      {multiple ? (
        <Button variant="ghost" size="sm" className="h-6 bg-secondary px-2" onClick={() => onFilters({ ...filters, match: filters.match === "all" ? "any" : "all" })}>
          Match {filters.match === "all" ? "all filters" : "any filter"}
        </Button>
      ) : null}
      {filters.severity.length ? <FilterChip label="Severity" values={filters.severity.map(level => SEVERITY_LABELS[level]).join(", ")} onRemove={() => onFilters({ ...filters, severity: [] })} /> : null}
      {filters.status.length ? <FilterChip label="Status" values={filters.status.map(status => STATUS_LABEL[status]).join(", ")} onRemove={() => onFilters({ ...filters, status: [] })} /> : null}
      {filters.category.length ? <FilterChip label="Category" values={filters.category.join(", ")} onRemove={() => onFilters({ ...filters, category: [] })} /> : null}
      {filters.mission.length ? <FilterChip label={missionLabel} values={filters.mission.map(key => missionName(key, missionNames)).join(", ")} onRemove={() => onFilters({ ...filters, mission: [] })} /> : null}
      {filters.hasFixPr ? <FilterChip label="Fix PR" values="Has fix PR" onRemove={() => onFilters({ ...filters, hasFixPr: false })} /> : null}
      <Button variant="ghost" size="sm" className="ml-auto h-6 px-2" onClick={() => onFilters({ ...filters, severity: [], status: [], category: [], mission: [], hasFixPr: false })}>Clear</Button>
    </div>
  );
}
