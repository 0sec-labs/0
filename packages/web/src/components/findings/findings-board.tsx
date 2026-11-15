import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent, type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { CapyPullRequestIcon as GitPullRequest } from "@/ui/icons/capy";
import { formatRelativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { prLabel } from "@/console/panel/views/findings-model";
import type { FindingGroup } from "@/types";
import { SeverityIcon, StatusIcon } from "./finding-icons";
import { STATUS_LABEL, boardColumns, findingCode, findingStatus, normalizeSeverity, resolveDrop, type BoardColumn, type Direction, type FindingStatus, type OrderBy } from "./findings-model";

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
  /** Dropping a card on a column. The owner applies the move or explains why it is refused (see `resolveDrop`). */
  onMove: (fingerprint: string, target: FindingStatus) => void;
};

/** The column under the pointer wins; keyboard drags have no pointer, so the nearest column centre does. */
const collision: CollisionDetection = args => {
  const within = pointerWithin(args);
  if (within.length) return within;
  return args.pointerCoordinates ? [] : closestCenter(args);
};

/** Escape during a pointer drag cancels it, but releasing the button over the card would still click it open. Swallow that one click. */
function swallowReleaseClick(activator: Event | null) {
  if (!(activator instanceof MouseEvent) && !(typeof TouchEvent !== "undefined" && activator instanceof TouchEvent)) return;
  const stop = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
  document.addEventListener("click", stop, { capture: true, once: true });
  window.addEventListener("pointerup", () => setTimeout(() => document.removeEventListener("click", stop, true), 0), { once: true });
}

/** Space lifts a card, Left/Right hop to the neighbouring column, Space drops, Escape cancels. */
const columnHop: KeyboardCoordinateGetter = (event, { context: { active, collisionRect, droppableRects, droppableContainers, over } }) => {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return undefined;
  event.preventDefault();
  const ids = droppableContainers.getEnabled().map(container => container.id).filter(id => droppableRects.has(id));
  if (!ids.length || !active) return undefined;
  const from = over ? ids.indexOf(over.id) : ids.findIndex(id => id === (active.data.current as { column?: string } | undefined)?.column);
  const next = ids[Math.min(ids.length - 1, Math.max(0, (from === -1 ? 0 : from) + (event.code === "ArrowRight" ? 1 : -1)))];
  const rect = next === undefined ? undefined : droppableRects.get(next);
  return rect && collisionRect ? { x: rect.left + (rect.width - collisionRect.width) / 2, y: rect.top + 8 } : undefined;
};

