import { SourceChip } from "@/components/ui/activity-chip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Globe } from "lucide-react";
import { ActivityRow } from "./activity-row";
import { ScrollFade } from "./scroll-fade";
import { presentToolCall } from "./tool-presentation";
import { toolCallStatus } from "./tool-call-status";
import { groupFinishedCalls, groupSummary } from "./tool-groups";
import type { ToolCallState } from "./transcript";
import { Disclosure } from "@/components/ui/disclosure";
import { useDisplaySettings } from "@/lib/display-settings";

function toolKind(name: string): string {
  if (/todo|plan|checklist/i.test(name)) return "Plan";
  if (/spawn|delegate|agent.*create/i.test(name)) return "Helpers";
  if (/message|send.*agent/i.test(name)) return "Messages";
  if (/browser|web|fetch|http/i.test(name)) return "Web";
  return "Tools";
}

// Compatibility export: semantic details and raw payloads share one safe formatter.
export { toolPresentationText as toolPayloadText } from "./tool-presentation";

function toolTitle(call: ToolCallState): string {
  if (call.name === "ask_operator") return call.isRunning ? "Asking a question" : toolCallStatus(call) === "Done" ? "Asked a question" : "Question not answered";
  const view = presentToolCall(call);
  const prefix = call.isRunning
    ? "Running"
    : view.status === "Error"
      ? "Failed"
      : view.status === "Stopped"
        ? "Stopped"
        : view.command
          ? "Ran"
          : "Used";
  if (!call.isRunning && view.status === "Done" && !view.command) {
    if (/^(Read|Search|Update|Save|Finish|List) /.test(view.title))
      return view.title
        .replace(/^Search /, "Searched ")
        .replace(/^Update /, "Updated ")
        .replace(/^Save /, "Saved ")
        .replace(/^Finish /, "Finished ")
        .replace(/^List /, "Listed ");
  }
  return `${prefix} ${view.title}`;
}

function formatDuration(ms: string): string {
  const value = Number.parseFloat(ms);
  return Number.isFinite(value)
    ? value >= 60_000
      ? `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`
      : `${(value / 1000).toFixed(1)}s`
    : ms;
}

function ToolDetails({ call }: { call: ToolCallState }) {
  const view = presentToolCall(call);
  const exit = view.command ? view.metadata.find((item) => item.label === "Exit code") : undefined;
  const took = view.command ? view.metadata.find((item) => item.label === "Duration") : undefined;
  const metadata = view.metadata.filter((item) => item !== exit && item !== took);
  return (
    <div className="space-y-2">
      {(view.command || view.source || view.output !== undefined) && (
        <div className="overflow-hidden rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card">
          <ScrollFade className="max-h-72 px-2.5 py-1.5 font-mono text-xs leading-5 text-foreground">
            {view.command && (
              <pre aria-label={`${call.name} command`} className="mb-1.5 flex gap-2 whitespace-pre-wrap break-words">
                <span aria-hidden="true" className="select-none text-muted-foreground-2">
                  $
                </span>
                <span className="min-w-0">{view.command}</span>
              </pre>
            )}
            {view.source && view.language && (
              <pre aria-label={`${call.name} source`} className="mb-1.5 whitespace-pre-wrap break-words">
                {view.source}
              </pre>
            )}
            {view.output !== undefined && (
              <pre aria-label={`${call.name} output`} className="whitespace-pre-wrap break-words">
                {view.output || (call.isRunning ? "Waiting for output…" : "No output.")}
              </pre>
            )}
            {call.isRunning && view.output === undefined && (
              <span className="text-muted-foreground-2">Waiting for output…</span>
            )}
          </ScrollFade>
          {(exit || took) && (
            <div className="flex items-center justify-between gap-3 px-2.5 pb-1.5 text-2xs tabular-nums text-muted-foreground-2">
              <span>{exit ? `exit ${exit.value}` : ""}</span>
              <span>{took ? formatDuration(took.value) : ""}</span>
            </div>
          )}
        </div>
      )}
      {view.input && !view.command && !view.source && (
        <pre
          aria-label={`${call.name} input`}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground-1"
        >
          {view.input}
        </pre>
      )}
      {metadata.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground-2">
          {metadata.map((item) => (
            <span key={item.label}>
              {item.label}: {item.value}
            </span>
          ))}
        </div>
      )}
      <Disclosure summary="Raw details" triggerClassName="py-1 text-2xs text-muted-foreground-2 hover:text-foreground">
        <div className="space-y-3 pt-2">
          {view.rawArguments && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
              {view.rawArguments}
            </pre>
          )}
          {view.rawResult && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
              {view.rawResult}
            </pre>
          )}
        </div>
      </Disclosure>
    </div>
  );
}

