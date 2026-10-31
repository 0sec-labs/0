import { Fragment, useEffect, useState } from "react";
import { Markdown } from "./markdown";
import { ToolActivity } from "./tool-activity";
import { InlineImage, transcriptToolImages } from "./inline-image";
import { ActivityMark } from "./loading-state";
import type { ReducedTurn } from "./transcript";

function TurnWorkStatus({ turn }: { turn: ReducedTurn }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!turn.isWorking) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [turn.isWorking]);
  if (!turn.isWorking && !turn.toolCalls.length) return null;
  const start = Date.parse(turn.startedAt ?? "");
  const end = turn.isWorking ? now : Date.parse(turn.endedAt ?? "");
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : undefined;
  const duration = elapsed === undefined ? "" : elapsed >= 60 ? ` for ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : ` for ${elapsed}s`;
  const label = turn.isWorking ? turn.toolCalls.length || turn.assistantText ? "Working" : "Thinking" : turn.stopReason === "cancelled" || turn.error ? "Stopped" : "Worked";
  return <div data-turn-work-status className="flex items-center gap-2 border-b border-border/60 pb-2 text-xs text-muted-foreground">{turn.isWorking && <ActivityMark compact />}<span className={turn.isWorking ? "console-working-label" : undefined}>{label}{duration}</span></div>;
}

/** Render each tool batch beside the commentary that introduced it. */
export function TurnTimeline({ turn, streaming }: { turn: ReducedTurn; streaming: boolean }) {
  const segments = turn.segments?.length ? turn.segments : [
    ...(turn.reasoningText ? [{ type: "reasoning" as const, text: turn.reasoningText }] : []),
    ...(turn.toolCalls.length ? [{ type: "tools" as const, toolIds: turn.toolCalls.map(call => call.id) }] : []),
    ...(turn.assistantText ? [{ type: "assistant" as const, text: turn.assistantText }] : []),
  ];
  const latestToolIndex = segments.findLastIndex(segment => segment.type === "tools");
  const callsById = new Map(turn.toolCalls.map(call => [call.id, call]));
  return <div className="min-w-0 space-y-4">
    <TurnWorkStatus turn={turn} />
    {segments.map((segment, index) => {
      if (segment.type === "assistant") return <Markdown key={index} text={segment.text} streaming={streaming && index === segments.length - 1} />;
      if (segment.type === "reasoning") return <ToolActivity key={index} calls={[]} reasoning={segment.text} working={streaming && index === segments.length - 1} />;
      const calls = segment.toolIds.flatMap(id => { const call = callsById.get(id); return call ? [call] : []; });
      return <Fragment key={index}>
        <ToolActivity calls={calls} showLatest={index === latestToolIndex} working={turn.isWorking && index === latestToolIndex} />
        {calls.flatMap(call => transcriptToolImages(call.name, call.result)).map((img, imageIndex) => <InlineImage key={imageIndex} {...img} />)}
      </Fragment>;
    })}
  </div>;
}