export function FindingsBoard(props: FindingsBoardProps) {
  const { groups, orderBy, direction, onMove } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<FindingStatus | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] }, coordinateGetter: columnHop }),
  );
  const columns = useMemo(() => boardColumns(groups, orderBy, direction), [groups, orderBy, direction]);
  const dragged = dragging ? groups.find(group => group.fingerprint === dragging) ?? null : null;
  const draggedStatus = dragged ? findingStatus(dragged) : null;
  const find = (id: unknown) => groups.find(item => item.fingerprint === String(id));
  const title = (id: unknown) => find(id)?.latest.title ?? "Finding";
  const label = (id: unknown) => STATUS_LABEL[String(id) as FindingStatus] ?? String(id);

  const reset = () => { setDragging(null); setOverColumn(null); };
  const onDragStart = (event: DragStartEvent) => setDragging(String(event.active.id));
  const onDragOver = (event: DragOverEvent) => setOverColumn(event.over ? String(event.over.id) as FindingStatus : null);
  const onDragEnd = (event: DragEndEvent) => {
    reset();
    if (event.over) onMove(String(event.active.id), String(event.over.id) as FindingStatus);
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}. Use the left and right arrow keys to choose a column, Space to drop, Escape to cancel.`,
    onDragOver: ({ active, over }) => {
      if (!over) return `${title(active.id)} is not over a column.`;
      const current = find(active.id);
      const decision = current ? resolveDrop(findingStatus(current), String(over.id) as FindingStatus) : null;
      return decision && !decision.ok && decision.reason ? `${label(over.id)}: not allowed. ${decision.reason}` : `${title(active.id)} is over ${label(over.id)}.`;
    },
    onDragEnd: ({ active, over }) => over ? `Dropped ${title(active.id)} on ${label(over.id)}.` : `${title(active.id)} was dropped outside the board and did not move.`,
    onDragCancel: ({ active }) => `Move cancelled. ${title(active.id)} did not move.`,
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      autoScroll={{ threshold: { x: 0.1, y: 0.15 }, acceleration: 8 }}
      accessibility={{ announcements, screenReaderInstructions: { draggable: "Press Space to pick up this finding, then the arrow keys to choose a column and Space to drop it. Press Enter to open it." } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={event => { reset(); swallowReleaseClick(event.activatorEvent); }}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-2 pb-2" role="group" aria-label="Findings board">
        {columns.map(column => <Column key={column.status} column={column} draggedStatus={draggedStatus} over={overColumn === column.status} {...props} />)}
      </div>
      {createPortal(<DragOverlay dropAnimation={null}>{dragged ? <Card group={dragged} overlay {...props} /> : null}</DragOverlay>, document.body)}
    </DndContext>
  );
}

function Column({ column, draggedStatus, over, ...props }: { column: BoardColumn; draggedStatus: FindingStatus | null; over: boolean } & FindingsBoardProps) {
  const { setNodeRef } = useDroppable({ id: column.status });
  const decision = draggedStatus ? resolveDrop(draggedStatus, column.status) : null;
  const refused = decision !== null && !decision.ok && decision.reason !== null;
  return (
    <section aria-label={`${column.label}, ${column.items.length} findings`} data-column={column.status} data-drop={over ? (refused ? "refused" : decision?.ok ? "accept" : "same") : undefined} className="flex w-72 shrink-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-section px-2.5 text-[13px] font-medium">
        <StatusIcon status={column.status} />
        <span className="min-w-0 truncate">{column.label}</span>
        <span className="font-normal tabular-nums text-muted-foreground-2">{column.items.length}</span>
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          "no-scrollbar scroll-fade-y mt-1 flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors duration-100 motion-reduce:transition-none",
          over && decision?.ok && "bg-section outline outline-1 -outline-offset-1 outline-ring",
          over && refused && "cursor-not-allowed bg-destructive/5 outline outline-1 -outline-offset-1 outline-destructive",
          draggedStatus && refused && !over && "opacity-50",
        )}
      >
        {refused && over ? <p role="status" className="px-1.5 py-1 text-xs text-destructive">{decision.reason}</p> : null}
        {column.items.map(group => <Card key={group.fingerprint} group={group} {...props} />)}
      </div>
    </section>
  );
}

function Card({ group, overlay = false, ...props }: { group: FindingGroup; overlay?: boolean } & FindingsBoardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: group.fingerprint, disabled: overlay, data: { column: findingStatus(group) } });
  const { latest, fingerprint } = group;
  const prUrl = props.fixPrs.get(latest.id);
  const selected = props.selected.has(fingerprint);
  const saving = props.pendingFingerprint === fingerprint;
  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : { ...listeners, onKeyDown: undefined })}
      data-fingerprint={overlay ? undefined : fingerprint}
      data-overlay={overlay ? "" : undefined}
      onClick={event => { if (event.metaKey || event.ctrlKey) props.onToggleSelect(fingerprint); else props.onOpen(fingerprint); }}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); props.onOpen(fingerprint); return; }
        if (!overlay) listeners?.onKeyDown?.(event);
      }}
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-lg border-[0.5px] border-border-2 bg-card p-2.5 text-left outline-none transition-colors duration-100 ui-row-hover focus-visible:outline-ring-inset motion-reduce:transition-none",
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
