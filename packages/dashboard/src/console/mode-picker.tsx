import { ChevronDown, Hand, Search, ShieldCheck, Zap } from "lucide-react";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import type { DesktopConsoleAutonomyMode } from "@0/shared";
import { useBackendApi } from "@/api";
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
    <DropdownMenu><Tooltip content="Autonomy mode" side="top"><DropdownMenu.Trigger aria-label={`Mode: ${current.label}`} disabled={disabled} className="flex items-center gap-1 rounded-full px-2 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"><button type="button"><Icon className={`size-3.5 ${mode === "yolo" ? "fill-primary text-primary" : ""}`} /><span className="hidden sm:inline">{current.label}</span><ChevronDown className="hidden size-3 sm:block" /></button></DropdownMenu.Trigger></Tooltip>
      <DropdownMenu.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="w-64 rounded-lg p-2 font-sans">
        {(["standard", "recon", "copilot", "yolo"] as const).map(value => { const option = MODES[value]; const OptionIcon = option.icon; return <DropdownMenu.Item key={value} icon={<OptionIcon className={`size-4 ${value === "yolo" ? "fill-primary text-primary" : ""}`} />} selected={mode === value} className="gap-3 rounded-xl px-3 py-2 text-sm focus-visible:ring-0 data-highlighted:bg-muted" onClick={() => { if (value !== mode) apply(value); }}><span className="flex min-w-0 flex-1 flex-col gap-0.5"><span>{option.label}</span><span className="text-xs text-muted-foreground">{option.description}</span></span></DropdownMenu.Item>; })}
        <p className="px-3 pt-2 text-xs leading-5 text-muted-foreground">{deferred ? "Changes apply after the current VM turn." : "Changes apply to upcoming tools. Pending approvals still need your response."}</p>
      </DropdownMenu.Content>
    </DropdownMenu>
  </>;
}
