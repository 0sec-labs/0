import { useState } from "react";
import { ChevronDown, Hand, Search, ShieldCheck, Zap } from "lucide-react";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import type { DesktopConsoleAutonomyMode } from "@0/shared";
import { configureConsoleSession } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConsoleWorkspace } from "./use-console-workspace";

const MODES = {
  standard: { label: "Standard", description: "Ask before each action", icon: ShieldCheck },
  recon: { label: "Recon", description: "Read-only exploration", icon: Search },
  copilot: { label: "Copilot", description: "Act within scope; ask before new targets", icon: Hand },
  yolo: { label: "YOLO", description: "Act without per-action prompts", icon: Zap },
} satisfies Record<DesktopConsoleAutonomyMode, { label: string; description: string; icon: typeof Zap }>;

export function ModePicker({ workspace, sessionId, mode, disabled }: { workspace: ConsoleWorkspace; sessionId: string; mode: DesktopConsoleAutonomyMode; disabled: boolean }) {
  const [pending, setPending] = useState<DesktopConsoleAutonomyMode | null>(null);
  const current = MODES[mode];
  const Icon = current.icon;
  const apply = (next: DesktopConsoleAutonomyMode) => void workspace.perform(async () => {
    await configureConsoleSession(sessionId, { autonomyMode: next });
    setPending(null);
  });
  return <>
    <DropdownMenu><DropdownMenu.Trigger aria-label={`Mode: ${current.label}`} title={`${current.label}: ${current.description}`} disabled={disabled} className="flex items-center gap-1 rounded-full px-2 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"><button type="button"><Icon className="size-3.5" /><span className="hidden sm:inline">{current.label}</span><ChevronDown className="hidden size-3 sm:block" /></button></DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="w-64 rounded-lg p-2 font-sans">
        {(Object.keys(MODES) as DesktopConsoleAutonomyMode[]).map(value => { const option = MODES[value]; const OptionIcon = option.icon; return <DropdownMenu.Item key={value} icon={<OptionIcon className="size-4" />} selected={mode === value} className="gap-3 rounded-xl px-3 py-2 text-sm focus-visible:ring-0 data-highlighted:bg-muted" onClick={() => { if (value === mode) return; if (value === "copilot" || value === "yolo") setPending(value); else apply(value); }}><span className="flex min-w-0 flex-1 flex-col gap-0.5"><span>{option.label}</span><span className="text-xs text-muted-foreground">{option.description}</span></span></DropdownMenu.Item>; })}
      </DropdownMenu.Content>
    </DropdownMenu>
    <Dialog open={pending !== null} onOpenChange={open => { if (!open) setPending(null); }}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Use {pending ? MODES[pending].label : "this mode"}?</DialogTitle><DialogDescription>{pending === "copilot" ? "0 will run actions within your scope without asking each time. It will still ask before adding new targets." : "0 will run actions without asking each time. Your configured exclusions and credential boundaries still apply."}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setPending(null)} disabled={workspace.busy}>Cancel</Button><Button onClick={() => { if (pending) apply(pending); }} disabled={workspace.busy}>Use {pending ? MODES[pending].label : "mode"}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
