import { useContext } from "react";
import { ChatHostActionsContext } from "@/chat-backend-scope";
import { ChevronDown, Monitor, Server } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { useBackendSelection } from "../backend-context";
import { useBackendApi } from "@/api";

/** Registered hosts only; workspace requests remain bound to their mounted owner. */
export function BackendConnectionPicker({ sidebar = false, collapsed = false, onSelectHost }: { sidebar?: boolean; collapsed?: boolean; onSelectHost?: (id: string) => void }) {
  const connection = useBackendSelection();
  const hostActions = useContext(ChatHostActionsContext);
  const { client } = useBackendApi();
  if (!connection) return null;

  const label = (id: string, name?: string) => id === "local" ? "This computer" : name || id;
  const selected = connection.backends.find(item => item.id === client.backendId);
  const disconnected = selected ? selected.status === "disconnected" : connection.status === "disconnected";
  const SelectedIcon = client.backendId === "local" ? Monitor : Server;
  return <div className="flex min-w-0 max-w-[min(14rem,45vw)] shrink-0 items-center gap-1">
    <DropdownMenu><DropdownMenu.Trigger aria-label="Choose host" className="inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"><button type="button"><SelectedIcon aria-hidden="true" className="size-4 shrink-0" /><span className={collapsed ? "sr-only" : "truncate"}>{label(client.backendId, selected?.name)}</span>{!collapsed && <ChevronDown className="size-3 shrink-0" />}</button></DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" side="top" sideOffset={8} collisionPadding={12} className="w-72 max-w-[calc(100vw-24px)]">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Host</DropdownMenu.Label>
          {connection.backends.map(item => {
            const Icon = item.id === "local" ? Monitor : Server;
            const status = item.id === "local" ? "Local host" : item.status === "connected" ? "Connected" : item.status === "connecting" ? "Connecting…" : "Disconnected";
            return <DropdownMenu.Item key={item.id} icon={<Icon aria-hidden="true" className="size-4" />} className="ui-menu-item ui-menu-item--detail gap-3" aria-label={`${label(item.id, item.name)} · ${status}`} selected={item.id === client.backendId} onClick={() => (onSelectHost ?? hostActions?.onSelectHost ?? connection.select)(item.id)}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5"><span className="truncate text-sm font-medium leading-5">{label(item.id, item.name)}</span><span className="ui-menu-secondary inline-flex items-center gap-1.5">{item.id !== "local" && <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${item.status === "connected" ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />}{status}</span></span>
            </DropdownMenu.Item>;
          })}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
    {disconnected && <button type="button" onClick={connection.reconnect} className="text-xs text-destructive hover:underline" aria-label="Disconnected. Reconnect to this host">Disconnected</button>}
  </div>;
}
