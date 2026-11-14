import { Hand, Search, ShieldCheck, SlidersHorizontal, Zap } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import type { DesktopConsoleAutonomyMode } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { ConsoleWorkspace } from "./use-console-workspace";
import { SELECTABLE_AUTONOMY_MODES } from "./autonomy-options";

const MODES = {
  standard: { label: "Standard", description: "Ask before each action", icon: ShieldCheck },
  recon: { label: "Recon", description: "Read-only exploration", icon: Search },
  copilot: { label: "Auto", description: "Run tools; pause for decisions that need you", icon: Hand },
  yolo: { label: "YOLO", description: "Act without per-action prompts", icon: Zap },
} satisfies Record<DesktopConsoleAutonomyMode, { label: string; description: string; icon: typeof Zap }>;

export function ModePicker({
  workspace,
  sessionId,
  mode,
  disabled,
}: {
  workspace: ConsoleWorkspace;
  sessionId: string;
  mode: DesktopConsoleAutonomyMode;
  disabled: boolean;
}) {
  const { configureConsoleSession } = useBackendApi();
  const current = MODES[mode];
  const apply = (next: DesktopConsoleAutonomyMode) =>
    void workspace.perform(async () => {
      await configureConsoleSession(sessionId, { autonomyMode: next });
    });
  return (
    <>
      <DropdownMenu>
        <Tooltip content={`Options: ${current.label}`} side="top">
          <DropdownMenu.Trigger
            aria-label={`Mode: ${current.label}`}
            disabled={disabled}
            className="text-xs text-muted-foreground"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-8 px-0 text-icon-muted hover:text-foreground"
            >
              <SlidersHorizontal className="size-4" strokeWidth={1.5} />
            </Button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          className="max-w-[calc(100vw-24px)] max-h-[min(28rem,calc(100dvh-2rem))] overscroll-contain w-56 font-sans"
        >
          {SELECTABLE_AUTONOMY_MODES.map(({ value }) => {
            const option = MODES[value];
            const OptionIcon = option.icon;
            return (
              <Tooltip key={value} content={option.description} side="right">
                <DropdownMenu.Item
                  disabled={disabled}
                  icon={<OptionIcon className="size-3.5 text-icon-muted" strokeWidth={1.5} />}
                  selected={mode === value}
                  className="text-[13px] font-[450] tracking-[-0.01em]"
                  onClick={() => {
                    if (!disabled && value !== mode) apply(value);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </DropdownMenu.Item>
              </Tooltip>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu>
    </>
  );
}
