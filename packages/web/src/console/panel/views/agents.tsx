import { useNow as useSharedNow } from "@/ui/lib/use-now";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CirclePause, Square } from "lucide-react";
import {
  CapyCheckIcon as Check,
  CapyChevronRightIcon as ChevronRight,
  CapyAlertIcon as CircleAlert,
} from "@/ui/icons/capy";
import type { ConsoleWorker } from "@0/engine/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../../agent-avatar";
import { ActivityMark } from "../../loading-state";
import { SwarmProgress } from "../../swarm-progress";
import { agentViewId, type PanelViewComponent } from "../types";
import { agentRows, agentsSummary, type AgentRow, type AgentTone } from "./agents-model";

/**
 * Host-provided capabilities for the agent views. WP6 mounts this around the panel, like FindingActionsProvider.
 * Omitted callbacks hide the matching control.
 */
export type AgentViewActions = {
  /** Open the existing "drain" confirmation for the chat (console-page `setConfirm({ kind: "drain" })`). */
  onStopAll?: () => void;
  /** Stop one worker (`stopConsoleWorker(sessionId, workerId)` wrapped in `workspace.perform`). */
  onStopWorker?: (workerId: string) => void;
  /**
   * Render the worker composer for a running/queued/parked worker, e.g.
   * `worker => <Composer worker={worker} .../>` exactly as console-page passes to AgentsPanel today.
   */
  renderComposer?: (worker: ConsoleWorker) => ReactNode;
};
const AgentViewActionsContext = createContext<AgentViewActions>({});
export function AgentViewActionsProvider({ value, children }: { value: AgentViewActions; children: ReactNode }) {
  return <AgentViewActionsContext.Provider value={value}>{children}</AgentViewActionsContext.Provider>;
}
export const useAgentViewActions = () => useContext(AgentViewActionsContext);

/** Re-render once a second while something is live so ages and durations tick. */
export const useNow = (live: boolean): number => useSharedNow(1000, live);

const TONE_PILL: Record<AgentTone, string> = {
  running: "bg-secondary text-foreground",
  waiting: "bg-secondary text-muted-foreground-1",
  done: "bg-secondary text-muted-foreground-1",
  failed: "bg-destructive/10 text-destructive",
  stopped: "bg-secondary text-muted-foreground-2",
};
export function AgentStatusMark({ tone, className }: { tone: AgentTone; className?: string }) {
  if (tone === "running") return <ActivityMark compact />;
  const Icon = tone === "done" ? Check : tone === "failed" ? CircleAlert : CirclePause;
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-3", tone === "failed" ? "text-destructive" : "text-muted-foreground-2", className)}
    />
  );
}
export function AgentStatusPill({ tone, label }: { tone: AgentTone; label: string }) {
  return (
    <span
      data-agent-status={tone}
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full px-1.5 text-2xs font-medium",
        TONE_PILL[tone],
      )}
    >
      <AgentStatusMark tone={tone} />
      {label}
    </span>
  );
}

function AgentRowButton({ row, onOpen }: { row: AgentRow; onOpen: () => void }) {
  const meta = [row.model, row.cost, row.elapsed ?? row.age].filter(Boolean).join(" · ");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-agent-id={row.id}
        data-agent-status={row.tone}
        className="group flex min-h-10 w-full items-start gap-2 rounded px-2 py-1 text-left outline-none transition-colors hover:bg-popover-hover focus-visible:outline-ring-inset"
      >
        <AgentAvatar index={row.index} className="mt-0.5 size-(--icon-sm)" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className={cn("min-w-0 truncate text-sm", row.tone === "done" && "text-muted-foreground-1")}
              title={row.name}
            >
              {row.name}
            </span>
            <AgentStatusPill tone={row.tone} label={row.statusLabel} />
          </span>
          {row.task && (
            <span className="block truncate text-2xs text-muted-foreground-2" title={row.task}>
              {row.task}
            </span>
          )}
          {meta && <span className="block truncate text-2xs tabular-nums text-muted-foreground-3">{meta}</span>}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="mt-1 size-3 shrink-0 text-muted-foreground-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    </li>
  );
}

export const AgentsView: PanelViewComponent = ({ snapshot, openView }) => {
  const { onStopAll } = useAgentViewActions();
  const workers = snapshot?.workers;
  const live = Boolean(workers?.some((worker) => worker.status === "running" || worker.status === "queued"));
  const now = useNow(live);
  const rows = useMemo(() => agentRows(workers ?? [], now), [workers, now]);
  const summary = useMemo(() => agentsSummary(workers ?? []), [workers]);

  if (!snapshot)
    return (
      <div role="status" className="grid h-full place-items-center text-xs text-muted-foreground-2">
        Loading agents…
      </div>
    );
  if (!workers?.length)
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 px-6 text-center">
        <AgentAvatar index={4} className="mb-2 size-8 opacity-30 grayscale" />
        <p className="max-w-xs text-balance text-xs text-muted-foreground-3">
          No agents yet; they show up here when work is delegated.
        </p>
      </div>
    );

  return (
    <section aria-label="Agents" className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-border-1 px-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground-1" role="status">
          {summary.text || `${summary.total} agents`}
        </span>
        {onStopAll && summary.stoppable > 0 && (
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onStopAll}>
            <Square aria-hidden="true" className="size-3" />
            Stop all
          </Button>
        )}
      </header>
      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {workers.length > 1 && (
          <div className="px-1 pb-1">
            <SwarmProgress workers={workers} onSelect={(id) => openView(agentViewId(id))} />
          </div>
        )}
        <ul className="flex flex-col gap-px" aria-label="Agent list">
          {rows.map((row) => (
            <AgentRowButton
              key={row.id}
              row={row}
              onOpen={() => openView(agentViewId(row.id), { title: `Agent: ${row.name}` })}
            />
          ))}
        </ul>
      </div>
    </section>
  );
};
