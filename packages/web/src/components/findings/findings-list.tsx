import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Link2, MessageSquarePlus } from "lucide-react";
import { CapyCheckIcon as Check, CapyChevronRightIcon as ChevronRight, CapyArrowUpRightIcon as ExternalLink, CapyHashIcon as Hash, CapySwitchIcon as Repeat2 } from "@/ui/icons/capy";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { formatRelativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { v } from "@/lib/vocabulary";
import { isAcceptedFinding } from "@/console/panel/views/findings-model";
import type { FindingGroup, FindingWorkflowStatus } from "@/types";
import { Link } from "react-router-dom";
import { SeverityIcon, StatusIcon } from "./finding-icons";
import {
  ROW_HEIGHT, SETTABLE_STATUSES, REVIEW_LOCK_NOTE, statusLockedByReview, STATUS_LABEL, findingCode, findingStatus, layoutRows, missionName, normalizeSeverity, visibleRange, type ListRow, type MissionLabels,
} from "./findings-model";
import { useMissionHrefs } from "./use-mission-href";
import { listMemory } from "./use-findings-view";

export type ContextActions = {
  onOpen: (fingerprint: string) => void;
  onCopyLink: (fingerprint: string) => void;
  onCopyId: (fingerprint: string) => void;
  onSetStatus: (fingerprint: string, status: FindingWorkflowStatus) => void;
  onAddToMission: (group: FindingGroup) => void;
};

export type FindingsListProps = {
  rows: ListRow[];
  missionNames: MissionLabels;
  /** Keyboard cursor; scrolled into view whenever it changes. */
  cursorFingerprint: string | null;
  selected: ReadonlySet<string>;
  onOpen: (fingerprint: string) => void;
  onToggleSelect: (fingerprint: string) => void;
  onToggleSection: (key: string, collapsed: boolean) => void;
  contextActions: ContextActions;
};


export function FindingsList(props: FindingsListProps) {
  const { rows, missionNames, cursorFingerprint, selected, onOpen, onToggleSelect, onToggleSection, contextActions } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(listMemory.scrollTop);
  const threadHref = useMissionHrefs();
  const [viewport, setViewport] = useState(600);
  const [menuTarget, setMenuTarget] = useState<FindingGroup | null>(null);
  const layout = useMemo(() => layoutRows(rows), [rows]);
  const [start, end] = visibleRange(layout, scrollTop, viewport);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setViewport(node.clientHeight);
    measure();
    node.scrollTop = listMemory.scrollTop;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (!scroller.current) return;
      listMemory.scrollTop = scroller.current.scrollTop;
      setScrollTop(scroller.current.scrollTop);
    });
  }, []);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  // Keep the keyboard cursor visible; windowed rows may not be mounted, so scroll by computed offset.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !cursorFingerprint) return;
    const index = rows.findIndex(row => row.type === "finding" && row.group.fingerprint === cursorFingerprint);
    if (index === -1) return;
    const top = layout.offsets[index]!;
    const bottom = top + ROW_HEIGHT;
    if (top < node.scrollTop + 8) node.scrollTop = Math.max(0, top - 8);
    else if (bottom > node.scrollTop + node.clientHeight - 56) node.scrollTop = bottom - node.clientHeight + 56;
  }, [cursorFingerprint, rows, layout]);

  const anySelected = selected.size > 0;
  const cursorId = cursorFingerprint ? `finding-row-${cursorFingerprint}` : undefined;

  const onContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-fingerprint]");
    const group = row ? rows.find(item => item.type === "finding" && item.group.fingerprint === row.dataset.fingerprint) : undefined;
    if (!group || group.type !== "finding") { event.stopPropagation(); return; }
    setMenuTarget(group.group);
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={<div className="@container/list relative min-h-0 flex-1" />}
        onContextMenuCapture={onContextMenuCapture}
      >
        <div
          ref={scroller}
          role="listbox"
          aria-label="Findings"
          aria-multiselectable="true"
          aria-activedescendant={cursorId}
          tabIndex={0}
          onScroll={onScroll}
          className="no-scrollbar scroll-fade-y absolute inset-0 overflow-y-auto overscroll-contain px-3 pt-1 outline-none [--sf-size:32px]"
        >
          <div className="relative" style={{ height: layout.total + 64 }}>
            {rows.slice(start, end).map((row, offset) => {
              const index = start + offset;
              const style = { top: layout.offsets[index], height: layout.heights[index] };
              return row.type === "header" ? (
                <SectionHeader key={row.key} style={style} row={row} onToggle={onToggleSection} />
              ) : (
                <FindingRow
                  key={row.key}
                  style={style}
                  group={row.group}
                  thread={missionName(row.group.latest.scanId, missionNames)}
                  threadHref={threadHref(row.group.latest.scanId)}
                  cursor={cursorFingerprint === row.group.fingerprint}
                  selected={selected.has(row.group.fingerprint)}
                  anySelected={anySelected}
                  onOpen={onOpen}
                  onToggleSelect={onToggleSelect}
                />
              );
            })}
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-[60] outline-none">
          <ContextMenu.Popup className="ui-popup flex w-56 origin-(--transform-origin) flex-col rounded-[var(--radius-overlay,8px)] border-[0.5px] border-border-2 bg-popover p-1 text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03))] outline-none">
            {menuTarget ? <RowMenu group={menuTarget} actions={contextActions} /> : null}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function RowMenu({ group, actions }: { group: FindingGroup; actions: ContextActions }) {
  const status = findingStatus(group);
  const fp = group.fingerprint;
  return (
    <>
      <DropdownMenu.Item icon={<ExternalLink />} onClick={() => actions.onOpen(fp)}>Open</DropdownMenu.Item>
      <DropdownMenu.Item icon={<Link2 />} onClick={() => actions.onCopyLink(fp)}>Copy link</DropdownMenu.Item>
      <DropdownMenu.Item icon={<Hash />} onClick={() => actions.onCopyId(fp)}>Copy ID <span className="ml-auto text-xs tabular-nums text-muted-foreground-2">{findingCode(fp)}</span></DropdownMenu.Item>
      <DropdownMenu.Label>Status</DropdownMenu.Label>
      {status === "human_review" ? <p role="note" className="px-2 py-1 text-xs text-muted-foreground-1">{REVIEW_LOCK_NOTE}</p> : null}
      {SETTABLE_STATUSES.map(option => (
        <DropdownMenu.Item key={option} disabled={statusLockedByReview(status, option)} icon={<StatusIcon status={option} />} selected={status === option} onClick={() => actions.onSetStatus(fp, option)}>{STATUS_LABEL[option]}</DropdownMenu.Item>
      ))}
      <DropdownMenu.Item icon={<MessageSquarePlus />} onClick={() => actions.onAddToMission(group)} className="mt-1">{v("Add to {mission}")}</DropdownMenu.Item>
    </>
  );
}

