import { ContextRing } from "@/components/ui/context-ring";
import { Disclosure } from "@/components/ui/disclosure";
import type { ConsoleSessionSnapshot, HarnessUiEvent, HarnessViewBlock } from "@0/shared";
import { Link } from "react-router-dom";
import { TaskProgressList } from "./task-progress";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Markdown } from "./markdown";
import { ChatFindings } from "./chat-findings";
import { ToolCatalog } from "./tool-catalog";
import { SourceContext } from "./source-context";
import type { FindingRecord } from "@/types";

export function ConsoleInspector({ snapshot, busy, stagePrompt, onScope, onDrain, onHarness, onAddFinding }: { snapshot: ConsoleSessionSnapshot; onAddFinding: (finding: FindingRecord) => void; busy: boolean; stagePrompt: (text: string) => void; onScope: () => void; onDrain: () => void; onHarness: (providerId: string, event: HarnessUiEvent) => void }) {
  const controlsQuery = `?session=${encodeURIComponent(snapshot.session.id)}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`;
  const totalTokens = snapshot.usage.inputTokens + snapshot.usage.outputTokens;
  const contextWindow = snapshot.contextWindowTokens ?? snapshot.runtime?.contextWindowTokens;
  const hasScope = Boolean(snapshot.session.target || snapshot.scope?.in_scope?.length || snapshot.scope?.out_of_scope?.length);
  const hasHarnessContent = Boolean(snapshot.harness && (snapshot.harness.error || snapshot.harness.views.length || snapshot.harness.commands.length || snapshot.harness.settings.length));
  return <div className="console-inspector min-w-0 space-y-3 px-4 py-3 text-sm [&>section+section]:border-t [&>section+section]:border-border/30 [&>section+section]:pt-3">
    <section aria-label="Chat usage" className="space-y-4">
      <div className="flex items-center gap-3"><ContextRing className="size-9 text-foreground" percent={contextWindow && snapshot.contextInputTokens !== undefined ? snapshot.contextInputTokens / contextWindow * 100 : undefined} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3 text-sm font-medium"><span>Context</span><span className="tabular-nums">{contextWindow && snapshot.contextInputTokens !== undefined ? `${Math.round(snapshot.contextInputTokens / contextWindow * 100)}%` : "—"}</span></div><p className="mt-0.5 text-xs text-muted-foreground">{snapshot.contextInputTokens?.toLocaleString() ?? "—"}{contextWindow ? ` / ${contextWindow.toLocaleString()} tokens` : " tokens"}</p></div></div>
      <dl className="grid grid-cols-2 gap-4 text-xs"><div><dt className="text-muted-foreground">Total tokens</dt><dd className="mt-1 text-sm tabular-nums">{totalTokens.toLocaleString()}</dd></div><div><dt className="text-muted-foreground" title="API-rate estimate based on token usage; subscription charges may differ.">{snapshot.usage.costKind === "reported" ? "Reported cost" : "Estimated cost"}</dt><dd className="mt-1 text-sm tabular-nums">{typeof snapshot.usage.costUsd === "number" ? `$${snapshot.usage.costUsd.toFixed(2)}${snapshot.usage.costUnavailable ? " · partial" : ""}` : "Unavailable"}</dd></div></dl>
      <Disclosure className="text-xs" summary={<> Token breakdown </>} triggerClassName="cursor-pointer py-1 text-muted-foreground"><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2"><dt className="text-muted-foreground">Input tokens</dt><dd className="text-right tabular-nums">{snapshot.usage.inputTokens.toLocaleString()}</dd><dt className="text-muted-foreground">Output tokens</dt><dd className="text-right tabular-nums">{snapshot.usage.outputTokens.toLocaleString()}</dd><dt className="text-muted-foreground">Context</dt><dd className="text-right tabular-nums">{snapshot.contextInputTokens?.toLocaleString() ?? "—"}{contextWindow ? ` / ${contextWindow.toLocaleString()}` : ""}</dd><dt className="text-muted-foreground">Cost breakdown</dt><dd className="text-right">{typeof snapshot.usage.costUsd === "number" ? `$${snapshot.usage.costUsd.toFixed(4)} (${snapshot.usage.costKind ?? "estimated"})` : "Unknown"}</dd>{snapshot.lastOutcome && <><dt className="text-muted-foreground">Step tokens</dt><dd className="text-right">{snapshot.lastOutcome.budget.tokensUsed.toLocaleString()} / {snapshot.lastOutcome.budget.tokenBudget?.toLocaleString() ?? "unlimited"}</dd><dt className="text-muted-foreground">Tool calls</dt><dd className="text-right">{snapshot.lastOutcome.budget.iterations} / {snapshot.lastOutcome.budget.maxToolIterations ?? "unlimited"}</dd><dt className="text-muted-foreground">Stopped because</dt><dd className="break-words text-right">{snapshot.lastOutcome.stopReason.replaceAll("_", " ")}</dd></>}</dl></Disclosure>
    </section>

    {(snapshot.objective || !!snapshot.todos?.todos.length) && <Disclosure summary={<>{snapshot.todos ? "Plan" : "Objective"}{snapshot.todos ? ` · ${snapshot.todos.done}/${snapshot.todos.total}` : ""}</>} triggerClassName="py-1 text-sm font-medium"><div className="space-y-4 pt-3">
    {snapshot.objective && <section className="space-y-2"><h3 className="text-sm font-medium text-foreground">Objective</h3><p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{snapshot.objective}</p></section>}
    {!!snapshot.todos?.todos.length && <section className="space-y-2"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-foreground">Plan</h3><span className="text-xs text-muted-foreground">{snapshot.todos.done} / {snapshot.todos.total}</span></div>{!["working", "waiting"].includes(snapshot.session.status) && snapshot.todos.todos.some(todo => !["completed", "cancelled"].includes(todo.status)) && <p className="text-xs text-muted-foreground">This chat is not running. The checklist has items not marked complete.</p>}<TaskProgressList todos={snapshot.todos} active={["working", "waiting"].includes(snapshot.session.status)} /></section>}
    </div></Disclosure>}

    <SourceContext context={snapshot.sourceContext} />
    <Disclosure summary="Findings from this chat" triggerClassName="py-1 text-xs text-muted-foreground"><div className="pt-3"><ChatFindings sessionId={snapshot.session.id} savedId={snapshot.session.savedId} busy={busy} onAdd={onAddFinding} /></div></Disclosure>
    {hasScope && <section className="space-y-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium text-foreground">Scope</h3><Button variant="ghost" size="sm" disabled={busy} onClick={onScope}>Edit scope</Button></div>
      {snapshot.session.target && <p className="break-words text-xs leading-5">{snapshot.session.target}</p>}
      {!!snapshot.scope?.in_scope?.length && <div className="text-xs"><p className="text-muted-foreground">Included targets</p><ul className="mt-2 space-y-1">{snapshot.scope.in_scope.map(target => <li key={target} className="break-words">{target}</li>)}</ul></div>}
      {!!snapshot.scope?.out_of_scope?.length && <Disclosure className="text-xs" summary={<> Excluded targets </>} triggerClassName="cursor-pointer py-1 text-muted-foreground"><ul className="mt-2 space-y-1">{snapshot.scope.out_of_scope.map(target => <li key={target} className="break-words">{target}</li>)}</ul></Disclosure>}
    </section>}
    {hasHarnessContent && <section className="space-y-3 pt-2">
      <h3 className="text-sm font-medium text-foreground">{snapshot.harness?.label || "Extensions"}</h3>
      {snapshot.harness ? <>
        {snapshot.harness.error && <p role="alert" className="text-xs text-destructive">{snapshot.harness.error}</p>}
        {snapshot.harness.views.map(({ providerId, view }) => <div key={providerId} className="space-y-3 rounded-[var(--radius-panel)] bg-muted/30 p-3"><div className="text-xs font-medium">{view.title}</div>{view.blocks.map((block, index) => <HarnessBlock key={index} block={block} stagePrompt={stagePrompt} />)}</div>)}
        {snapshot.harness.commands.map((command) => <div key={`${command.providerId}:${command.id}`} className="space-y-1"><Button className="w-full justify-start" variant="outline" size="sm" disabled={busy || snapshot.session.status !== "ready" || !snapshot.harness?.generationId} onClick={() => onHarness(command.providerId, { kind: "command", id: command.id })}>{command.label}</Button>{command.description && <p className="text-xs leading-5 text-muted-foreground">{command.description}</p>}</div>)}
        {snapshot.harness.settings.map((setting) => <label key={`${snapshot.harness?.generationId}:${setting.providerId}:${setting.id}`} className="block space-y-2 rounded-[var(--radius-panel)] bg-muted/30 p-3 text-xs"><span className="font-medium">{setting.label}</span>{setting.description && <span className="block text-muted-foreground">{setting.description}</span>}{setting.type === "boolean" ? <Switch aria-label={setting.label} checked={Boolean(setting.value)} disabled={busy || snapshot.session.status !== "ready" || !snapshot.harness?.generationId} onCheckedChange={value => onHarness(setting.providerId, { kind: "setting", id: setting.id, value })} /> : setting.type === "select" ? <Select aria-label={setting.label} value={String(setting.value)} disabled={busy || snapshot.session.status !== "ready" || !snapshot.harness?.generationId} onValueChange={value => onHarness(setting.providerId, { kind: "setting", id: setting.id, value })} options={setting.options ?? []} /> : <input className="w-full rounded-[var(--radius-control)] border border-transparent bg-muted/40 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" defaultValue={String(setting.value)} disabled={busy || snapshot.session.status !== "ready" || !snapshot.harness?.generationId} onBlur={(event) => { if (event.target.value !== setting.value) onHarness(setting.providerId, { kind: "setting", id: setting.id, value: event.target.value }); }} />}</label>)}
        <Disclosure className="p-3 text-xs" summary={<> Extension details </>} triggerClassName="rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer text-muted-foreground"><p className="mt-2 text-muted-foreground">{snapshot.harness.status} · {snapshot.harness.trusted ? "Trusted" : "Sandboxed"}</p><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ providers: snapshot.harness.providers, commands: snapshot.harness.commands, settings: snapshot.harness.settings }, null, 2)}</pre></Disclosure>
      </> : <p className="text-xs text-muted-foreground">Not ready yet.</p>}
    </section>}
    <ToolCatalog tools={snapshot.tools} />
  </div>;
}

function HarnessBlock({ block, stagePrompt }: { block: HarnessViewBlock; stagePrompt: (text: string) => void }) {
  if (block.type === "markdown") return <Markdown text={block.text} />;
  if (block.type === "text") return <p className="whitespace-pre-wrap text-xs leading-5">{block.text}</p>;
  if (block.type === "progress") return <div className="text-xs"><div>{block.label} · {block.value} / {block.max}</div><progress className="mt-1 h-2 w-full accent-primary" max={block.max} value={block.value} /></div>;
  if (block.type === "action") return <Button variant="outline" size="sm" onClick={() => stagePrompt(block.prompt)}>{block.label}</Button>;
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{block.columns.map((column, index) => <th key={index} className="p-1">{column}</th>)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td className="border-t border-border p-1" key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
