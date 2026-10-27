import { ActivityIcon, SourceChip } from "@/components/ui/activity-chip";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, FileSearch, FileText, Globe, Search, Terminal, Wrench, X, CirclePause, ListChecks, PencilLine, Users, MessageSquare, Clock, Database } from "lucide-react";
import { ActivityRow } from "./activity-row";
import { ActivityIndicator, ActivityMark } from "./loading-state";
import { duration } from "./worker-tree";
import { toolCallStatus } from "./tool-call-status";
import type { ToolCallState } from "./transcript";
import "./tool-activity.css";
import { Disclosure } from "@/components/ui/disclosure";

function toolKind(name: string) {
  if (/todo|plan|checklist/i.test(name)) return { Icon: ListChecks, label: "Plan" };
  if (/spawn|delegate|agent.*create/i.test(name)) return { Icon: Users, label: "Agents" };
  if (/message|send.*agent/i.test(name)) return { Icon: MessageSquare, label: "Messages" };
  if (/browser|web|fetch|http/i.test(name)) return { Icon: Globe, label: "Web" };
  if (/search|grep|find/i.test(name)) return { Icon: Search, label: "Search" };
  if (/bash|shell|exec|terminal|command/i.test(name)) return { Icon: Terminal, label: "Commands" };
  if (/write|edit|patch/i.test(name)) return { Icon: PencilLine, label: "Edits" };
  if (/read|file/i.test(name)) return { Icon: FileText, label: "Files" };
  if (/review|scan|analy/i.test(name)) return { Icon: FileSearch, label: "Review" };
  if (/wait|sleep/i.test(name)) return { Icon: Clock, label: "Waiting" };
  if (/memory|store|database/i.test(name)) return { Icon: Database, label: "Memory" };
  return { Icon: Wrench, label: "Tools" };
}
function ToolIcon({ name }: { name: string }) {
  const { Icon } = toolKind(name);
  return <Icon aria-hidden="true" className="size-3.5" />;
}

/** Binary image bytes have their own preview; keep execution details readable. */
export function toolPayloadText(value: unknown): string {
  if (typeof value === "string") {
    try { const decoded: unknown = JSON.parse(value); if (decoded !== null && typeof decoded === "object") return toolPayloadText(decoded); } catch { /* Preserve ordinary text output. */ }
    return value;
  }
  return JSON.stringify(value, function (key, child) {
    if (typeof child === "string" && (key === "imageBase64" || key === "data" && this?.type === "image")) return "(image data; see preview)";
    return child;
  }, 2) ?? "";
}

function toolTitle(call: ToolCallState): string {
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
  if (/send.*message|message.*agent/i.test(call.name)) return `Messaged ${String(args.target || args.agent_id || args.recipient || "agent")}`;
  if (/spawn.*agent/i.test(call.name)) return `Delegated ${String(args.name || args.task_name || "a task")}`;
  return call.name.replaceAll("_", " ");
}

