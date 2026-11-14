import { Popover } from "@/ui/components/popover";
import { Button } from "@/components/ui/button";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { formatTokens } from "../format-tokens";
import { useDisplaySettings } from "@/lib/display-settings";
import { costBreakdown, formatCost, type CostRow } from "./views/overview-model";

const HUES = [255, 30, 150, 320, 75] as const;
const swatch = (index: number) => `oklch(.74 .12 ${HUES[index % HUES.length]})`;

function CostBar({ rows }: { rows: CostRow[] }) {
  const visible = rows.filter(row => row.share > 0);
  if (!visible.length) return <div aria-hidden="true" className="mx-2 mb-2 h-1.5 rounded-full bg-secondary" />;
  return <div role="img" aria-label="Cost share by thread" className="mx-2 mb-2 flex h-1.5 gap-px overflow-hidden rounded-full bg-secondary">
    {visible.map(row => <span key={row.id} title={`${row.label} ${formatCost(row.costUsd)}`} className="h-full min-w-0.5" style={{ flexGrow: row.share, flexBasis: 0, background: swatch(rows.indexOf(row)) }} />)}
  </div>;
}

/** Header cost button + popover. Renders nothing when the snapshot has no numeric cost. */
export function CostButton({ snapshot }: { snapshot: ConsoleSessionSnapshot | undefined }) {
  const { showCost, showTokenUsage } = useDisplaySettings();
  const breakdown = snapshot ? costBreakdown(snapshot) : undefined;
  if (!breakdown || !showCost) return null;
  const total = formatCost(breakdown.totalUsd)!;
  return <Popover>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />} aria-label={`Chat cost ${total}`} data-chat-cost className="h-7 px-2 text-xs tabular-nums text-muted-foreground">{total}</Popover.Trigger>
    <Popover.Content align="end" sideOffset={6} className="w-96 max-w-[calc(100vw-24px)] gap-0 p-1">
      <div className="flex items-start justify-between gap-3 px-2 pb-2 pt-1.5">
        <div className="min-w-0"><Popover.Title className="text-lg font-medium tabular-nums">{total}</Popover.Title><p className="text-xs text-muted-foreground-2">{breakdown.kind === "reported" ? "Reported" : "Estimated"}{breakdown.partial ? " · partial" : ""}</p></div>
        {showTokenUsage && <div className="text-right text-xs tabular-nums text-muted-foreground-2"><p>{formatTokens(breakdown.inputTokens)} in</p><p>{formatTokens(breakdown.outputTokens)} out</p></div>}
      </div>
      <CostBar rows={breakdown.rows} />
      <div className="border-t-[0.5px] border-border-1 pt-1">
        <p className="px-2 pb-0.5 pt-1 text-2xs text-muted-foreground-2">By thread</p>
        {breakdown.rows.map((row, index) => <div key={row.id} className="flex h-7 items-center gap-2 rounded-md px-2 text-sm">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: swatch(index) }} />
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="w-18 text-right tabular-nums">{formatCost(row.costUsd)}</span>
        </div>)}
        {breakdown.workersUnattributed > 0 && <p className="px-2 py-1 text-2xs text-muted-foreground-2">Breakdown unavailable for {breakdown.workersUnattributed} {breakdown.workersUnattributed === 1 ? "agent" : "agents"}; their cost is included in This chat.</p>}
      </div>
      <div className="border-t-[0.5px] border-border-1 pt-1">
        <p className="px-2 pb-0.5 pt-1 text-2xs text-muted-foreground-2">Models</p>
        {breakdown.models.length ? breakdown.models.map(model => <div key={model} className="flex h-7 items-center px-2 text-sm"><span className="min-w-0 flex-1 truncate">{model}</span></div>) : null}
        <p className="px-2 py-1 text-2xs text-muted-foreground-2">Breakdown unavailable: the engine reports one total, not cost per model.</p>
      </div>
    </Popover.Content>
  </Popover>;
}
