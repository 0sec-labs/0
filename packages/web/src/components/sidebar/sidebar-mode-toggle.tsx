import { Bot, List } from "lucide-react";
import type { SidebarListMode } from "@/lib/sidebar-rows";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useSidebarListMode } from "./use-sidebar-list";

const OPTIONS = [
  { value: "agents", label: "Agents", Icon: Bot },
  { value: "threads", label: "Threads", Icon: List },
] as const;

/** Agents | Threads as two header icon buttons, same size and weight as search, "+" and "...". Only the active one has a background; there is no outer box. Hidden when the server has no Agents. */
export function SidebarModeToggle() {
  const { mode, setMode, supported } = useSidebarListMode();
  if (!supported) return null;
  return <div role="group" aria-label="Sidebar list" className="flex shrink-0 items-center gap-1">
    {OPTIONS.map(({ value, label, Icon }) => <Tooltip key={value} content={label} side="bottom">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-pressed={mode === value} onClick={() => setMode(value as SidebarListMode)}
        className="text-muted-foreground-1 aria-pressed:bg-foreground/8 aria-pressed:text-foreground"><Icon /></Button>
    </Tooltip>)}
  </div>;
}
