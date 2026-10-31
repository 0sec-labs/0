import { ActivityIcon, SourceChip } from "@/components/ui/activity-chip";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, FileSearch, FileText, Globe, Search, Terminal, Wrench, ListChecks, PencilLine, Users, MessageSquare, Clock, Database } from "lucide-react";
import { ActivityRow } from "./activity-row";
import { ActivityIndicator, ActivityMark } from "./loading-state";
import { toolCallStatus } from "./tool-call-status";
import { presentToolCall } from "./tool-presentation";
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
  const view = presentToolCall(call);
  const prefix = call.isRunning ? "Running" : view.status === "Error" ? "Failed" : view.status === "Stopped" ? "Stopped" : view.command ? "Ran" : "Used";
  if (!call.isRunning && view.status === "Done" && !view.command) {
    if (/^(Read|Search|Update|Save|Finish|List) /.test(view.title)) return view.title.replace(/^Search /, "Searched ").replace(/^Update /, "Updated ").replace(/^Save /, "Saved ").replace(/^Finish /, "Finished ").replace(/^List /, "Listed ");
  }
  return `${prefix} ${view.title}`;
}

function ToolDetails({ call }: { call: ToolCallState }) {
  const view = presentToolCall(call);
  return <div className="space-y-3">
    {(view.command || view.source || view.output !== undefined) && <div className="overflow-hidden rounded-lg border border-border bg-muted/30 text-xs">
      <div className="px-3 py-2 text-muted-foreground">{view.command ? "Shell" : view.language || "Output"}</div>
      <div className="max-h-80 overflow-auto px-3 pb-3 font-mono text-xs leading-6">
        {view.command && <pre aria-label={`${call.name} command`} className="mb-3 whitespace-pre-wrap break-words">$ {view.command}</pre>}
        {view.source && view.language && <pre aria-label={`${call.name} source`} className="mb-3 whitespace-pre-wrap break-words">{view.source}</pre>}
        {view.output !== undefined && <pre aria-label={`${call.name} output`} className="whitespace-pre-wrap break-words">{view.output || (call.isRunning ? "Waiting for output…" : "No output.")}</pre>}
        {call.isRunning && view.output === undefined && <span className="text-muted-foreground">Waiting for output…</span>}
      </div>
    </div>}
    {view.input && !view.command && !view.source && <pre aria-label={`${call.name} input`} className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{view.input}</pre>}
    {view.metadata.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">{view.metadata.map(item => <span key={item.label}>{item.label}: {item.value}</span>)}</div>}
    <Disclosure summary="Raw details" triggerClassName="py-1 text-[11px] text-muted-foreground">
      <div className="space-y-3 pt-2">{view.rawArguments && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{view.rawArguments}</pre>}{view.rawResult && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{view.rawResult}</pre>}</div>
    </Disclosure>
  </div>;
}

export function ToolResult({ call }: { call: ToolCallState }) {
  const status = presentToolCall(call).status;
  return <ActivityRow icon={call.isRunning ? <ActivityMark compact /> : <ToolIcon name={call.name} />} title={toolTitle(call)} status={status === "Error" || status === "Stopped" ? status : ""} running={call.isRunning} failed={status === "Error"}><ToolDetails call={call} /></ActivityRow>;
}

/** One activity row per batch combines live status, latest operation and history. */
export function ToolActivity({ calls, reasoning, working = false, showLatest = false }: { calls: ToolCallState[]; reasoning?: string; working?: boolean; showLatest?: boolean; startedAt?: string; endedAt?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!calls.length && !reasoning) return null;
  const running = calls.filter(call => call.isRunning);
  const failed = calls.filter(call => toolCallStatus(call) === "Error").length;
  const active = running.length > 0 || working;
  const latest = showLatest || active ? running.at(-1) ?? calls.at(-1) : undefined;
  const history = calls.filter(call => call !== latest);
  const GroupIcon = toolKind(latest?.name ?? calls[0]?.name ?? "tools").Icon;
  return <section className="console-tool-activity" aria-label="Tool activity" data-active={active || undefined} data-latest-tool={latest ? "true" : undefined}>
    <Disclosure open={expanded} onOpenChange={setExpanded} triggerClassName="group/tool-history inline-flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" summary={<>
      {active ? <ActivityMark compact /> : <GroupIcon aria-hidden="true" className="size-3.5 shrink-0" />}
      {active && <span className="console-working-label shrink-0">{calls.length ? "Working…" : "Thinking…"}</span>}
      {latest ? <span className="min-w-0 truncate" title={toolTitle(latest)}>{active ? `· ${latest.isRunning ? presentToolCall(latest).title : toolTitle(latest)}` : toolTitle(latest)}</span> : !active && <span>{calls.length ? `${calls.length} tool call${calls.length === 1 ? "" : "s"}` : "Thinking"}</span>}
      {latest && calls.length > 1 && <span className="shrink-0 text-muted-foreground/70">· {calls.length} tool calls</span>}
      {!latest && running.length > 0 && <span role="status">· {running.length} running</span>}
      {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
      <ChevronRight aria-hidden="true" className={`console-history-chevron size-3 shrink-0 transition-transform ${expanded ? "rotate-90 opacity-100" : "opacity-0 group-hover/tool-history:opacity-100 group-focus-visible/tool-history:opacity-100 [@media(hover:none)]:opacity-100"}`} />
    </>}>
      <div className="space-y-3 py-2">
        {reasoning && <div className="console-tool-reasoning max-h-48 overflow-y-auto break-words text-xs leading-6 text-muted-foreground"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoning}</ReactMarkdown></div>}
        {latest && <ToolDetails call={latest} />}
        {history.length > 0 && <div className="space-y-0.5">{latest && <p className="pb-1 text-[11px] text-muted-foreground">Earlier calls</p>}{history.map(call => <ToolResult key={call.id} call={call} />)}</div>}
      </div>
    </Disclosure>
    {!expanded && !active && <SourceActivity calls={calls.filter(call => toolCallStatus(call) === "Done")} />}
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
