import { ChoiceCard } from "@/components/ui/choice-card";
import { ArrowDown, BadgeCheck, FileSearch, FileText, Play, Search, ShieldCheck, Wrench, Pencil } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowExecution, SecurityWorkflowNode } from "@0/shared";
import { workflowOperationLabel } from "./workflow-labels";
import { cn } from "@/lib/utils";

const NODE_ICONS = { trigger: Play, audit: ShieldCheck, verify: BadgeCheck, fix: Wrench, research: Search, "deep-review": FileSearch, report: FileText };

/** Stable dependency order, including disconnected nodes and malformed-cycle fallbacks. */
export function workflowSequence(definition: Pick<SecurityWorkflow, "nodes" | "edges">): SecurityWorkflow["nodes"] {
  const remaining = new Map(definition.nodes.map(node => [node.id, node]));
  const incoming = new Map(definition.nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of definition.edges) if (remaining.has(edge.source) && remaining.has(edge.target)) incoming.get(edge.target)!.add(edge.source);
  const ordered: SecurityWorkflow["nodes"] = [];
  while (remaining.size) {
    const next = [...remaining.values()].find(node => incoming.get(node.id)!.size === 0);
    // Preserve every authored node when a saved definition contains a cycle.
    if (!next) { ordered.push(...remaining.values()); break; }
    ordered.push(next); remaining.delete(next.id);
    for (const parents of incoming.values()) parents.delete(next.id);
  }
  return ordered;
}

/** Only saved step fields are summarized; schedules live outside the definition. */
export function workflowStepDetails(node: SecurityWorkflowNode): string[] {
  if (node.type === "trigger") return ["Starts manually; schedules are managed in Triggers."];
  if (node.type === "report") return ["Collects results from the preceding steps."];
  const details: string[] = [];
  if (node.plan) {
    details.push(`${node.plan.goal.replaceAll("-", " ")} · ${node.plan.depth} · ${node.plan.runCount} ${node.plan.executionMode} run${node.plan.runCount === 1 ? "" : "s"}`);
    const duration = node.plan.timeCapMs % 60000 === 0 ? `${node.plan.timeCapMs / 60000} min` : `${node.plan.timeCapMs / 1000} sec`;
    details.push(`Limits: ${duration} · $${node.plan.costCapUsd}`);
  } else details.push("Limits: workflow defaults");
  const tools = node.execution?.allowedAgentTools;
  details.push(tools === undefined ? "Tools: default set" : tools.length ? `Tools: ${tools.join(", ")}` : "Tools: no agent tool calls");
  if (node.type === "fix") details.push(node.fix?.mode === "apply" ? "Apply changes; separate permission is required." : "Prepare a fix candidate only.");
  if (node.input?.fromStep) details.push(`Input: step ${node.input.fromStep}`);
  if (node.input?.findingId) details.push(`Finding: ${node.input.findingId}`);
  if (node.input?.scanId) details.push(`Run: ${node.input.scanId}`);
  if (node.inputs && Object.keys(node.inputs).length) details.push(`Input bindings: ${Object.keys(node.inputs).join(", ")}`);
  return details;
}

export function WorkflowGraph({ definition, selectedId, onSelect, execution }: { definition: SecurityWorkflow; execution?: SecurityWorkflowExecution; selectedId: string | null; onSelect: (id: string) => void }) {
  const nodes = workflowSequence(definition);
  const labels = new Map(nodes.map(node => [node.id, node.label]));
  return <div className="rounded-[var(--radius-panel)] bg-background/50 px-4 py-6 sm:px-6 sm:py-8" aria-label="Workflow steps">
    <ol className="mx-auto w-full max-w-sm">
      {nodes.map((node, index) => {
        const Icon = NODE_ICONS[node.type as keyof typeof NODE_ICONS] ?? ShieldCheck;
        const status = execution?.nodeResults[node.id]?.status;
        const previous = nodes[index - 1];
        const parents = [...new Set(definition.edges.filter(edge => edge.target === node.id && labels.has(edge.source)).map(edge => edge.source))];
        const direct = previous && parents.length === 1 && parents[0] === previous.id;
        return <li key={node.id}>
          {index > 0 && <div aria-hidden="true" className="flex h-5 items-center justify-center">{direct && <span className="flex h-full flex-col items-center"><span className="min-h-0 flex-1 border-l border-border" /><ArrowDown className="size-4 shrink-0 text-muted-foreground" /></span>}</div>}
          <ChoiceCard selected={selectedId === node.id} aria-label={`Step ${index + 1}: ${node.label}, ${workflowOperationLabel(node, definition)}, ${node.enabled ? "enabled" : "disabled"}`} onClick={() => onSelect(node.id)} className={cn("group min-h-16 w-full items-center gap-3 p-3.5 pr-10 shadow-sm", selectedId !== node.id && "bg-muted/70")}>
            <Icon aria-hidden="true" className="size-4 shrink-0 text-foreground/80" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium leading-5">{node.label}</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{workflowOperationLabel(node, definition)}{!node.enabled && " · Paused"}{status && ` · ${status.replaceAll("_", " ")}`}</span>
              {parents.length > 0 && !direct && <span className="mt-2 block break-words text-xs leading-5 text-muted-foreground">After: {parents.map(id => labels.get(id)).join(", ")}</span>}
            </span>
            {selectedId !== node.id && <Pencil aria-hidden="true" className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
          </ChoiceCard>
        </li>;
      })}
    </ol>
    {nodes.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No workflow steps yet.</p>}
  </div>;
}
