import { Check, ChevronDown, CirclePause, Clock3, CornerDownLeft, MessageSquare, Users, X } from "lucide-react";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import type { ConsoleSessionSnapshot, ConsoleWorker } from "@0/shared";
import { Button } from "@/components/ui/button";
import { LoadingDots } from "./loading-state";
import { Tooltip } from "@/components/ui/tooltip";

const STATUS_LABELS: Record<ConsoleWorker["status"], string> = {
  queued: "Queued",
  running: "Working",
  parked: "Waiting",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

function latestProgress(worker: ConsoleWorker): string {
  if (worker.error) return worker.error;
  for (let index = worker.transcript.length - 1; index >= 0; index--) {
    const turn = worker.transcript[index]!;
    const runningTool = turn.tools?.findLast(tool => tool.running);
    if (runningTool) return `Using ${runningTool.call.name}`;
    if (turn.assistant?.trim()) return turn.assistant.trim();
    if (turn.reasoning_summary?.trim()) return turn.reasoning_summary.trim();
  }
  return worker.summary?.trim() || worker.task;
}

function WorkerStatus({ status }: { status: ConsoleWorker["status"] }) {
  if (status === "running") return <LoadingDots className="text-primary" />;
  if (status === "parked") return <CirclePause aria-hidden="true" className="size-3.5 text-primary" />;
  if (status === "completed") return <Check aria-hidden="true" className="size-3.5 text-muted-foreground" />;
  if (status === "failed") return <X aria-hidden="true" className="size-3.5 text-destructive" />;
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/60" />;
}

export interface AgentActivityProps {
  snapshot: ConsoleSessionSnapshot;
  workerId: string | null;
  onSelect: (workerId: string | null) => void;
  active: boolean;
  sendBehavior: "queue" | "steer";
  onSendBehaviorChange: (value: "queue" | "steer") => void;
}

/** An anchored activity menu keeps worker updates out of the transcript layout. */
export function AgentActivity({ snapshot, workerId, onSelect, active, sendBehavior, onSendBehaviorChange }: AgentActivityProps) {
  const selectedWorker = snapshot.workers.find(worker => worker.id === workerId);
  const workingCount = snapshot.workers.filter(worker => worker.status === "running" || worker.status === "queued").length;
  const waitingCount = snapshot.workers.filter(worker => worker.status === "parked").length;
  const count = snapshot.workers.length;
  if (!count && !active) return null;
  const label = selectedWorker?.name || (count ? `${count} ${count === 1 ? "agent" : "agents"}` : "Working");
  const activity = workingCount ? `${workingCount} working` : waitingCount ? `${waitingCount} waiting` : count ? "View agent activity" : "Conversation activity";

  return <DropdownMenu>
    <Tooltip content={activity}><DropdownMenu.Trigger aria-label={selectedWorker ? `Agent: ${selectedWorker.name}` : count ? `View ${count} ${count === 1 ? "agent" : "agents"}` : "Conversation activity"}>
      <Button type="button" variant="ghost" size="sm" className="max-w-48 gap-2 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground">
        {active || workingCount > 0 ? <LoadingDots className="text-primary" /> : <Users aria-hidden="true" className="size-3.5" />}
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden="true" className="size-3" />
      </Button>
    </DropdownMenu.Trigger></Tooltip>
    <DropdownMenu.Content align="end" sideOffset={8} collisionPadding={12} className="w-80 max-w-[calc(100vw-24px)] rounded-2xl p-1.5 font-sans">
      <DropdownMenu.Item icon={<MessageSquare className="size-4" />} selected={!selectedWorker} onClick={() => onSelect(null)}>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3"><span>Main conversation</span><span className="text-xs text-muted-foreground">{active ? "Working" : "Ready"}</span></span>
      </DropdownMenu.Item>
      {snapshot.workers.length > 0 && <div className="max-h-72 overflow-y-auto overscroll-contain">
        {snapshot.workers.map(worker => <DropdownMenu.Item key={worker.id} selected={worker.id === workerId} onClick={() => onSelect(worker.id)} className="items-start">
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center justify-between gap-3"><span className="truncate font-medium">{worker.name}</span><span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><WorkerStatus status={worker.status} />{STATUS_LABELS[worker.status]}</span></span>
            <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">{worker.task}</span>
            {latestProgress(worker) !== worker.task && <span className="truncate text-xs text-muted-foreground/80">{latestProgress(worker)}</span>}
          </span>
        </DropdownMenu.Item>)}
      </div>}
      {active && !selectedWorker && <>
        <div className="px-3 pt-3 pb-1 text-xs text-muted-foreground">Your next message</div>
        <DropdownMenu.Item icon={<Clock3 className="size-4" />} selected={sendBehavior === "queue"} onClick={() => onSendBehaviorChange("queue")}>Send when done</DropdownMenu.Item>
        <DropdownMenu.Item icon={<CornerDownLeft className="size-4" />} selected={sendBehavior === "steer"} onClick={() => onSendBehaviorChange("steer")}>Interrupt and send</DropdownMenu.Item>
      </>}
    </DropdownMenu.Content>
  </DropdownMenu>;
}
