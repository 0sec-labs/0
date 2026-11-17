import { useState } from "react";
import { Popover } from "@/ui/components/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AGENT_COLORS, type AgentAvatar } from "@/lib/agent-create-model";
import { cn } from "@/lib/utils";
import { SentinelAvatar } from "./sentinel-avatar";
import { SENTINEL_ICONS } from "./sentinel-icons";

/** The big avatar at the top of the dialog. Click it to change the glyph or the background colour. */
export function AvatarPicker({ name, avatar, onChange }: { name: string; avatar: AgentAvatar; onChange: (next: Partial<AgentAvatar>) => void }) {
  const [tab, setTab] = useState<"icons" | "colours">("icons");
  return <Popover>
    <Popover.Trigger aria-label="Change avatar" className="rounded-2xl outline-none focus-visible:outline-ring-inset">
      <SentinelAvatar sentinel={{ name: name || "Agent", avatar, status: "active" }} size="xl" />
    </Popover.Trigger>
    <Popover.Content align="center" className="w-72 p-3">
      <Tabs value={tab} onValueChange={next => setTab(next as typeof tab)}>
        <TabsList variant="line" aria-label="Avatar">
          <TabsTrigger value="icons">Icons</TabsTrigger>
          <TabsTrigger value="colours">Colours</TabsTrigger>
        </TabsList>
        <TabsContent value="icons">
          <div role="group" aria-label="Icons" className="mt-3 grid grid-cols-6 gap-1.5">
            {Object.entries(SENTINEL_ICONS).map(([id, Icon]) => <button key={id} type="button" aria-label={id} aria-pressed={avatar.icon === id} onClick={() => onChange({ icon: id })}
              className={cn("flex size-9 items-center justify-center rounded-lg text-muted-foreground-1 outline-none hover:bg-secondary focus-visible:outline-ring-inset", avatar.icon === id && "bg-secondary text-foreground ring-1 ring-foreground/30")}><Icon size={18} /></button>)}
          </div>
        </TabsContent>
        <TabsContent value="colours">
          <div role="group" aria-label="Colours" className="mt-3 grid grid-cols-6 gap-2">
            {AGENT_COLORS.map(color => <button key={color} type="button" aria-label={color} aria-pressed={avatar.color === color} onClick={() => onChange({ color })} style={{ backgroundColor: color }}
              className={cn("size-8 rounded-full outline-none focus-visible:outline-ring-inset", avatar.color === color && "ring-2 ring-foreground ring-offset-2 ring-offset-popover")} />)}
          </div>
        </TabsContent>
      </Tabs>
    </Popover.Content>
  </Popover>;
}
