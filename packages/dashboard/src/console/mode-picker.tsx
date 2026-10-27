import { ChevronDown, Hand, Search, ShieldCheck, Zap } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import type { DesktopConsoleAutonomyMode } from "@0/shared";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { ConsoleWorkspace } from "./use-console-workspace";

const MODES = {
  standard: { label: "Standard", description: "Ask before each action", icon: ShieldCheck },
  recon: { label: "Recon", description: "Read-only exploration", icon: Search },
  copilot: { label: "Auto", description: "Run tools; pause for decisions that need you", icon: Hand },
  yolo: { label: "YOLO", description: "Act without per-action prompts", icon: Zap },
} satisfies Record<DesktopConsoleAutonomyMode, { label: string; description: string; icon: typeof Zap }>;

export function ModePicker({ workspace, sessionId, mode, disabled, deferred = false }: { workspace: ConsoleWorkspace; sessionId: string; mode: DesktopConsoleAutonomyMode; disabled: boolean; deferred?: boolean }) {
  const { configureConsoleSession } = useBackendApi();
  const current = MODES[mode];
  const Icon = current.icon;
  const apply = (next: DesktopConsoleAutonomyMode) => void workspace.perform(async () => {
    await configureConsoleSession(sessionId, { autonomyMode: next });
  });
  return <>
    <DropdownMenu><Tooltip content="Autonomy mode" side="top"><DropdownMenu.Trigger aria-label={`Mode: ${current.label}`} disabled={disabled} className="text-xs text-muted-foreground"><Button type="button" variant="ghost" size="sm" className="gap-1 px-2 text-xs"><Icon className="size-4" /><span className="hidden sm:inline">{current.label}</span><ChevronDown className="hidden size-3 sm:block" /></Button></DropdownMenu.Trigger></Tooltip>
      <DropdownMenu.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="ui-menu-surface w-80 font-sans">
        {(["standard", "recon", "copilot", "yolo"] as const).map(value => { const option = MODES[value]; const OptionIcon = option.icon; return <Tooltip key={value} content={option.description} side="right"><DropdownMenu.Item icon={<OptionIcon className="size-4" />} selected={mode === value} className="ui-menu-item ui-menu-item--detail focus-visible:ring-0 data-highlighted:bg-muted" onClick={() => { if (value !== mode) apply(value); }}><span className="flex min-w-0 flex-1 flex-col"><span>{option.label}</span><span className="ui-menu-secondary truncate">{option.description}</span></span></DropdownMenu.Item></Tooltip>; })}
        <p className="ui-menu-section">{deferred ? "Changes apply after the current VM turn." : "Changes apply to upcoming tools. Pending approvals still need your response."}</p>
      </DropdownMenu.Content>
    </DropdownMenu>
  </>;
}
