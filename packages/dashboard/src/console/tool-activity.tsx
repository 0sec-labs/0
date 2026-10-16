import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, FileSearch, FileText, Globe, Search, Terminal, Wrench, X, CirclePause } from "lucide-react";
import { ActivityRow } from "./activity-row";
import { ActivityIndicator, LoadingDots } from "./loading-state";
import { toolCallStatus } from "./tool-call-status";
import type { ToolCallState } from "./transcript";
import "./tool-activity.css";

function ToolIcon({ name }: { name: string }) {
  const Icon = /browser|web|fetch|http/i.test(name) ? Globe
    : /search|grep|find/i.test(name) ? Search
    : /bash|shell|exec|terminal|command/i.test(name) ? Terminal
    : /read|file|write|edit/i.test(name) ? FileText
    : /review|scan|analy/i.test(name) ? FileSearch : Wrench;
  return <Icon aria-hidden="true" className="size-3.5" />;
}

export function ToolResult({ call }: { call: ToolCallState }) {
  const argumentsText = useMemo(() => typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments, null, 2) ?? "", [call.arguments]);
  const resultText = useMemo(() => typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2) ?? "", [call.result]);
  const status = toolCallStatus(call);
  return <ActivityRow icon={<ToolIcon name={call.name} />} title={call.name} status={status} running={call.isRunning} failed={status === "Error"}>
    <div className="space-y-3">
      <div><div className="mb-1 text-muted-foreground">Input</div><pre tabIndex={0} aria-label={`${call.name} input`} className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono">{argumentsText}</pre></div>
      {call.result !== undefined && <div><div className="mb-1 text-muted-foreground">Output</div><pre tabIndex={0} aria-label={`${call.name} output`} className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono">{resultText}</pre></div>}
      {call.isRunning && <ActivityIndicator label={`Running ${call.name}…`} />}
    </div>
  </ActivityRow>;
}

/** Running tools stay visible even when the assistant has already started speaking. */
export function ToolActivity({ calls, reasoning, working = false }: { calls: ToolCallState[]; reasoning?: string; working?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!calls.length && !reasoning) return null;
  const running = calls.filter(call => call.isRunning);
  const completed = calls.filter(call => !call.isRunning && call.result !== undefined && toolCallStatus(call) !== "Stopped");
  const failed = calls.filter(call => toolCallStatus(call) === "Error").length;
  const active = working || running.length > 0;
  const used = `Used ${completed.length} ${completed.length === 1 ? "tool" : "tools"}`;
  const label = running.length ? `${used} · ${running.length} running`
    : active ? completed.length ? `${used} · Thinking…` : "Thinking…"
    : calls.length ? used : "Thought process";
  // Keep recent results in view while working; the full history remains expandable.
  const recent = active ? calls.filter(call => !call.isRunning).slice(-2) : [];
  return <section className="console-tool-activity rounded-xl bg-muted/20" aria-label="Tool activity" data-active={active || undefined}>
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
        {active ? <LoadingDots className="console-loading-dots-compact" /> : <Wrench aria-hidden="true" className="size-3.5" />}
        <span role="status" aria-live="polite" aria-atomic="true"><span className={active ? "console-working-label" : undefined}>{label}</span>{failed > 0 && <span className="text-destructive"> · {failed} failed</span>}</span>
        <ChevronDown aria-hidden="true" className={`ml-auto size-3.5 transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
      </summary>
      <div className="space-y-2 px-3 pb-3">
        {reasoning && <details className="console-tool-reasoning text-xs text-muted-foreground">
          <summary className="cursor-pointer py-2">Reasoning summary</summary>
          <div className="max-h-48 overflow-y-auto break-words pb-3 leading-6"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoning}</ReactMarkdown></div>
        </details>}
        {calls.map(call => <ToolResult key={call.id} call={call} />)}
      </div>
    </details>
    {!expanded && active && calls.length > 0 && <ul aria-label="Live tools" className="space-y-1 px-3 pb-3">
      {[...recent, ...running].map(call => {
        const status = toolCallStatus(call);
        return <li key={call.id} className="console-live-tool flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs" data-running={call.isRunning || undefined}>
          <span className="console-live-tool-icon flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground"><ToolIcon name={call.name} /></span>
          <span className={`min-w-0 flex-1 break-words ${call.isRunning ? "console-working-label" : "text-muted-foreground"}`}>{call.isRunning ? `Using ${call.name}` : call.name}</span>
          <span className={`flex shrink-0 items-center gap-1.5 ${status === "Error" ? "text-destructive" : "text-muted-foreground"}`}>
            {call.isRunning ? <LoadingDots className="console-loading-dots-compact" /> : status === "Done" ? <Check aria-hidden="true" className="size-3" /> : status === "Error" ? <X aria-hidden="true" className="size-3" /> : <CirclePause aria-hidden="true" className="size-3" />}
            {status}
          </span>
        </li>;
      })}
    </ul>}
  </section>;
}