const SectionHeader = memo(function SectionHeader({ row, style, onToggle }: { row: Extract<ListRow, { type: "header" }>; style: React.CSSProperties; onToggle: (key: string, collapsed: boolean) => void }) {
  const { section, collapsed } = row;
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={() => onToggle(section.key, !collapsed)}
      style={style}
      className="absolute inset-x-0 flex items-center gap-2 rounded-md bg-section px-2 text-left text-[13px] font-medium text-foreground outline-none transition-colors duration-100 hover:bg-secondary focus-visible:outline-ring-inset"
    >
      <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 text-muted-foreground-3 transition-transform duration-150 motion-reduce:transition-none", !collapsed && "rotate-90")} />
      {section.kind === "status" && section.status ? <StatusIcon status={section.status} /> : null}
      {section.kind === "severity" && section.severity ? <SeverityIcon severity={section.severity} /> : null}
      <span className="min-w-0 truncate">{section.label}</span>
      <span className="text-[13px] font-normal tabular-nums text-muted-foreground-2">{section.items.length}</span>
    </button>
  );
});

type RowProps = {
  group: FindingGroup;
  style: React.CSSProperties;
  thread: string;
  threadHref: string | null;
  cursor: boolean;
  selected: boolean;
  anySelected: boolean;
  onOpen: (fingerprint: string) => void;
  onToggleSelect: (fingerprint: string) => void;
};

const FindingRow = memo(function FindingRow({ group, style, thread, threadHref, cursor, selected, anySelected, onOpen, onToggleSelect }: RowProps) {
  const { latest, fingerprint } = group;
  const status = findingStatus(group);
  const closed = status === "done" || status === "cancelled";
  const age = formatRelativeAge(latest.timestamp);
  return (
    <div
      id={`finding-row-${fingerprint}`}
      role="option"
      aria-selected={selected}
      data-fingerprint={fingerprint}
      style={style}
      onClick={event => {
        if (event.metaKey || event.ctrlKey) { onToggleSelect(fingerprint); return; }
        onOpen(fingerprint);
      }}
      className={cn(
        "group/row absolute inset-x-0 flex cursor-default items-center gap-3 rounded-md px-3 text-[13px] transition-colors duration-100 select-none",
        "hover:bg-secondary",
        selected && "bg-section",
        cursor && "outline-ring-inset",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${latest.title}`}
        tabIndex={-1}
        onClick={event => { event.stopPropagation(); onToggleSelect(fingerprint); }}
        className={cn(
          "-ml-1 grid size-4 shrink-0 place-items-center rounded-sm border-[0.5px] border-border-3 outline-none transition-opacity duration-100 focus-visible:outline-ring-inset",
          selected ? "border-transparent bg-primary text-primary-foreground opacity-100" : anySelected ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </button>
      <span className="grid size-4 shrink-0 place-items-center"><StatusIcon status={status} /></span>
      <span className="w-16 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground-2 @max-lg/list:hidden">{findingCode(fingerprint)}</span>
      <span className={cn("min-w-[10ch] flex-1 truncate", closed ? "text-muted-foreground-1" : "text-foreground")} title={latest.title}>{latest.title}</span>
      {latest.tool ? <span className="max-w-32 shrink-0 truncate rounded-md border-[0.5px] border-border-2 px-1.5 py-px text-xs text-muted-foreground-1 @max-2xl/list:hidden">{latest.tool}</span> : null}
      {latest.category ? <span className="max-w-40 shrink-0 truncate rounded-md border-[0.5px] border-border-2 px-1.5 py-px text-xs text-muted-foreground-1 @max-2xl/list:hidden">{latest.category}</span> : null}
      {isAcceptedFinding(group) ? <span className="shrink-0 rounded-md border-[0.5px] border-border-2 px-1.5 py-px text-xs text-muted-foreground-1">Accepted</span> : null}
      {group.count > 1 ? <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground-2" title={`Seen ${group.count} times`}><Repeat2 aria-hidden="true" className="size-3" />{group.count}</span> : null}
      <span className="grid w-5 shrink-0 place-items-center"><SeverityIcon severity={normalizeSeverity(latest.severity)} /></span>
      <span className="w-36 shrink-0 truncate text-xs text-muted-foreground-2 @max-4xl/list:hidden">
        {threadHref ? <Link to={threadHref} onClick={event => event.stopPropagation()} className="rounded-sm outline-none hover:text-foreground hover:underline focus-visible:outline-ring-inset" title={`Open ${thread}`}>{thread}</Link> : thread}
      </span>
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground-2">{age}</span>
    </div>
  );
});

