import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover } from "@cloudflare/kumo/components/popover";
import type { ConsoleRuntimeSnapshot } from "@0/shared";
import { configureConsoleSession } from "@/api";
import { Button } from "@/components/ui/button";
import type { ConsoleWorkspace } from "./use-console-workspace";

const LABELS: Record<string, string> = { none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Maximum" };

/** A discrete effort slider, populated solely by the live engine capabilities. */
export function ReasoningPicker({ workspace, sessionId, reasoning, disabled }: {
  workspace: ConsoleWorkspace;
  sessionId: string;
  reasoning: ConsoleRuntimeSnapshot["reasoning"];
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(reasoning?.effort ?? "medium");
  const [open, setOpen] = useState(false);
  useEffect(() => { setDraft(reasoning?.effort ?? "medium"); }, [reasoning?.effort, sessionId]);
  if (!reasoning || reasoning.options.length < 2) return null;
  const index = Math.max(0, reasoning.options.indexOf(draft));
  const apply = () => {
    if (draft === reasoning.effort || disabled || workspace.busy) return;
    void workspace.perform(async () => {
      try { await configureConsoleSession(sessionId, { runtime: { reasoningEffort: draft } }); }
      catch (error) { setDraft(reasoning.effort); throw error; }
    }, sessionId);
  };
  return <Popover open={open} onOpenChange={setOpen}>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />} disabled={disabled}
      aria-label={`Thinking effort: ${LABELS[reasoning.effort] ?? reasoning.effort}`}
      className="gap-1 rounded-full px-2 text-xs text-muted-foreground">
      <span>{LABELS[reasoning.effort] ?? reasoning.effort}</span><ChevronDown className="size-3" />
    </Popover.Trigger>
    <Popover.Content side="top" align="end" sideOffset={10} positionMethod="fixed" className="w-64 rounded-2xl p-4 font-sans">
      <Popover.Title className="text-sm font-medium">Thinking effort</Popover.Title>
      <div className="mt-3 text-sm">{LABELS[draft] ?? draft}</div>
      <input type="range" min={0} max={reasoning.options.length - 1} step={1} value={index}
        aria-label="Thinking effort" aria-valuetext={`${LABELS[draft] ?? draft}, ${index + 1} of ${reasoning.options.length}`}
        disabled={disabled || workspace.busy}
        className="mt-3 h-5 w-full cursor-pointer accent-primary disabled:cursor-default"
        onChange={event => setDraft(reasoning.options[Number(event.target.value)] ?? reasoning.effort)}
        onPointerUp={apply} onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) apply(); }} onBlur={apply} />
      <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{LABELS[reasoning.options[0]!] ?? reasoning.options[0]}</span><span>{LABELS[reasoning.options.at(-1)!] ?? reasoning.options.at(-1)}</span></div>
      <Popover.Description className="mt-3 text-xs leading-5 text-muted-foreground">More thinking can improve difficult answers and uses more time and tokens.</Popover.Description>
    </Popover.Content>
  </Popover>;
}
