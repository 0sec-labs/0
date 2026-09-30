import { FileText, Play, ShieldCheck } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowExecution } from "@0/shared";
import { cn } from "@/lib/utils";

const NODE_ICONS = { trigger: Play, audit: ShieldCheck, report: FileText };

export function WorkflowGraph({ definition, selectedId, onSelect, execution }: { definition: SecurityWorkflow; execution?: SecurityWorkflowExecution; selectedId: string | null; onSelect: (id: string) => void }) {
  const levels: Record<string, number> = {};
  definition.nodes.forEach(node => { levels[node.id] = 0; });
  // A bounded pass gives disconnected nodes a place without trusting graph shape.
  for (let pass = 0; pass < definition.nodes.length; pass++) {
    let changed = false;
    for (const edge of definition.edges) {
      if (levels[edge.source] === undefined || levels[edge.target] === undefined) continue;
      const next = Math.min(definition.nodes.length - 1, levels[edge.source]! + 1);
      if (next > levels[edge.target]!) { levels[edge.target] = next; changed = true; }
    }
    if (!changed) break;
  }
  const rows: Record<number, number> = {};
  const positions = Object.fromEntries(definition.nodes.map(node => {
    const column = levels[node.id] ?? 0;
    const row = rows[column] ?? 0;
    rows[column] = row + 1;
    return [node.id, { x: 24 + column * 252, y: 24 + row * 114 }];
  }));
  const width = Math.max(264, ...Object.values(positions).map(position => position.x + 240));
  const height = Math.max(132, ...Object.values(positions).map(position => position.y + 108));
  return <div className="overflow-x-auto rounded-2xl bg-muted/20 py-4" aria-label="Workflow steps">
    <div className="relative mx-auto" style={{ width, height }}>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0" width={width} height={height}>
        {definition.edges.map((edge, index) => {
          const source = positions[edge.source], target = positions[edge.target];
          if (!source || !target) return null;
          const x = source.x + 212, y = source.y + 38, targetY = target.y + 38;
          return <path key={`${edge.source}-${edge.target}-${index}`} d={`M ${x} ${y} C ${x + 20} ${y}, ${target.x - 20} ${targetY}, ${target.x} ${targetY}`} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground/35" />;
        })}
      </svg>
      {definition.nodes.map(node => {
        const Icon = NODE_ICONS[node.type], position = positions[node.id]!;
        const status = execution?.nodeResults[node.id]?.status;
        return <button type="button" key={node.id} aria-pressed={selectedId === node.id} aria-label={`${node.label}, ${node.type}, ${node.enabled ? "enabled" : "disabled"}`} onClick={() => onSelect(node.id)} style={{ left: position.x, top: position.y }} className={cn("absolute flex min-h-20 w-[212px] items-start gap-3 rounded-2xl bg-background px-4 py-3 text-left shadow-sm transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary", selectedId === node.id && "ring-1 ring-primary/50", !node.enabled && "opacity-50")}>
          <Icon aria-hidden="true" className={cn("mt-1 size-4 shrink-0", node.enabled ? "text-primary" : "text-muted-foreground")} />
          <span className="min-w-0"><span className="block truncate text-sm font-medium">{node.label}</span><span className="mt-1 block text-xs text-muted-foreground">{!node.enabled ? "Disabled" : node.type === "trigger" ? "Run manually" : node.type === "report" ? "Collect results" : "Security review"}{status && <span className="ml-2 text-foreground">· {status.replaceAll("_", " ")}</span>}</span></span>
        </button>;
      })}
    </div>
  </div>;
}
