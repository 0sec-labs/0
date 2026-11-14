import { useNow } from "@/ui/lib/use-now";
import { memo, Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "./markdown";
import { MessageClamp } from "./message-clamp";
import { ToolActivity } from "./tool-activity";
import { InlineImage, transcriptToolImages } from "./inline-image";
import { MessageToolbar } from "./message-toolbar";
import { cn } from "@/lib/utils";
import { useDisplaySettings } from "@/lib/display-settings";
import { VisualBlock } from "./visual-block";
import { ArtifactCard } from "./artifact-card";
import { clampDisabled, failedCallCount, formatElapsed, hideFromWorkLog, messageLink, turnArtifacts, workedLabel } from "./transcript-actions";
import type { ReducedTurn } from "./transcript";

const hairline =
  "h-px min-w-4 flex-1 bg-border-2 scale-x-0 opacity-0 transition-[transform,opacity] duration-[120ms] ease-[var(--ease-out-quint,cubic-bezier(.23,1,.32,1))] motion-reduce:scale-x-100 motion-reduce:transition-none group-hover/work-head:scale-x-100 group-hover/work-head:opacity-100 group-focus-within/work-head:scale-x-100 group-focus-within/work-head:opacity-100 group-data-[open]/work-head:scale-x-100 group-data-[open]/work-head:opacity-100";

/** Centered "Worked for 12s" disclosure flanked by hairlines; it owns the turn's collapsible work log. */
function TurnWork({ turn, subagents, children }: { turn: ReducedTurn; subagents: number; children: ReactNode }) {
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const id = useId();
  const { transcriptDetail, elapsedTimer } = useDisplaySettings();
  const now = useNow(1000, turn.isWorking);
  // Active turns stay expanded; finished turns collapse unless the reader opened them.
  const open = manual ?? (turn.isWorking || transcriptDetail === "expanded");
  const start = Date.parse(turn.startedAt ?? "");
  const end = turn.isWorking ? now : Date.parse(turn.endedAt ?? "");
  const elapsed =
    Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : undefined;
  const time = elapsed === undefined || !elapsedTimer ? "" : formatElapsed(elapsed);
  const label = workedLabel({
    isWorking: turn.isWorking,
    hasWork: Boolean(turn.toolCalls.length || turn.assistantText),
    stopped: turn.stopReason === "cancelled" || Boolean(turn.error),
    time,
    markers: { failed: failedCallCount(turn.toolCalls), subagents, compacted: Boolean(turn.compacted) },
  });
  return (
    <section aria-label="Turn work" className="min-w-0">
      <div data-open={open || undefined} className="group/work-head flex min-h-7 items-center gap-3">
        <span aria-hidden="true" className={cn(hairline, "origin-right")} />
        <button
          type="button"
          data-turn-work-status
          aria-expanded={open}
          aria-controls={`${id}-work`}
          onClick={() => setManual(!open)}
          className="inline-flex min-h-7 w-fit max-w-[80%] items-center gap-1 rounded-[var(--radius-inner,4px)] text-xs font-normal text-muted-foreground-2 transition-colors hover:text-muted-foreground-1 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className={cn("truncate", turn.isWorking && "ui-text-shimmer")}>
            {label}
          </span>
          {turn.isWorking && time && <span className="tabular-nums">{time}</span>}
          <ChevronRight
            aria-hidden="true"
            className="size-3 flex-none -rotate-90 opacity-0 transition-[transform,opacity] motion-reduce:transition-none group-hover/work-head:opacity-100 group-focus-within/work-head:opacity-100 group-data-[open]/work-head:rotate-0 group-data-[open]/work-head:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </button>
        <span aria-hidden="true" className={cn(hairline, "origin-left")} />
      </div>
      <div
        id={`${id}-work`}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-150 ease-[var(--ease-out-quint,cubic-bezier(.23,1,.32,1))] motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex min-w-0 flex-col gap-2 pt-1 pb-1">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** Render each tool batch beside the commentary that introduced it, under one work disclosure. */
export const TurnTimeline = memo(function TurnTimeline({
  turn,
  streaming,
  onReference,
  latestTurn = false,
  sessionId,
  subagents = 0,
}: {
  turn: ReducedTurn;
  streaming: boolean;
  /** Adds text to the composer draft (visual references and message replies). */
  onReference?: (text: string) => void;
  /** The newest turn: its final answer is never clamped. */
  latestTurn?: boolean;
  sessionId?: string;
  /** Subagents launched by this turn. */
  subagents?: number;
}) {
  const segments = turn.segments?.length
    ? turn.segments
    : [
        ...(turn.reasoningText ? [{ type: "reasoning" as const, text: turn.reasoningText }] : []),
        ...(turn.toolCalls.length ? [{ type: "tools" as const, toolIds: turn.toolCalls.map((call) => call.id) }] : []),
        ...(turn.assistantText ? [{ type: "assistant" as const, text: turn.assistantText }] : []),
      ];
  const latestToolIndex = segments.findLastIndex((segment) => segment.type === "tools");
  const callsById = new Map(turn.toolCalls.map((call) => [call.id, call]));
  // Everything up to the last reasoning/tool segment is work; the trailing assistant text is the answer.
  // Visuals are never work: they render inline, after the work log and in order within the answer.
  const lastWork = segments.findLastIndex((segment) => segment.type !== "assistant" && segment.type !== "visual");
  const visualsById = new Map((turn.visuals ?? []).map((visual) => [visual.id, visual]));
  const render = (segment: (typeof segments)[number], index: number) => {
    if (segment.type === "assistant")
      return (
        <MessageClamp
          key={index}
          id={`${turn.id}:${index}`}
          disabled={clampDisabled({
            latestTurn,
            isLastAssistantSegment: index === segments.findLastIndex((item) => item.type === "assistant"),
          })}
        >
          <Markdown text={segment.text} streaming={streaming && index === segments.length - 1} />
        </MessageClamp>
      );
    if (segment.type === "visual") {
      const visual = visualsById.get(segment.visualId);
      return visual ? <VisualBlock key={segment.visualId} visual={visual} onReference={onReference} /> : null;
    }
    if (segment.type === "reasoning")
      return (
        <ToolActivity
          key={index}
          calls={[]}
          reasoning={segment.text}
          working={streaming && index === segments.length - 1}
        />
      );
    const hasVisuals = Boolean(turn.visuals?.length);
    const calls = segment.toolIds.flatMap((id) => {
      const call = callsById.get(id);
      return call && !hideFromWorkLog(call, hasVisuals) ? [call] : [];
    });
    if (!calls.length) return null;
    return (
      <Fragment key={index}>
        <ToolActivity
          calls={calls}
          showLatest={index === latestToolIndex}
          working={turn.isWorking && index === latestToolIndex}
        />
        {calls
          .flatMap((call) => transcriptToolImages(call.name, call.result))
          .map((img, imageIndex) => (
            <InlineImage key={imageIndex} {...img} />
          ))}
      </Fragment>
    );
  };
  const artifacts = turnArtifacts(turn);
  const answer = segments.slice(lastWork + 1);
  const answerText = answer.flatMap((segment) => (segment.type === "assistant" ? [segment.text] : [])).join("\n\n");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {(lastWork >= 0 || turn.isWorking) && (
        <TurnWork turn={turn} subagents={subagents}>
          {segments
            .slice(0, lastWork + 1)
            .flatMap((segment, index) => (segment.type === "visual" ? [] : [render(segment, index)]))}
        </TurnWork>
      )}
      {segments
        .slice(0, lastWork + 1)
        .flatMap((segment, index) => (segment.type === "visual" ? [render(segment, index)] : []))}
      {answer.length > 0 && (
        <div data-slot="agent-message" className="group/rail relative min-w-0 in-data-[show-timestamps=true]:mt-6">
          {!streaming && answerText && (
            <MessageToolbar
              iso={turn.endedAt ?? turn.startedAt}
              text={answerText}
              align="left"
              onReply={onReference}
              link={typeof window === "undefined" ? undefined : messageLink(window.location.href, turn.id)}
            />
          )}
          {answer.map((segment, index) => render(segment, lastWork + 1 + index))}
        </div>
      )}
      {!turn.isWorking &&
        sessionId &&
        artifacts.map((artifact) => <ArtifactCard key={`${artifact.kind}:${artifact.id}`} artifact={artifact} sessionId={sessionId} />)}
    </div>
  );
});
