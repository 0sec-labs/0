import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import type { ConsoleRuntimeSnapshot } from "@0/engine/shared";
import { configureChatRuntime } from "./model-source";
import { useBackendApi } from "@/api";
import { Tooltip } from "@/components/ui/tooltip";
import { Slider } from "@/components/ui/slider";
import type { ConsoleWorkspace } from "./use-console-workspace";

export const REASONING_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high",
  max: "Maximum",
};

/** A discrete effort slider, populated solely by the live engine capabilities. */
export function ReasoningPicker({
  workspace,
  sessionId,
  reasoning,
  disabled,
  inline = false,
}: {
  workspace: ConsoleWorkspace;
  sessionId: string;
  reasoning: ConsoleRuntimeSnapshot["reasoning"];
  disabled: boolean;
  inline?: boolean;
}) {
  const api = useBackendApi();
  const [draft, setDraft] = useState(reasoning?.effort ?? "medium");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setDraft(reasoning?.effort ?? "medium");
  }, [reasoning?.effort, sessionId]);
  if (!reasoning || reasoning.options.length < 2) return null;
  const index = Math.max(0, reasoning.options.indexOf(draft));
  const apply = (nextIndex: number) => {
    const effort = reasoning.options[nextIndex];
    if (!effort || effort === reasoning.effort || disabled || workspace.busy) return;
    void workspace.perform(async () => {
      try {
        await configureChatRuntime(api, sessionId, { reasoningEffort: effort }, workspace.snapshot?.runtime);
      } catch (error) {
        setDraft(reasoning.effort);
        throw error;
      }
    }, sessionId);
  };
  const control = (
    <div
      className="space-y-1"
      onKeyDown={(event) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(event.key))
          event.stopPropagation();
      }}
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Thinking effort</span>
        <span>{REASONING_LABELS[draft] ?? draft}</span>
      </div>
      <Slider
        min={0}
        max={reasoning.options.length - 1}
        step={1}
        value={index}
        label="Thinking effort"
        valueText={(value) => REASONING_LABELS[reasoning.options[value]!] ?? reasoning.options[value]!}
        disabled={disabled || workspace.busy}
        onValueChange={(value) => setDraft(reasoning.options[value] ?? reasoning.effort)}
        onValueCommitted={apply}
      />
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{REASONING_LABELS[reasoning.options[0]!] ?? reasoning.options[0]}</span>
        <span>{REASONING_LABELS[reasoning.options.at(-1)!] ?? reasoning.options.at(-1)}</span>
      </div>
    </div>
  );
  if (inline)
    return (
      <section aria-label="Model thinking effort" className="shrink-0 border-b border-border px-3 pb-3 pt-2">
        {control}
      </section>
    );
  return (
    <DropdownMenu>
      <Tooltip content="Thinking effort" side="bottom">
        <DropdownMenu.Trigger
          disabled={disabled}
          aria-label={`Thinking effort: ${REASONING_LABELS[reasoning.effort] ?? reasoning.effort}`}
          className="inline-flex h-7 items-center gap-1 rounded-md border-[0.5px] border-transparent px-2 text-xs font-medium text-muted-foreground-1 outline-none transition-colors duration-100 hover:bg-secondary hover:text-foreground focus-visible:outline-ring-inset data-[popup-open]:bg-secondary data-[popup-open]:text-foreground disabled:opacity-55"
        >
          <span>{REASONING_LABELS[reasoning.effort] ?? reasoning.effort}</span>
          <ChevronDown className="size-3.5 text-muted-foreground-3" strokeWidth={1.5} />
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Content
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={12}
        className="max-w-[calc(100vw-24px)] max-h-[min(28rem,calc(100dvh-2rem))] overscroll-contain w-52 font-sans"
      >
        <DropdownMenu.Group>
          <DropdownMenu.Label className="mt-0 flex min-h-[22px] items-center px-2 py-0 text-xs font-medium text-muted-foreground-2">
            Reasoning
          </DropdownMenu.Label>
          {reasoning.options.map((option, optionIndex) => (
            <DropdownMenu.Item
              key={option}
              disabled={disabled || workspace.busy}
              selected={option === reasoning.effort}
              className="text-[13px] font-[450] tracking-[-0.01em]"
              onClick={() => {
                setDraft(option);
                apply(optionIndex);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{REASONING_LABELS[option] ?? option}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
