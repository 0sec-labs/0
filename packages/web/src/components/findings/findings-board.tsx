import { useMemo, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { CapyPullRequestIcon as GitPullRequest } from "@/ui/icons/capy";
import { formatRelativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { prLabel } from "@/console/panel/views/findings-model";
import type { FindingGroup } from "@/types";
import { SeverityIcon, StatusIcon } from "./finding-icons";
import { boardColumns, findingCode, findingStatus, normalizeSeverity, type BoardColumn, type Direction, type FindingStatus, type OrderBy } from "./findings-model";

export type FindingsBoardProps = {
  groups: FindingGroup[];
  orderBy: OrderBy;
  direction: Direction;
  activeFingerprint: string | null;
  cursorFingerprint: string | null;
  selected: ReadonlySet<string>;
  pendingFingerprint: string | null;
  fixPrs: ReadonlyMap<string, string>;
  onOpen: (fingerprint: string) => void;
  onToggleSelect: (fingerprint: string) => void;
  /** Dragging a card into a settable column changes its workflow status. */
  onMove: (fingerprint: string, status: FindingStatus) => void;
};

export function FindingsBoard(props: FindingsBoardProps) {
  const { groups, orderBy, direction, onMove } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const columns = useMemo(() => boardColumns(groups, orderBy, direction), [groups, orderBy, direction]);
  const dragged = dragging ? groups.find(group => group.fingerprint === dragging) ?? null : null;

  const onDragStart = (event: DragStartEvent) => setDragging(String(event.active.id));
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const target = event.over ? String(event.over.id) as FindingStatus : null;
    const group = groups.find(item => item.fingerprint === String(event.active.id));
    if (!target || !group || target === findingStatus(group)) return;
    onMove(group.fingerprint, target);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-2 pb-2" role="group" aria-label="Findings board">
        {columns.map(column => <Column key={column.status} column={column} {...props} />)}
      </div>
      <DragOverlay>{dragged ? <Card group={dragged} overlay {...props} /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ column, ...props }: { column: BoardColumn } & FindingsBoardProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.status, disabled: !column.droppable });
  return (
    <section aria-label={`${column.label}, ${column.items.length} findings`} className="flex w-72 shrink-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-section px-2.5 text-[13px] font-medium">
        <StatusIcon status={column.status} />
        <span className="min-w-0 truncate">{column.label}</span>
        <span className="font-normal tabular-nums text-muted-foreground-2">{column.items.length}</span>
      </header>
      <div
        ref={setNodeRef}
        className={cn("no-scrollbar scroll-fade-y mt-1 flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors duration-100 motion-reduce:transition-none", isOver && "bg-section")}
      >
        {column.items.map(group => <Card key={group.fingerprint} group={group} {...props} />)}
        {column.items.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground-2">{column.droppable ? "Nothing here. Drag a finding in." : "Set by review, not by hand."}</p>
        ) : null}
      </div>
    </section>
  );
}

function Card({ group, overlay = false, ...props }: { group: FindingGroup; overlay?: boolean } & FindingsBoardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: group.fingerprint });
  const { latest, fingerprint } = group;
  const prUrl = props.fixPrs.get(latest.id);
  const selected = props.selected.has(fingerprint);
  const saving = props.pendingFingerprint === fingerprint;
  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
      data-fingerprint={fingerprint}
      onClick={event => { if (event.metaKey || event.ctrlKey) props.onToggleSelect(fingerprint); else props.onOpen(fingerprint); }}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); props.onOpen(fingerprint); } }}
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-lg border-[0.5px] border-border-2 bg-card p-2.5 text-left outline-none transition-colors duration-100 hover:bg-card-hover focus-visible:outline-ring-inset motion-reduce:transition-none",
        (props.activeFingerprint === fingerprint || selected) && "bg-section",
        props.cursorFingerprint === fingerprint && "outline-ring-inset",
        isDragging && !overlay && "opacity-30",
        overlay && "shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.1))]",
        saving && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground-2">
        <SeverityIcon severity={normalizeSeverity(latest.severity)} />
        <span className="tabular-nums">{findingCode(fingerprint)}</span>
        <span className="ml-auto tabular-nums">{saving ? "Saving…" : formatRelativeAge(latest.timestamp)}</span>
      </div>
      <p className="line-clamp-2 text-sm leading-5 font-medium text-foreground" title={latest.title}>{latest.title}</p>
      {latest.category || prUrl || group.count > 1 ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground-1">
          {latest.category ? <span className="min-w-0 truncate rounded-md border-[0.5px] border-border-2 px-1.5 py-px">{latest.category}</span> : null}
          {group.count > 1 ? <span className="tabular-nums text-muted-foreground-2">×{group.count}</span> : null}
          {prUrl ? <a href={prUrl} target="_blank" rel="noreferrer noopener" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} aria-label={`Fix pull request ${prLabel(prUrl)}`} className="ml-auto inline-flex items-center gap-1 text-success outline-none focus-visible:outline-ring-inset"><GitPullRequest className="size-3.5" />{prLabel(prUrl)}</a> : null}
        </div>
      ) : null}
    </div>
  );
}
