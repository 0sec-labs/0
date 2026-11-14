import { useMemo } from "react";
import { Info, Square } from "lucide-react";
import type { ConsoleWorker } from "@0/engine/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AgentAvatar } from "../../agent-avatar";
import { InlineImage, transcriptToolImages } from "../../inline-image";
import { Markdown } from "../../markdown";
import { ToolActivity } from "../../tool-activity";
import { isCancellation } from "../../worker-tree";
import { panelViewEntity, type PanelViewComponent } from "../types";
import {
  agentStatusLabel,
  agentTone,
  formatDuration,
  isWorkerActive,
  isWorkerStoppable,
  workerElapsedSeconds,
  workerEndedAt,
  workerStartedAt,
  workerSubtitle,
  workerToolCalls,
  workerCostUsd,
  formatCostUsd,
} from "./agents-model";
import { AgentStatusPill, useAgentViewActions, useNow } from "./agents";

const iso = (value: number | undefined) => (value === undefined ? undefined : new Date(value).toISOString());

export const AgentDetailView: PanelViewComponent = ({ snapshot, viewId, closeView }) => {
  const { onStopWorker, renderComposer } = useAgentViewActions();
  const workerId = panelViewEntity(viewId);
  const worker: ConsoleWorker | undefined = snapshot?.workers.find((item) => item.id === workerId);
  const now = useNow(Boolean(worker && isWorkerActive(worker)));
  const reasoning = useMemo(
    () =>
      worker?.transcript
        .map((turn) => turn.reasoning_summary)
        .filter(Boolean)
        .join("\n\n") ?? "",
    [worker],
  );

  if (!snapshot)
    return (
      <div role="status" className="grid h-full place-items-center text-xs text-muted-foreground-2">
        Loading agent…
      </div>
    );
  if (!worker)
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center">
        <p role="status" className="text-sm text-muted-foreground-1">
          This agent is no longer available.
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => closeView(viewId)}>
          Close tab
        </Button>
      </div>
    );

  const active = isWorkerActive(worker);
  const elapsed = workerElapsedSeconds(worker, now);
  const cost = workerCostUsd(worker);
  const meta = [
    worker.model,
    cost === undefined ? undefined : formatCostUsd(cost),
    elapsed === undefined ? undefined : formatDuration(elapsed),
  ]
    .filter(Boolean)
    .join(" · ");
  const tone = agentTone(worker);
  const composer =
    renderComposer && ["running", "queued", "parked"].includes(worker.status) ? renderComposer(worker) : null;

  return (
    <section aria-label={`Agent ${worker.name}`} className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-border-1 px-2 py-1">
        <AgentAvatar index={snapshot.workers.indexOf(worker)} className="size-(--icon-sm)" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate text-sm font-medium" title={worker.name}>
              {worker.name}
            </h2>
            <AgentStatusPill tone={tone} label={agentStatusLabel(worker)} />
          </div>
          <p className="truncate text-2xs text-muted-foreground-2" title={worker.task}>
            {worker.task
              .split(/\r?\n/)
              .find((line) => line.trim())
              ?.trim()}
          </p>
        </div>
        <Dialog>
          <DialogTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="View agent assignment" />}>
<Info className="size-(--icon-sm)" />
</DialogTrigger>
          <DialogContent>
            <DialogTitle>Agent assignment</DialogTitle>
            <Markdown text={worker.task} />
          </DialogContent>
        </Dialog>
        {onStopWorker && isWorkerStoppable(worker) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => onStopWorker(worker.id)}
          >
            <Square aria-hidden="true" className="size-3" />
            Stop
          </Button>
        )}
      </header>
      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        <div className="space-y-4">
          {meta && <p className="text-2xs tabular-nums text-muted-foreground-2">{meta}</p>}
          {worker.operatorMessages?.map((message) => (
            <div key={message.id} className="ml-6 rounded-lg bg-secondary px-3 py-2 text-sm">
              <span className="sr-only">Your message: </span>
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
            </div>
          ))}
          <ToolActivity
            calls={workerToolCalls(worker)}
            reasoning={reasoning}
            working={active}
            startedAt={iso(workerStartedAt(worker))}
            endedAt={iso(workerEndedAt(worker))}
          />
          {worker.transcript.map((turn) => (
            <article key={turn.turn} className="space-y-3 text-sm">
              {turn.assistant && !isCancellation(turn.assistant) && <Markdown text={turn.assistant} />}
              {(turn.tools ?? [])
                .flatMap((tool) => transcriptToolImages(tool.call.name, tool.result))
                .map((image, index) => (
                  <InlineImage key={index} {...image} />
                ))}
            </article>
          ))}
          {worker.summary &&
            !isCancellation(worker.summary) &&
            worker.summary !== worker.transcript.at(-1)?.assistant && <Markdown text={worker.summary} />}
          {worker.error && !isCancellation(worker.error) && worker.error !== worker.summary && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {worker.error}
            </p>
          )}
          {active && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground-1">
              {workerSubtitle(worker)}
            </p>
          )}
        </div>
      </div>
      {composer && <div className="shrink-0 border-t-[0.5px] border-border-1 p-2">{composer}</div>}
    </section>
  );
};
