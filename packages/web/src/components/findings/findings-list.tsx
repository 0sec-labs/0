import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Link2, MessageSquarePlus } from "lucide-react";
import { CapyCheckIcon as Check, CapyChevronRightIcon as ChevronRight, CapyArrowUpRightIcon as ExternalLink, CapyPullRequestIcon as GitPullRequest, CapyHashIcon as Hash, CapySwitchIcon as Repeat2 } from "@/ui/icons/capy";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { formatRelativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { v } from "@/lib/vocabulary";
import { prLabel } from "@/console/panel/views/findings-model";
import type { FindingGroup } from "@/types";
import { SeverityIcon, StatusIcon } from "./finding-icons";
import {
  ROW_HEIGHT, SETTABLE_STATUSES, REVIEW_LOCK_NOTE, statusLockedByReview, STATUS_LABEL, findingCode, findingStatus, layoutRows, normalizeSeverity, visibleRange,
  type FindingStatus, type ListRow,
} from "./findings-model";

export type ContextActions = {
  onOpen: (fingerprint: string) => void;
  onCopyLink: (fingerprint: string) => void;
  onCopyId: (fingerprint: string) => void;
  onSetStatus: (fingerprint: string, status: FindingStatus) => void;
  onAddToMission: (group: FindingGroup) => void;
};

export type FindingsListProps = {
  rows: ListRow[];
  /** Fingerprint of the open detail panel. */
  activeFingerprint: string | null;
  /** Keyboard cursor; scrolled into view whenever it changes. */
  cursorFingerprint: string | null;
  selected: ReadonlySet<string>;
  fixPrs: ReadonlyMap<string, string>;
  onOpen: (fingerprint: string) => void;
  onToggleSelect: (fingerprint: string) => void;
  onToggleSection: (key: string, collapsed: boolean) => void;
  contextActions: ContextActions;
};

const fadeRight = "[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]";

export function FindingsList(props: FindingsListProps) {
  const { rows, activeFingerprint, cursorFingerprint, selected, fixPrs, onOpen, onToggleSelect, onToggleSection, contextActions } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [menuTarget, setMenuTarget] = useState<FindingGroup | null>(null);
  const layout = useMemo(() => layoutRows(rows), [rows]);
  const [start, end] = visibleRange(layout, scrollTop, viewport);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setViewport(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (scroller.current) setScrollTop(scroller.current.scrollTop);
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
          className="no-scrollbar scroll-fade-y absolute inset-0 overflow-y-auto overscroll-contain px-2 pt-1 outline-none [--sf-size:32px]"
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
                  active={activeFingerprint === row.group.fingerprint}
                  cursor={cursorFingerprint === row.group.fingerprint}
                  selected={selected.has(row.group.fingerprint)}
                  anySelected={anySelected}
                  prUrl={fixPrs.get(row.group.latest.id)}
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
      className="absolute inset-x-0 flex items-center gap-2 rounded-lg bg-section px-2 text-left text-[13px] font-medium text-foreground outline-none transition-colors duration-100 hover:bg-secondary focus-visible:outline-ring-inset"
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
  active: boolean;
  cursor: boolean;
  selected: boolean;
  anySelected: boolean;
  prUrl: string | undefined;
  onOpen: (fingerprint: string) => void;
  onToggleSelect: (fingerprint: string) => void;
};

const FindingRow = memo(function FindingRow({ group, style, active, cursor, selected, anySelected, prUrl, onOpen, onToggleSelect }: RowProps) {
  const { latest, fingerprint } = group;
  const status = findingStatus(group);
  const closed = status === "done" || status === "cancelled";
  const age = formatRelativeAge(latest.timestamp);
  return (
    <div
      id={`finding-row-${fingerprint}`}
      role="option"
      aria-selected={selected || active}
      data-fingerprint={fingerprint}
      data-active={active ? "" : undefined}
      style={style}
      onClick={event => {
        if (event.metaKey || event.ctrlKey) { onToggleSelect(fingerprint); return; }
        onOpen(fingerprint);
      }}
      className={cn(
        "group/row absolute inset-x-0 flex cursor-default items-center gap-2 rounded-md px-2 text-sm transition-colors duration-100 select-none",
        "hover:bg-secondary",
        (active || selected) && "bg-section",
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
          "grid size-4 shrink-0 place-items-center rounded-sm border-[0.5px] border-border-3 outline-none transition-opacity duration-100 focus-visible:outline-ring-inset",
          selected ? "border-transparent bg-primary text-primary-foreground opacity-100" : anySelected ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </button>
      <span className="grid size-4 shrink-0 place-items-center"><SeverityIcon severity={normalizeSeverity(latest.severity)} /></span>
      <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground-2 @max-lg/list:hidden">{findingCode(fingerprint)}</span>
      <span className="grid size-4 shrink-0 place-items-center"><StatusIcon status={status} /></span>
      <span className={cn("min-w-[10ch] flex-1 overflow-hidden whitespace-nowrap", fadeRight, closed ? "text-muted-foreground-1" : "font-medium text-foreground")} title={latest.title}>{latest.title}</span>
      {latest.category ? <span className="max-w-32 shrink-0 truncate rounded-md border-[0.5px] border-border-2 px-1.5 py-px text-xs text-muted-foreground-1 @max-xl/list:hidden">{latest.category}</span> : null}
      {group.count > 1 ? <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground-2" title={`Seen ${group.count} times`}><Repeat2 aria-hidden="true" className="size-3" />{group.count}</span> : null}
      {prUrl ? (
        <a href={prUrl} target="_blank" rel="noreferrer noopener" aria-label={`Fix pull request ${prLabel(prUrl)}`} title={`Fix PR ${prLabel(prUrl)}`} onClick={event => event.stopPropagation()} className="grid size-5 shrink-0 place-items-center rounded-sm text-success outline-none hover:bg-secondary focus-visible:outline-ring-inset"><GitPullRequest className="size-3.5" /></a>
      ) : null}
      <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground-2">{age}</span>
    </div>
  );
});

