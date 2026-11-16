import { v } from "@/lib/vocabulary";
import type { SidebarListMode } from "@/lib/sidebar-rows";
import { Tabs, TabsList, TabsTrigger } from "@/ui/components/tabs";

/** Segmented [Agents | Threads] switch for the list area. */
export function SidebarModeToggle({ mode, onChange }: { mode: SidebarListMode; onChange: (mode: SidebarListMode) => void }) {
  return <Tabs value={mode} onValueChange={value => onChange(value as SidebarListMode)} className="shrink-0 gap-0 px-2 pt-2">
    <TabsList aria-label="Sidebar list" className="h-7 w-full gap-0.5 rounded-md bg-secondary p-0.5">
      <TabsTrigger value="agents" className="h-6 flex-1 rounded-sm px-2 text-xs data-[active]:bg-background data-[active]:text-foreground">{v("{Sentinels}")}</TabsTrigger>
      <TabsTrigger value="threads" className="h-6 flex-1 rounded-sm px-2 text-xs data-[active]:bg-background data-[active]:text-foreground">{v("{Missions}")}</TabsTrigger>
    </TabsList>
  </Tabs>;
}
