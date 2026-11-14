import { useContext } from "react";
import { ChatHostActionsContext } from "@/chat-backend-scope";
import { ChevronDown, Monitor, Server, Settings } from "lucide-react";
import { Link } from "react-router-dom";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { useBackendSelection } from "../backend-context";
import { useBackendApi } from "@/api";

/** Plain text trigger: no fill or border; the enlarged hit area does not shift layout. */
const GHOST_TRIGGER = "-m-1 inline-flex min-w-0 max-w-64 items-center gap-1 rounded-[6px] border-[0.5px] border-transparent p-1 text-sm font-medium tracking-[-0.01em] [&_svg:first-of-type]:translate-y-[0.5px] text-muted-foreground-1 outline-none transition-colors duration-100 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:text-foreground disabled:opacity-40";

/** Rail variant: Capy's 24px `text-xs` status-rail chip (12px icon, 6px gap, hover tint). */
const RAIL_TRIGGER = "inline-flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-[6px] border-[0.5px] border-transparent px-2 text-xs font-medium tracking-[-0.01em] [&_svg:first-of-type]:translate-y-[0.5px] text-muted-foreground-1 outline-none transition-colors duration-100 hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:bg-secondary data-[popup-open]:text-foreground disabled:opacity-40";

/** Registered hosts only; workspace requests remain bound to their mounted owner. */
export function BackendConnectionPicker({ sidebar = false, collapsed = false, rail = false, onSelectHost }: { sidebar?: boolean; collapsed?: boolean; rail?: boolean; onSelectHost?: (id: string) => void }) {
  const connection = useBackendSelection();
  const hostActions = useContext(ChatHostActionsContext);
  const { client } = useBackendApi();
  if (!connection) return null;

  const label = (id: string, name?: string) => id === "local" ? "This computer" : name || id;
  const selected = connection.backends.find(item => item.id === client.backendId);
  const disconnected = selected ? selected.status === "disconnected" : connection.status === "disconnected";
  const SelectedIcon = client.backendId === "local" ? Monitor : Server;
  return <div className="flex min-w-0 shrink-0 items-center gap-1">
    <DropdownMenu><DropdownMenu.Trigger aria-label="Run on" className={rail ? RAIL_TRIGGER : GHOST_TRIGGER}><SelectedIcon aria-hidden="true" className={rail ? "size-3 shrink-0" : "size-3.5 shrink-0"} strokeWidth={1} /><span className={collapsed ? "sr-only" : "truncate"}>{label(client.backendId, selected?.name)}</span>{rail && client.backendId !== "local" && selected?.status === "connected" && <span role="img" aria-label="Host connected" className="size-1.5 shrink-0 rounded-full bg-success" />}{!collapsed && <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-3" strokeWidth={1} />}</DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" side="bottom" sideOffset={4} collisionPadding={12} className="w-72 max-w-[calc(100vw-24px)]">
        <DropdownMenu.Group>
          <DropdownMenu.Label className="sticky top-0 z-10 mt-0 flex min-h-[22px] items-center bg-popover px-2 py-0 text-xs font-medium text-muted-foreground-2">Run on</DropdownMenu.Label>
          {connection.backends.map(item => {
            const Icon = item.id === "local" ? Monitor : Server;
            const status = item.id === "local" ? "Local host" : item.status === "connected" ? "Connected" : item.status === "connecting" ? "Connecting…" : "Disconnected";
            return <DropdownMenu.Item key={item.id} icon={<Icon aria-hidden="true" className="size-3.5 text-icon-muted" strokeWidth={1.5} />} className="text-[13px] font-[450] tracking-[-0.01em]" aria-label={`${label(item.id, item.name)} · ${status}`} selected={item.id === client.backendId} onClick={() => (onSelectHost ?? hostActions?.onSelectHost ?? connection.select)(item.id)}>
              <span className="min-w-0 flex-1 truncate">{label(item.id, item.name)}</span>{item.id !== "local" && <span aria-hidden="true" title={status} className={`size-1.5 shrink-0 rounded-full ${item.status === "connected" ? "bg-success" : "bg-muted-foreground/50"}`} />}
            </DropdownMenu.Item>;
          })}
        </DropdownMenu.Group>
        <div role="separator" className="-mx-1 my-1 h-px bg-border-1" />
        <DropdownMenu.Item render={<Link to="/workers" />} icon={<Settings aria-hidden="true" className="size-3.5 text-icon-muted" />}><span className="min-w-0 flex-1 truncate">Manage hosts</span></DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
    {disconnected && <button type="button" onClick={connection.reconnect} className="text-xs text-destructive hover:underline" aria-label="Disconnected. Reconnect to this host">Disconnected</button>}
  </div>;
}
