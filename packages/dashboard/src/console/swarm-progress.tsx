import type { ConsoleWorker } from "@0/shared";
import { Button } from "@/components/ui/button";
import { Network } from "lucide-react";
import { isCancellation } from "./worker-tree";

/** Counts represent actual worker state, rather than estimated task completion. */
export function SwarmProgress({ workers, onSelect }: { workers: ConsoleWorker[]; onSelect?: (id: string) => void }) {
  if (!workers.length) return null;
  const completed = workers.filter(worker => worker.status === "completed").length;
  const running = workers.filter(worker => worker.status === "running").length;
  const waiting = workers.filter(worker => worker.status === "queued" || worker.status === "parked").length;
  const failed = workers.filter(worker => worker.status === "failed" && !isCancellation(worker.error)).length;
  const stopped = workers.length - completed - running - waiting - failed;
  return <div className="space-y-3 rounded-[var(--radius-menu)] bg-muted/40 p-3" aria-label="Swarm progress">
    <div className="flex items-center gap-2 text-xs"><Network className="size-4 text-muted-foreground" /><span className="font-medium">{running || waiting ? "Swarm at work" : "Swarm finished"}</span><span className="ml-auto tabular-nums text-muted-foreground">{completed} / {workers.length} complete</span></div>
    <div className="flex h-1.5 gap-1 overflow-hidden rounded-full" role="img" aria-label={`${running} running, ${waiting} waiting, ${completed} complete, ${failed} failed, ${stopped} stopped`}>
      {workers.map(worker => <span key={worker.id} title={`${worker.name}: ${isCancellation(worker.error) ? "stopped" : worker.status}`} className={`min-w-0 flex-1 rounded-full ${worker.status === "completed" ? "bg-emerald-500/70" : worker.status === "running" ? "animate-pulse bg-foreground/60 motion-reduce:animate-none" : worker.status === "failed" && !isCancellation(worker.error) ? "bg-destructive/70" : "bg-foreground/15"}`} />)}
    </div>
    {workers.length > 12 && <div className="grid grid-cols-[repeat(auto-fill,minmax(16px,1fr))] gap-1" aria-label="Live agent map">
      {workers.map((worker, index) => <Button key={worker.id} type="button" variant="ghost" disabled={!onSelect} onClick={() => onSelect?.(worker.id)} aria-label={`Agent ${index + 1}: ${worker.name}, ${isCancellation(worker.error) ? "stopped" : worker.status}`} title={`${worker.name} · ${isCancellation(worker.error) ? "stopped" : worker.status}`} className={`h-5 min-w-0 rounded-sm p-0 disabled:opacity-100 ${worker.status === "completed" ? "bg-emerald-500/60 hover:bg-emerald-500/80" : worker.status === "running" ? "animate-pulse bg-foreground/50 hover:bg-foreground/70 motion-reduce:animate-none" : worker.status === "failed" && !isCancellation(worker.error) ? "bg-destructive/60 hover:bg-destructive/80" : "bg-foreground/10 hover:bg-foreground/25"}`} />)}
    </div>}
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{running > 0 && <span>{running} running</span>}{waiting > 0 && <span>{waiting} waiting</span>}{completed > 0 && <span>{completed} complete</span>}{failed > 0 && <span className="text-destructive">{failed} need attention</span>}{stopped > 0 && <span>{stopped} stopped</span>}</div>
  </div>;
}
