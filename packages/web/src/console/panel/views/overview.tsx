import { useState, type ReactNode } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { CapySubagentsIcon as Bot, CapyChevronDownIcon as ChevronDown, CapyChevronRightIcon as ChevronRight } from "@/ui/icons/capy";
import { ContextRing } from "@/components/ui/context-ring";
import { TaskProgressList } from "../../task-progress";
import { executionLabel } from "../../execution-status";
import { formatTokens } from "../../format-tokens";
import { agentViewId, findingViewId, type PanelViewComponent } from "../types";
import { formatCost, contextUsage, newestFindings, planSummary, scopeSummary, severityCounts, SEVERITIES, statusSummary, workerCounts, workerCountsLine, type StatusTone } from "./overview-model";
import { useOverviewFindings } from "./overview-findings";

const toneDot: Record<StatusTone, string> = { active: "bg-emerald-500 animate-pulse motion-reduce:animate-none", attention: "bg-amber-500", ok: "bg-emerald-500", danger: "bg-destructive", muted: "bg-muted-foreground-2" };
const severityDot: Record<string, string> = { critical: "bg-red-500", high: "bg-orange-500", medium: "bg-amber-500", low: "bg-sky-500", info: "bg-muted-foreground-2" };

function Group({ title, count, children, defaultOpen = true }: { title: string; count?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section aria-label={title} className="space-y-0.5">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-7 w-full items-center gap-1.5 rounded-lg bg-card px-2 text-left text-xs font-medium hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-ring">
      {open ? <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground-2" /> : <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground-2" />}
      <span>{title}</span>{count !== undefined && <span className="tabular-nums text-muted-foreground-2">{count}</span>}
    </button>
    {open && <div className="px-1 pt-0.5">{children}</div>}
  </section>;
}

function Row({ onClick, children, label }: { onClick: () => void; children: ReactNode; label?: string }) {
  return <button type="button" aria-label={label} onClick={onClick} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-ring">{children}</button>;
}
const Pill = ({ children, title }: { children: ReactNode; title?: string }) => <span title={title} className="inline-flex h-5 items-center rounded-full border-[0.5px] border-border-1 px-2 text-2xs tabular-nums text-muted-foreground">{children}</span>;

/** Approvals stay inline in the transcript; bring the waiting one into view and focus its first control. */
export function jumpToDecision(sessionId: string, title: string) {
  const root = document.querySelector(`[data-console-session="${CSS.escape(sessionId)}"]`);
  const card = Array.from(root?.querySelectorAll<HTMLElement>("section[aria-label]") ?? []).find(element => element.getAttribute("aria-label") === title);
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  card.querySelector<HTMLElement>("button, textarea, input")?.focus({ preventScroll: true });
}

export const OverviewView: PanelViewComponent = ({ snapshot, sessionId, openView }) => {
  const { groups, loading } = useOverviewFindings(sessionId ?? snapshot?.session.id, snapshot?.session.savedId);
  if (!snapshot) return <p role="status" className="p-4 text-center text-xs text-muted-foreground-2">Loading chat…</p>;
  const status = statusSummary(snapshot);
  const context = contextUsage(snapshot);
  const scope = scopeSummary(snapshot);
  const plan = planSummary(snapshot);
  const counts = severityCounts(groups);
  const newest = newestFindings(groups);
  const workers = workerCounts(snapshot.workers);
  const cost = formatCost(snapshot.usage.costUsd);
  const cancellation = snapshot.session.cancellation;
  const totalTokens = snapshot.usage.inputTokens + snapshot.usage.outputTokens;
  const fact = (label: string, value: ReactNode) => value ? <div key={label} className="flex h-7 items-center justify-between gap-3 px-2 text-xs"><dt className="text-muted-foreground-2">{label}</dt><dd className="min-w-0 truncate text-right tabular-nums" >{value}</dd></div> : null;
  return <div className="scroll-fade-y min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2">
    <div className="rounded-lg border-[0.5px] border-border-1 bg-card p-3" aria-label="Run status">
      <div className="flex items-center gap-2 text-sm font-medium"><span aria-hidden="true" className={`size-2 rounded-full ${toneDot[status.tone]}`} />{status.label}{snapshot.session.autonomyMode && <Pill title="Autonomy mode">{snapshot.session.autonomyMode}</Pill>}</div>
      {status.detail && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{status.detail}</p>}
      <p className="mt-1 truncate text-2xs text-muted-foreground-2">{[snapshot.execution && executionLabel(snapshot.execution), snapshot.runtime?.model].filter(Boolean).join(" · ")}</p>
      <div className="mt-2 flex items-center gap-3 text-2xs text-muted-foreground">
        {cost && <span className="tabular-nums">{cost} {snapshot.usage.costKind === "reported" ? "reported" : "estimated"}{snapshot.usage.costUnavailable ? " · partial" : ""}</span>}
        <span className="flex items-center gap-1 tabular-nums"><ContextRing className="size-3.5" percent={context.percent} />{context.percent !== undefined ? `${context.percent}%` : "—"} context{context.used !== undefined && ` (${formatTokens(context.used)}${context.window ? ` / ${formatTokens(context.window)}` : ""})`}</span>
      </div>
      {cancellation && <p role="status" className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"><TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span>{cancellation.message}</span></p>}
    </div>

    <Group title="Target and scope">
      {scope.target ? <p className="break-all px-2 py-1 font-mono text-xs">{scope.target}</p> : <p className="px-2 py-1 text-xs text-muted-foreground-2">No target set.</p>}
      <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1">
        <Pill>{scope.inCount} in scope</Pill><Pill>{scope.outCount} out of scope</Pill>
        <Pill title={scope.enforcementMessage}><ShieldCheck aria-hidden="true" className="mr-1 size-3" />{scope.enforcement === "enforced" ? "Enforced" : "Not enforced"}</Pill>
      </div>
    </Group>

    {snapshot.pendingDecisions.length > 0 && <Group title="Needs your decision" count={snapshot.pendingDecisions.length}>
      {snapshot.pendingDecisions.map(decision => <Row key={decision.id} onClick={() => jumpToDecision(snapshot.session.id, decision.title)}>
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-500" /><span className="min-w-0 flex-1 truncate">{decision.title}</span>
        {decision.risk?.level === "destructive" && <Pill>destructive</Pill>}
      </Row>)}
    </Group>}

    <Group title="Findings" count={groups.length || undefined}>
      {groups.length ? <>
        <div className="flex flex-wrap gap-1.5 px-2 pb-1">{SEVERITIES.filter(severity => counts[severity]).map(severity => <button key={severity} type="button" onClick={() => openView("findings")} className="inline-flex h-5 items-center gap-1 rounded-full border-[0.5px] border-border-1 px-2 text-2xs capitalize tabular-nums hover:bg-secondary/60"><span aria-hidden="true" className={`size-1.5 rounded-full ${severityDot[severity]}`} />{counts[severity]} {severity}</button>)}</div>
        {newest.map(({ fingerprint, latest }) => <Row key={fingerprint} onClick={() => openView(findingViewId(fingerprint), { title: latest.title })}><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${severityDot[latest.severity.toLowerCase()] ?? severityDot.info}`} /><span className="min-w-0 flex-1 truncate">{latest.title}</span></Row>)}
        <Row onClick={() => openView("findings")}><span className="flex-1 text-muted-foreground">View all</span><ChevronRight aria-hidden="true" className="size-3 text-muted-foreground-2" /></Row>
      </> : <p className="px-2 py-3 text-center text-xs text-muted-foreground-2">{loading ? "Loading findings…" : "No findings yet. The agent will list them here as it confirms them."}</p>}
    </Group>

    {(plan || snapshot.objective) && <Group title="Plan" count={plan ? `${plan.done}/${plan.total}` : undefined}>
      {snapshot.objective && <p className="line-clamp-3 whitespace-pre-wrap px-2 pb-1 text-xs text-muted-foreground" title={snapshot.objective}>{snapshot.objective}</p>}
      {plan?.stale && <p className="px-2 pb-1 text-2xs text-muted-foreground-2">This chat is not running. The checklist has items not marked complete.</p>}
      {snapshot.todos && plan && <TaskProgressList todos={snapshot.todos} active={plan.active} />}
    </Group>}

    {workers.total > 0 && <Group title="Agents" count={workers.total}>
      <div className="flex h-1.5 gap-px overflow-hidden rounded-full px-2" role="img" aria-label={workerCountsLine(workers)}>
        {snapshot.workers.map(worker => <span key={worker.id} className={`h-full min-w-0 flex-1 ${worker.status === "completed" ? "bg-emerald-500/70" : worker.status === "running" ? "bg-foreground/60" : worker.status === "failed" ? "bg-destructive/70" : "bg-foreground/15"}`} />)}
      </div>
      <p className="px-2 py-1 text-2xs text-muted-foreground-2">{workerCountsLine(workers)}</p>
      {snapshot.workers.slice(0, 5).map(worker => <Row key={worker.id} onClick={() => openView(agentViewId(worker.id), { title: worker.name })}><Bot aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-2" /><span className="shrink-0 text-muted-foreground">{worker.name}</span><span className="min-w-0 flex-1 truncate text-xs">{worker.task}</span></Row>)}
      {workers.total > 5 && <Row onClick={() => openView("agents")}><span className="flex-1 text-muted-foreground">Show all {workers.total}</span></Row>}
    </Group>}

    <Group title="Quick facts" defaultOpen={false}>
      <dl>
        {fact("Role", snapshot.session.role)}
        {fact("Tokens", totalTokens ? `${formatTokens(snapshot.usage.inputTokens)} in · ${formatTokens(snapshot.usage.outputTokens)} out` : undefined)}
        {fact("Execution", snapshot.execution && executionLabel(snapshot.execution))}
        {fact("Queued messages", snapshot.queuedMessages.length || undefined)}
        {fact("Tools available", snapshot.tools.length || undefined)}
      </dl>
    </Group>
  </div>;
};
