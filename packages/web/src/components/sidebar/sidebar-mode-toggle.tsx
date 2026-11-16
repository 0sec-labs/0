import { CapyAutomationsIcon, CapyThreadListIcon } from "@/ui/icons/capy";
import type { SidebarListMode } from "@/lib/sidebar-rows";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSidebarListMode } from "./use-sidebar-list";

const OPTIONS = [
  { value: "agents", label: "Agents", Icon: CapyAutomationsIcon },
  { value: "threads", label: "Threads", Icon: CapyThreadListIcon },
] as const;

/** Icon-only 60x30 segmented switch (Agents | Threads) that lives on the list header. Hidden when the server has no Agents. */
export function SidebarModeToggle() {
  const { mode, setMode, supported } = useSidebarListMode();
  if (!supported) return null;
  return <div role="group" aria-label="Sidebar list" className="mr-1 flex h-7.5 w-15 shrink-0 items-center gap-0.5 rounded-md bg-secondary p-0.5">
    {OPTIONS.map(({ value, label, Icon }) => <Tooltip key={value} content={label} side="bottom">
      <button type="button" aria-label={label} aria-pressed={mode === value} onClick={() => setMode(value as SidebarListMode)}
        className={cn("flex h-6.5 w-6.5 items-center justify-center rounded-sm text-muted-foreground-1 outline-none transition-colors duration-100 hover:text-foreground focus-visible:outline-ring-inset aria-pressed:bg-background aria-pressed:text-foreground [&_svg]:size-3.5", )}><Icon aria-hidden="true" /></button>
    </Tooltip>)}
  </div>;
}
