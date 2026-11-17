import { Check, X } from "lucide-react";
import { Disclosure } from "@/components/ui/disclosure";
import { useAgentTurnsByNonce } from "@/console/agent-turns-context";
import { CAUSE_LABEL, parseWakeHeader, wakeSummary, workedFor, type WakeHeader } from "@/sentinels/wake";
import type { AgentTurn } from "@/sentinels/model";
import { cn } from "@/lib/utils";

const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

/** A trigger turn in an Agent's thread: a quiet centered line with its cause, collapsed; expanded it says what arrived and how it ended. */
export function AgentWakeLine({ header, text }: { header: WakeHeader; text: string }) {
  const turn: AgentTurn | undefined = useAgentTurnsByNonce()?.get(header.nonce);
  const summary = wakeSummary(header, turn);
  const cause = CAUSE_LABEL[turn?.origin ?? header.origin ?? "schedule"];
  const instructions = /<trigger-instructions>\n([\s\S]*?)\n<\/trigger-instructions>/.exec(text)?.[1]?.trim();
  return <Disclosure
    data-slot="agent-wake" data-status={turn?.status}
    className="mx-auto w-full max-w-[77%] min-w-0"
    triggerClassName="mx-auto flex min-h-7 w-fit max-w-full items-center gap-2 rounded-[var(--radius-inner,4px)] text-xs text-muted-foreground-2 transition-colors hover:text-muted-foreground-1"
    contentClassName="pt-1"
    summary={<>
      <span data-slot="cause-chip" className="flex-none rounded-md bg-secondary px-1.5 py-px text-[11px] leading-4 font-medium text-muted-foreground-1">{cause}</span>
      <span className={cn("truncate", summary.working && "animate-pulse")}>{summary.text}</span>
      {summary.failed && <X aria-label="Failed" className="size-3 flex-none text-destructive" />}
    </>}>
    <ul className="mx-auto flex w-full max-w-md flex-col gap-1.5 border-y-[0.5px] border-border-1 py-2 text-xs text-muted-foreground wrap-anywhere">
      <li>{header.source}</li>
      {instructions && <li className="line-clamp-3 whitespace-pre-wrap text-muted-foreground-1">{instructions}</li>}
      {turn && <li className="flex items-center gap-1.5">
        {turn.status === "completed" && <Check aria-hidden="true" className="size-3 text-success" />}
        {turn.status === "failed" && <X aria-hidden="true" className="size-3 text-destructive" />}
        <span>{{ queued: "Waiting its turn", running: "Working", completed: "Ended the turn", failed: "Failed", cancelled: "Stopped", skipped: "Skipped" }[turn.status]}{turn.startedAt ? ` · started ${clock(turn.startedAt)}` : ""}{turn.startedAt && turn.finishedAt ? ` · ${workedFor(Date.parse(turn.finishedAt) - Date.parse(turn.startedAt))}` : ""}{turn.costUsd !== undefined ? ` · $${turn.costUsd.toFixed(2)}` : ""}</span>
      </li>}
      {turn?.error && <li className="text-destructive">{turn.error}</li>}
    </ul>
  </Disclosure>;
}

export { parseWakeHeader };