function ToolResult({ call, shimmer }: { call: ToolCallState; shimmer: boolean }) {
  const status = presentToolCall(call).status;
  return (
    <ActivityRow
      title={toolTitle(call)}
      status={status === "Error" || status === "Stopped" ? status : ""}
      running={call.isRunning}
      shimmer={shimmer}
      failed={status === "Error"}
    >
      <ToolDetails call={call} />
    </ActivityRow>
  );
}

/** A plain work-log list: one verb/object row per call; the turn disclosure owns collapsing. */
export function ToolActivity({
  calls: allCalls,
  reasoning,
  working = false,
  showLatest = false,
  shimmerId,
  shimmerReasoning = working,
}: {
  calls: ToolCallState[];
  reasoning?: string;
  working?: boolean;
  /** The one running call allowed to shimmer; `null` for none. Defaults to the last running call of this list. */
  shimmerId?: string | null;
  /** The reasoning row is the live tail ("Thinking"); past reasoning reads "Thought" and never shimmers. */
  shimmerReasoning?: boolean;
  showLatest?: boolean;
  startedAt?: string;
  endedAt?: string;
}) {
  const { toolCardStyle } = useDisplaySettings();
  // "Hidden" folds away finished successful calls; running, failed and stopped calls always show.
  const started = allCalls.filter((call) => !call.queued);
  const calls =
    toolCardStyle === "hidden"
      ? started.filter((call) => call.isRunning || toolCallStatus(call) !== "Done")
      : started;
  if (!calls.length && !reasoning) return null;
  const running = calls.filter((call) => call.isRunning);
  const shimmering = shimmerId === undefined ? running.at(-1)?.id : (shimmerId ?? undefined);
  const items = groupFinishedCalls(calls);
  const active = running.length > 0 || working;
  const sources = recordedSources(allCalls.filter((call) => toolCallStatus(call) === "Done"));
  const latest = showLatest || active ? (running.at(-1) ?? calls.at(-1)) : undefined;
  return (
    <section
      aria-label="Tool activity"
      data-active={active || undefined}
      data-latest-tool={latest ? "true" : undefined}
      className="flex min-w-0 flex-col gap-1"
    >
      {reasoning && (
        <ActivityRow title={working ? "Thinking…" : "Thought"} status="" running={working} shimmer={shimmerReasoning}>
          <div className="max-h-48 overflow-y-auto break-words text-xs leading-5 text-muted-foreground-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoning}</ReactMarkdown>
          </div>
        </ActivityRow>
      )}
      {items.map((item) =>
        item.type === "call" ? (
          <ToolResult key={item.call.id} call={item.call} shimmer={item.call.id === shimmering} />
        ) : (
          <ActivityRow key={item.id} title={groupSummary(item.calls)} status="">
            <div className="flex flex-col gap-1 border-l-[0.5px] border-border-1 pl-3">
              {item.calls.map((call) => (
                <ToolResult key={call.id} call={call} shimmer={false} />
              ))}
            </div>
          </ActivityRow>
        ),
      )}
      {sources.length > 0 && (
        <div aria-label="Sources" className="flex flex-wrap gap-2 py-1">
          {sources.map((source) => (
            <SourceChip
              key={source}
              href={source}
              target="_blank"
              rel="noopener noreferrer"
              icon={<Globe aria-hidden="true" />}
            >
              {new URL(source).hostname}
            </SourceChip>
          ))}
        </div>
      )}
    </section>
  );
}

/** Only recorded URL evidence becomes a source chip; never manufacture search counts. */
function recordedSources(calls: ToolCallState[]): string[] {
  const sources = new Set<string>();
  for (const call of calls) {
    if (toolKind(call.name) !== "Web" && !/search/i.test(call.name)) continue;
    let text: string;
    try {
      text = JSON.stringify([call.arguments, call.result]).slice(0, 100_000);
    } catch {
      continue;
    }
    for (const match of text.matchAll(/https?:\/\/[^\s"<>\\]+/g)) {
      try {
        const url = new URL(match[0]);
        if (url.hostname) sources.add(url.origin);
      } catch {
        /* Ignore malformed tool output. */
      }
    }
  }
  return [...sources];
}
