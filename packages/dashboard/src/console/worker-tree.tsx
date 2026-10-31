import { useEffect, useState } from "react";
import { ActivityMark } from "./loading-state";
import { AgentAvatar } from "./agent-avatar";
import { Link } from "react-router-dom";
import { Check, CirclePause } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConsoleWorker } from "@0/shared";

export const isCancellation = (text?: string) => Boolean(text && /^(?:This operation was aborted\.?|The operation was aborted\.?|AbortError(?::.*)?|Workbench cancelled.*|Turn cancelled by operator.*)$/i.test(text.trim()));
const active = (worker: ConsoleWorker) => ["running", "queued", "parked"].includes(worker.status);
export function workerProgress(worker: ConsoleWorker): string {
  if (isCancellation(worker.error)) return "Stopped";
  if (worker.error) return worker.error;
  for (const turn of [...worker.transcript].reverse()) {
    const tool = turn.tools?.findLast(tool => tool.running);
    if (tool) return `Using ${tool.call.name.replaceAll("_", " ")}`;
    if (turn.assistant?.trim() && !isCancellation(turn.assistant)) return turn.assistant.trim().split("\n")[0]!;
  }
  return worker.status === "running" ? "Thinking…" : worker.status === "completed" ? "Complete" : worker.status === "parked" ? "Waiting for you" : worker.status === "queued" ? "Starting…" : worker.status === "stopped" ? "Stopped" : "Needs attention";
}
export function duration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return value >= 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`;
}
export function WorkerTree({ workers, sessionId, onSelect, hideHeader = false }: { workers: ConsoleWorker[]; sessionId: string; onSelect?: (id:string)=>void; hideHeader?:boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const running = workers.some(active);
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  if (!workers.length) return null;
  const tree = (items:ConsoleWorker[]) => <section aria-label="Agent activity" className="py-3 text-sm">

    <ul className="ml-2 space-y-1 border-l border-border/70 pl-4">
      {items.map((worker) => {
        const index=workers.indexOf(worker);
        const start = worker.transcript[0]?.ts;
        const end = worker.transcript.at(-1)?.ts;
        const elapsed = typeof worker.telemetry?.durationMs === "number" ? duration(worker.telemetry.durationMs / 1000) : start ? duration(((active(worker) ? now : end ?? start) - start) / 1000) : undefined;
        return <li key={worker.id} data-agent-status={worker.status} className="relative before:absolute before:-left-4 before:top-4 before:h-px before:w-3 before:bg-border">
          <Button asChild variant="ghost" className="h-auto w-full items-start justify-start whitespace-normal px-2 py-2 text-left font-normal"><Link to={`/console/${sessionId}?worker=${encodeURIComponent(worker.id)}`} onClick={event => { if (onSelect && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onSelect(worker.id); } }} className="flex items-start gap-2 rounded-[var(--radius-control)] px-2 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
            <AgentAvatar index={index} className="mt-0.5" />
            <div className="min-w-0 flex-1"><div className={`truncate text-[13px] ${worker.status === "completed" ? "text-muted-foreground" : ""}`} title={worker.name}>{worker.name}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{workerProgress(worker)}</div></div>
            <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground"><span className="hidden sm:inline">{worker.model || String(worker.telemetry?.model ?? "")}</span>{elapsed && <span>{elapsed}</span>}{worker.status === "running" ? <ActivityMark compact /> : worker.status === "completed" ? <Check aria-label="Complete" className="size-3" /> : <CirclePause className="size-3" />}</div>
          </Link></Button>
        </li>;
      })}
    </ul>
  </section>;
  return <>
    {!hideHeader && <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><AgentAvatar index={4} /><span>Agents</span></div>}
    {tree(expanded ? workers : workers.slice(0, 8))}
    {workers.length > 8 && <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? "Show fewer agents" : `Show all ${workers.length} agents`}</Button>}
  </>;
}