export function ToolResult({ call }: { call: ToolCallState }) {
  const argumentsText = useMemo(() => toolPayloadText(call.arguments), [call.arguments]);
  const resultText = useMemo(() => toolPayloadText(call.result), [call.result]);
  const status = toolCallStatus(call);
  return <ActivityRow icon={<ToolIcon name={call.name} />} title={toolTitle(call)} status={status} running={call.isRunning} failed={status === "Error"}>
    <div className="space-y-3">
      {call.result !== undefined && <div><div className="mb-1 text-muted-foreground">Output</div><pre tabIndex={0} aria-label={`${call.name} output`} className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono">{resultText}</pre></div>}
      {argumentsText && argumentsText !== "{}" && <div><div className="mb-1 text-muted-foreground">Input</div><pre tabIndex={0} aria-label={`${call.name} input`} className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono">{argumentsText}</pre></div>}
      {call.isRunning && <ActivityIndicator label={`Running ${call.name}…`} />}
    </div>
  </ActivityRow>;
}

/** Running tools stay visible even when the assistant has already started speaking. */
export function ToolActivity({ calls, reasoning, working = false, startedAt, endedAt }: { calls: ToolCallState[]; reasoning?: string; working?: boolean; startedAt?: string; endedAt?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!working) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [working]);
  if (!calls.length && !reasoning) return null;
  const running = calls.filter(call => call.isRunning);
  const completed = calls.filter(call => !call.isRunning && call.result !== undefined && toolCallStatus(call) !== "Stopped");
  const active = working || running.length > 0;
  const toolCount = new Set(calls.map(call => call.name)).size;
  const toolCountLabel = `${active ? "Using" : "Used"} ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
  const kinds = [...new Map(calls.map(call => { const kind = toolKind(call.name); return [kind.label, kind] as const; })).values()];
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  const elapsed = Number.isFinite(start) && (active || Number.isFinite(end)) ? duration(((active ? now : end) - start) / 1000) : undefined;
  const label = elapsed ? `${active ? "Working" : "Worked"} for ${elapsed}` : active ? completed.length || running.length ? "Working…" : "Thinking…" : "";
  // Keep recent results in view while working; the full history remains expandable.
  const recent = calls.filter(call => !call.isRunning).slice(-3);
  return <section className="console-tool-activity" aria-label="Tool activity" data-active={active || undefined}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <Disclosure open={expanded} onOpenChange={setExpanded} className={expanded ? "w-full" : "shrink-0 [&>.ui-disclosure-reveal]:hidden"} triggerClassName="inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring" summary={<>
        {active && <span aria-hidden="true" className="inline-flex h-4 w-3.5 shrink-0 items-center justify-center"><ActivityMark compact /></span>}
        <span role="status" aria-live="polite" aria-atomic="true" className="inline-flex flex-wrap items-center gap-1.5">{label && <><span className={active ? "console-working-label" : undefined}>{label}</span>{toolCount > 0 && <span aria-hidden="true">·</span>}</>}{toolCount > 0 && <span>{toolCountLabel}</span>}</span>
        {!!kinds.length && <span className="ml-1 inline-flex items-center gap-1" aria-label={`Used: ${kinds.map(kind => kind.label).join(", ")}`}>{kinds.slice(0, 4).map(({ Icon, label }) => <span key={label} title={label}><ActivityIcon><Icon /></ActivityIcon></span>)}{kinds.length > 4 && <span className="text-[10px]">+{kinds.length - 4}</span>}</span>}

        <ChevronDown aria-hidden="true" className="ui-disclosure-chevron size-3.5" />
      </>}>
      <div className="space-y-0.5 px-1 pb-2">
        {reasoning && <Disclosure className="console-tool-reasoning text-xs text-muted-foreground" triggerClassName="inline-flex items-center gap-1.5 py-2" summary={<>Reasoning summary<ChevronDown aria-hidden="true" className="ui-disclosure-chevron size-3.5" /></>}>
          <div className="max-h-48 overflow-y-auto break-words pb-3 leading-6"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoning}</ReactMarkdown></div>
        </Disclosure>}
        {calls.map(call => <ToolResult key={call.id} call={call} />)}
      </div>
    </Disclosure>
    {!active && !expanded && <SourceActivity calls={completed.filter(call => toolCallStatus(call) === "Done")} />}
    </div>
    {!expanded && active && calls.length > 0 && <ul aria-label="Live tools" className="space-y-1 px-3 pb-3">
      {[...recent, ...running].map(call => {
        const status = toolCallStatus(call);
        return <li key={call.id} className="console-live-tool flex min-w-0 items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-xs" data-running={call.isRunning || undefined}>
          <ActivityIcon className="console-live-tool-icon"><ToolIcon name={call.name} /></ActivityIcon>
          <span className={`min-w-0 flex-1 break-words ${call.isRunning ? "console-working-label" : "text-muted-foreground"}`}>{call.isRunning ? `Using ${toolTitle(call)}` : toolTitle(call)}</span>
          <span className={`flex shrink-0 items-center gap-1.5 ${status === "Error" ? "text-destructive" : "text-muted-foreground"}`}>
            {call.isRunning ? <ActivityMark compact /> : status === "Done" ? <Check aria-hidden="true" className="size-3" /> : status === "Error" ? <X aria-hidden="true" className="size-3" /> : <CirclePause aria-hidden="true" className="size-3" />}
            {status}
          </span>
        </li>;
      })}
    </ul>}
  </section>;
}

/** Only recorded URL evidence becomes a source chip; never manufacture search counts. */
function recordedSources(calls: ToolCallState[]): string[] {
  const sources = new Set<string>();
  for (const call of calls) {
    if (toolKind(call.name).label !== "Web" && !/search/i.test(call.name)) continue;
    let text: string;
    try { text = JSON.stringify([call.arguments, call.result]).slice(0, 100_000); } catch { continue; }
    for (const match of text.matchAll(/https?:\/\/[^\s"<>\\]+/g)) {
      try { const url = new URL(match[0]); if (url.hostname) sources.add(url.origin); } catch { /* Ignore malformed tool output. */ }
    }
  }
  return [...sources];
}
function SourceActivity({ calls }: { calls: ToolCallState[] }) {
  const sources = recordedSources(calls);
  if (!sources.length) return null;
  return <div className="basis-full px-2 pb-2 text-xs text-muted-foreground">
    <Disclosure className="basis-full" summary={<><ActivityIcon><Globe /></ActivityIcon>{sources.length} {sources.length === 1 ? "source" : "sources"}<ChevronDown aria-hidden="true" className="ui-disclosure-chevron size-3" /></>} triggerClassName="inline-flex items-center gap-2 rounded-full py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><div className="ml-2 mt-2 flex flex-wrap gap-2 border-l border-border pl-4">{sources.map(source => <SourceChip key={source} href={source} target="_blank" rel="noopener noreferrer" icon={<Globe aria-hidden="true" />}>{new URL(source).hostname}</SourceChip>)}</div></Disclosure>
  </div>;
}
