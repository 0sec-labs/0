import { ChevronDown, Monitor } from "lucide-react";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { useBackendSelection } from "../backend-context";

/** Registered computers only; workspace requests remain bound to their mounted owner. */
export function BackendConnectionPicker() {
  const connection = useBackendSelection();
  if (!connection) return null;
  const disconnected = connection.status === "disconnected";
  if (connection.backends.length <= 1 && connection.backendId === "local") return disconnected ? <button type="button" onClick={connection.reconnect} className="px-2 text-xs text-destructive hover:underline">Disconnected · Reconnect</button> : null;
  const label = (id: string, name?: string) => id === "local" ? "This computer" : name || id;
  const selected = connection.backends.find(item => item.id === connection.backendId);
  return <div className="flex min-w-0 items-center gap-1">
    <DropdownMenu><DropdownMenu.Trigger aria-label="Choose computer" className="flex max-w-48 items-center gap-2 rounded-full px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"><button type="button"><Monitor className="size-3.5 shrink-0" /><span className="truncate">{label(connection.backendId, selected?.name)}</span><ChevronDown className="size-3 shrink-0" /></button></DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" sideOffset={8} className="max-w-72 p-1">
        {connection.backends.map(item => <DropdownMenu.Item key={item.id} selected={item.id === connection.backendId} onClick={() => connection.select(item.id)}>{label(item.id, item.name)}</DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu>
    {disconnected && <button type="button" onClick={connection.reconnect} className="text-xs text-destructive hover:underline" aria-label="Disconnected. Reconnect to this computer">Disconnected</button>}
  </div>;
}
