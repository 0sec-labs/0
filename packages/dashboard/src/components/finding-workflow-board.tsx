import { BusinessPriorityBadge } from "./business-priority-badge";
import { getFindingPriority } from "@0/shared/dist/finding-priority.js";
import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { SeverityBadge } from "@/components/status-badges";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { FindingGroup, FindingWorkflowPhase } from "@/types";

const WORKFLOW_COLUMNS: Array<{
  status: FindingWorkflowPhase;
  label: string;
  description: string;
}> = [
  {
    status: "backlog",
    label: "Backlog",
    description: "New findings.",
  },
  {
    status: "todo",
    label: "Todo",
    description: "Up next.",
  },
  {
    status: "in_progress",
    label: "In Progress",
    description: "Being worked on.",
  },
  {
    status: "blocked",
    label: "Blocked",
    description: "Stuck. Needs input.",
  },
  {
    status: "done",
    label: "Done",
    description: "Confirmed or reported.",
  },
  {
    status: "cancelled",
    label: "Cancelled",
    description: "Dismissed or false positive.",
  },
];

export function FindingWorkflowBoard({
  groups,
  selectedFingerprint,
  pendingFingerprint,
  onSelect,
  onMove,
}: {
  groups: FindingGroup[];
  selectedFingerprint: string | null;
  pendingFingerprint?: string | null;
  onSelect: (fingerprint: string) => void;
  onMove: (fingerprint: string, workflowStatus: FindingWorkflowPhase) => void;
}) {
  const [activeFingerprint, setActiveFingerprint] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const byStatus = useMemo(() => {
    const grouped = new Map<FindingWorkflowPhase, FindingGroup[]>();
    for (const column of WORKFLOW_COLUMNS) grouped.set(column.status, []);
    for (const group of groups) {
      grouped.get(group.workflow.phase)?.push(group);
    }
    return grouped;
  }, [groups]);

  const activeGroup = useMemo(
    () => (activeFingerprint ? groups.find((group) => group.fingerprint === activeFingerprint) ?? null : null),
    [activeFingerprint, groups],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveFingerprint(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveFingerprint(null);
    const { active, over } = event;
    if (!over) return;

    const fingerprint = String(active.id);
    const group = groups.find((item) => item.fingerprint === fingerprint);
    if (!group) return;

    let targetStatus: FindingWorkflowPhase | null = null;
    const overId = String(over.id);

    if (WORKFLOW_COLUMNS.some((column) => column.status === overId)) {
      targetStatus = overId as FindingWorkflowPhase;
    } else {
      const overGroup = groups.find((item) => item.fingerprint === overId);
      if (overGroup) targetStatus = overGroup.workflow.phase;
    }

    if (targetStatus && targetStatus !== group.workflow.phase) {
      onMove(fingerprint, targetStatus);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="px-0 pb-0 pt-4">
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="overflow-x-auto pb-4">
            <div className="flex min-w-max gap-4 px-6 pb-6">
              {WORKFLOW_COLUMNS.map((column) => (
                <WorkflowColumn
                  key={column.status}
                  column={column}
                  groups={byStatus.get(column.status) ?? []}
                  selectedFingerprint={selectedFingerprint}
                  pendingFingerprint={pendingFingerprint ?? null}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>

          <DragOverlay>
            {activeGroup ? (
              <WorkflowCard
                group={activeGroup}
                selected={selectedFingerprint === activeGroup.fingerprint}
                onSelect={onSelect}
                isOverlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </CardContent>
    </Card>
  );
}

function WorkflowColumn({
  column,
  groups,
  selectedFingerprint,
  pendingFingerprint,
  onSelect,
}: {
  column: {
    status: FindingWorkflowPhase;
    label: string;
    description: string;
  };
  groups: FindingGroup[];
  selectedFingerprint: string | null;
  pendingFingerprint: string | null;
  onSelect: (fingerprint: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.status });

  return (
    <section className="flex w-[20rem] shrink-0 flex-col gap-3">
      <div className="rounded-2xl px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-muted-foreground">
            {column.label}
          </div>
          <div className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            {groups.length}
          </div>
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[20rem] flex-col gap-3 rounded-2xl bg-muted/20 p-2 transition-colors duration-150 motion-reduce:transition-none",
          isOver && "bg-primary/10 ring-1 ring-primary/30",
        )}
      >
        <SortableContext items={groups.map((group) => group.fingerprint)} strategy={verticalListSortingStrategy}>
          {groups.map((group) => (
            <WorkflowCard
              key={group.fingerprint}
              group={group}
              selected={selectedFingerprint === group.fingerprint}
              saving={pendingFingerprint === group.fingerprint}
              onSelect={onSelect}
            />
          ))}
        </SortableContext>

        {groups.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl bg-transparent px-4 py-8 text-center text-xs text-muted-foreground">
            Drop a finding here.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WorkflowCard({
  group,
  selected,
  saving = false,
  onSelect,
  isOverlay = false,
}: {
  group: FindingGroup;
  selected: boolean;
  saving?: boolean;
  onSelect: (fingerprint: string) => void;
  isOverlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: group.fingerprint,
    data: { group },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const summaryLabel = saving
    ? "Saving..."
    :
    group.workflow.reviewGate === "human_review"
      ? "Needs your review"
      : group.workflow.reviewGate === "agent_review"
        ? "Agent reviewing"
        : group.workflow.phase === "in_progress"
          ? "Running"
          : group.workflow.phase === "blocked"
            ? "Blocked"
            : null;

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      onClick={() => onSelect(group.fingerprint)}
      {...attributes}
      {...listeners}
      className={cn(
        "rounded-2xl bg-muted/30 p-3 text-left transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none",
        "cursor-grab active:cursor-grabbing hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        selected && "bg-muted ring-1 ring-primary/35",
        isDragging && !isOverlay && "opacity-30",
        isOverlay && "shadow-lg ring-1 ring-primary/20",
        saving && "bg-primary/10",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <GripVertical className="size-3.5" />
            {group.latest.category}
          </div>
          <div className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">
            {group.latest.title}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{getFindingPriority(group.latest).rationale}</p>
          {summaryLabel ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {summaryLabel}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1"><BusinessPriorityBadge finding={group.latest} /><span className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Technical severity">Technical <SeverityBadge severity={group.latest.severity} /></span></div>
      </div>
    </button>
  );
}
