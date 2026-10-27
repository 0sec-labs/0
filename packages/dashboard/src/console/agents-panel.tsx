import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, Check, CirclePause, X, Info } from "lucide-react";
import type { ConsoleSessionSnapshot, ConsoleWorker } from "@0/shared";
import { Disclosure } from "@/components/ui/disclosure";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SwarmProgress } from "./swarm-progress";
import { ActivityMark } from "./loading-state";
import { AgentAvatar } from "./agent-avatar";
import { Markdown } from "./markdown";
import { ToolActivity } from "./tool-activity";
import { InlineImage, transcriptToolImages } from "./inline-image";
import { duration, isCancellation, workerProgress } from "./worker-tree";

const active = (worker: ConsoleWorker) => ["running", "queued", "parked"].includes(worker.status);
function WorkerStatus({ worker }: { worker: ConsoleWorker }) {
  return worker.status === "running" ? <ActivityMark compact /> : worker.status === "completed" ? <Check className="size-3.5" /> : <CirclePause className="size-3.5" />;
}

/** Companion pane: keep the main conversation mounted alongside this component. */
export function AgentsPanel({ snapshot, selectedWorkerId, onSelect, children, open = true, onClose, onStopAll, embedded = false }: {
  embedded?: boolean;
  onStopAll?: () => void;
  snapshot: ConsoleSessionSnapshot;
  selectedWorkerId?: string | null;
  onSelect: (id: string | null) => void;
  children?: ReactNode;
  open?: boolean;
  onClose?: () => void;
}) {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const running = snapshot.workers.some(active);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const worker = snapshot.workers.find(item => item.id === selectedWorkerId);
  const elapsed = (item: ConsoleWorker) => {
    if (typeof item.telemetry?.durationMs === "number") return duration(item.telemetry.durationMs / 1000);
    const start = item.transcript[0]?.ts;
    if (!start) return undefined;
    return duration(((active(item) ? now : item.transcript.at(-1)?.ts ?? start) - start) / 1000);
  };
  const content = <>
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
      {worker && <Button type="button" variant="ghost" size="icon-sm" aria-label="Back to agents" onClick={() => onSelect(null)}><ArrowLeft className="size-4" /></Button>}
      <AgentAvatar index={worker ? snapshot.workers.indexOf(worker) : 4} />
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{worker?.name ?? "Agents"}</h2>
      {running && onStopAll && <Button type="button" size="sm" variant="ghost" onClick={onStopAll}>Stop all</Button>}
      {worker && <Dialog><DialogTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="View agent assignment"><Info className="size-4" /></Button></DialogTrigger><DialogContent><DialogTitle>Agent assignment</DialogTitle><Markdown text={worker.task} /></DialogContent></Dialog>}
      {onClose && <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close agents"><X className="size-4" /></Button>}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      {worker ? <div className="space-y-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><WorkerStatus worker={worker} /><span>{isCancellation(worker.error) ? "Stopped" : worker.status === "parked" ? "Waiting for you" : worker.status.charAt(0).toUpperCase() + worker.status.slice(1)}</span><span className="ml-auto">{[worker.model, elapsed(worker)].filter(Boolean).join(" · ")}</span></div>
        {worker.operatorMessages?.map(message => <div key={message.id} className="ml-6 rounded-[var(--radius-panel)] bg-muted/60 px-3 py-2 text-sm"><span className="sr-only">Your message: </span><p className="whitespace-pre-wrap break-words">{message.text}</p></div>)}
        <ToolActivity calls={worker.transcript.flatMap(turn => (turn.tools ?? []).map(tool => ({ id: tool.call.id ?? `${turn.turn}-${tool.callIndex}`, name: tool.call.name, arguments: tool.call.arguments, result: tool.result, isRunning: tool.running ?? false })))} reasoning={worker.transcript.map(turn => turn.reasoning_summary).filter(Boolean).join("\n\n")} working={active(worker)} startedAt={worker.transcript[0]?.ts ? new Date(worker.transcript[0].ts).toISOString() : undefined} endedAt={typeof worker.telemetry?.durationMs === "number" && worker.transcript[0]?.ts ? new Date(worker.transcript[0].ts + worker.telemetry.durationMs).toISOString() : worker.transcript.at(-1)?.ts ? new Date(worker.transcript.at(-1)!.ts).toISOString() : undefined} />
        {worker.transcript.map(turn => <article key={turn.turn} className="space-y-3 text-sm">
          {turn.assistant && !isCancellation(turn.assistant) && <Markdown text={turn.assistant} />}
          {(turn.tools ?? []).flatMap(tool => transcriptToolImages(tool.call.name, tool.result)).map((image, index) => <InlineImage key={index} {...image} />)}
        </article>)}
        {worker.summary && !isCancellation(worker.summary) && worker.summary !== worker.transcript.at(-1)?.assistant && <Markdown text={worker.summary} />}
        {worker.error && !isCancellation(worker.error) && worker.error !== worker.summary && <p role="alert" className="rounded-[var(--radius-panel)] bg-destructive/10 p-3 text-sm text-destructive">{worker.error}</p>}
        {active(worker) && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><WorkerStatus worker={worker} />{workerProgress(worker)}</p>}
      </div> : <div className="space-y-6">
        <SwarmProgress workers={snapshot.workers} onSelect={onSelect} />
        {!snapshot.workers.length && <p className="py-8 text-center text-sm text-muted-foreground">Agents will appear here when work is delegated.</p>}
        {([ ["Active", snapshot.workers.filter(active)], ["Complete", snapshot.workers.filter(item => item.status === "completed")], ["Stopped / Failed", snapshot.workers.filter(item => !active(item) && item.status !== "completed")] ] as const).map(([label, workers]) => workers.length > 0 && <Disclosure key={label} defaultOpen={label === "Active"} triggerClassName="mb-2 flex w-full items-center gap-2 text-xs text-muted-foreground" summary={<><span>{label}</span><span className="ml-auto">{workers.length}</span><ChevronDown aria-hidden="true" className="ui-disclosure-chevron size-3.5" /></>}>
          <div className="space-y-1">{workers.map(item => <Button type="button" variant="ghost" key={item.id} onClick={() => onSelect(item.id)} className="h-auto w-full items-start justify-start gap-2.5 whitespace-normal px-2 py-3 text-left font-normal">
            <AgentAvatar index={snapshot.workers.indexOf(item)} className="mt-0.5" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{workerProgress(item)}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{[item.model || String(item.telemetry?.model ?? ""), elapsed(item)].filter(Boolean).join(" · ")}</span></span>
            <span className="mt-1 text-muted-foreground"><WorkerStatus worker={item} /></span>
          </Button>)}</div>
        </Disclosure>)}
        {selectedWorkerId && !worker && <p role="status" className="text-sm text-muted-foreground">This agent is no longer available.</p>}
      </div>}
    </div>
    {worker && children && <div className="shrink-0 border-t border-border/60 p-3">{children}</div>}
  </>;
  if (embedded) return <div aria-label="Agents" className="flex h-full min-h-0 flex-col">{content}</div>;
  if (narrow) return <Sheet open={open} onOpenChange={value => { if (!value) onClose?.(); }}><SheetContent showCloseButton={false} className="!w-full !max-w-md !rounded-l-[var(--radius-panel)]"><SheetTitle className="sr-only">Agents</SheetTitle>{content}</SheetContent></Sheet>;
  return <aside aria-label="Agents" data-open={open} aria-hidden={!open} inert={!open} className="console-agents-panel h-full min-h-0 shrink-0 overflow-hidden bg-background"><div className="flex h-full w-[400px] flex-col border-l border-border/60">{content}</div></aside>;
}
