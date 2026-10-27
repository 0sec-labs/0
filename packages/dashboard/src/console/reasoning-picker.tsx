import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover } from "@cloudflare/kumo/components/popover";
import type { ConsoleRuntimeSnapshot } from "@0/shared";
import { configureChatRuntime } from "./model-source";
import { useBackendApi } from "@/api";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { ConsoleWorkspace } from "./use-console-workspace";

export const REASONING_LABELS: Record<string, string> = { none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Maximum" };

/** A discrete effort slider, populated solely by the live engine capabilities. */
export function ReasoningPicker({ workspace, sessionId, reasoning, disabled, inline = false }: {
  workspace: ConsoleWorkspace;
  sessionId: string;
  reasoning: ConsoleRuntimeSnapshot["reasoning"];
  disabled: boolean;
  inline?: boolean;
}) {
  const api = useBackendApi();
  const [draft, setDraft] = useState(reasoning?.effort ?? "medium");
  const [open, setOpen] = useState(false);
  useEffect(() => { setDraft(reasoning?.effort ?? "medium"); }, [reasoning?.effort, sessionId]);
  if (!reasoning || reasoning.options.length < 2) return null;
  const index = Math.max(0, reasoning.options.indexOf(draft));
  const apply = (nextIndex: number) => {
    const effort = reasoning.options[nextIndex];
    if (!effort || effort === reasoning.effort || disabled || workspace.busy) return;
    void workspace.perform(async () => {
      try { await configureChatRuntime(api,sessionId,{reasoningEffort:effort},workspace.snapshot?.runtime); }
      catch (error) { setDraft(reasoning.effort); throw error; }
    }, sessionId);
  };
  const control = <div className="space-y-1" onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(event.key)) event.stopPropagation(); }}>
    <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Thinking effort</span><span>{REASONING_LABELS[draft] ?? draft}</span></div>
    <Slider min={0} max={reasoning.options.length - 1} step={1} value={index} label="Thinking effort" valueText={value => REASONING_LABELS[reasoning.options[value]!] ?? reasoning.options[value]!} disabled={disabled || workspace.busy} onValueChange={value => setDraft(reasoning.options[value] ?? reasoning.effort)} onValueCommitted={apply} />
    <div className="flex justify-between text-[11px] text-muted-foreground"><span>{REASONING_LABELS[reasoning.options[0]!] ?? reasoning.options[0]}</span><span>{REASONING_LABELS[reasoning.options.at(-1)!] ?? reasoning.options.at(-1)}</span></div>
  </div>;
  if (inline) return <section aria-label="Model thinking effort" className="shrink-0 border-b border-border px-3 pb-3 pt-2">{control}</section>;
  return <Popover open={open} onOpenChange={setOpen}>
    <Tooltip content="Thinking effort" side="bottom"><Popover.Trigger render={<Button variant="ghost" size="sm" />} disabled={disabled}
      aria-label={`Thinking effort: ${REASONING_LABELS[reasoning.effort] ?? reasoning.effort}`}
      className="gap-1 rounded-[var(--radius-control)] px-2 text-xs text-muted-foreground">
      <span>{REASONING_LABELS[reasoning.effort] ?? reasoning.effort}</span><ChevronDown className="size-3" />
    </Popover.Trigger></Tooltip>
    <Popover.Content side="top" align="end" sideOffset={10} positionMethod="fixed" className="ui-menu-surface ui-menu-form w-64 font-sans">
      <Popover.Title className="flex items-baseline justify-between gap-3 text-sm font-medium">Thinking effort<span className="ui-menu-secondary">{REASONING_LABELS[draft] ?? draft}</span></Popover.Title>
      <Slider min={0} max={reasoning.options.length - 1} step={1} value={index}
        label="Thinking effort" valueText={value => `${REASONING_LABELS[reasoning.options[value]!] ?? reasoning.options[value]}, ${value + 1} of ${reasoning.options.length}`}
        disabled={disabled || workspace.busy} className="mt-3"
        onValueChange={value => setDraft(reasoning.options[value] ?? reasoning.effort)}
        onValueCommitted={apply} />
      <div className="ui-menu-secondary mt-1 flex justify-between"><span>{REASONING_LABELS[reasoning.options[0]!] ?? reasoning.options[0]}</span><span>{REASONING_LABELS[reasoning.options.at(-1)!] ?? reasoning.options.at(-1)}</span></div>
      <Popover.Description className="ui-menu-secondary mt-3">More thinking uses more time and tokens.</Popover.Description>
    </Popover.Content>
  </Popover>;
}
