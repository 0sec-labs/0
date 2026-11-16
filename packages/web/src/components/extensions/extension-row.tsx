import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/ui/components/tooltip";
import { StatusBadge } from "@/ui/components/status-badge";
import { CapyMoreIcon } from "@/ui/icons/capy";
import { canRemove, canUpdate, isOn, rowControl, showBuiltInChip, sourceLine, statusView, toggleIntent, type ExtensionRowDto } from "@/lib/extensions-model";

/** One extension. Shows what the model decided; every click goes up to the page. */
export function ExtensionRow({ row, scopeDefined, disabled, onToggle, onUpdate, onRemove }: { row: ExtensionRowDto; scopeDefined: boolean; disabled: boolean; onToggle: (row: ExtensionRowDto) => void; onUpdate: (row: ExtensionRowDto) => void; onRemove: (row: ExtensionRowDto) => void }) {
  const status = statusView(row);
  const intent = toggleIntent(row);
  const control = rowControl(row, scopeDefined);
  const hasMenu = canUpdate(row) || canRemove(row);
  return <li data-extension={row.name} data-status={row.status} className="flex items-start gap-4 p-4">
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium break-words text-foreground">{row.name}</h2>
        {row.version && <span className="text-xs text-muted-foreground-2">{row.version}</span>}
        {showBuiltInChip(row, control) && <StatusBadge appearance="outline" className="rounded-md">Built in</StatusBadge>}
        {(status.tone === "danger" || status.tone === "warning" || row.status === "needs-approval") && <StatusBadge tone={status.tone} appearance="outline" className="rounded-md">{status.label}</StatusBadge>}
      </div>
      {row.description && <p className="text-sm break-words text-muted-foreground-1">{row.description}</p>}
      <p className="font-mono text-xs break-all text-muted-foreground-2">{sourceLine(row)}</p>
      {row.canDo.length > 0 && <p className="text-xs break-words text-muted-foreground-2">Can: {row.canDo.join("; ")}</p>}
      {status.detail && <p className={status.tone === "danger" ? "text-xs break-words text-destructive" : "text-xs break-words text-muted-foreground-1"}>{status.detail}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-2 pt-0.5">
      {control.kind === "label" ? <span className="text-xs text-muted-foreground-1">{control.text}</span> : <Switch checked={isOn(row)} disabled={disabled || intent === "none"} aria-label={`${isOn(row) ? "Turn off" : "Turn on"} ${row.name}`} onCheckedChange={() => onToggle(row)} />}
      {hasMenu && <DropdownMenu>
        <Tooltip content="More actions"><DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${row.name}`} disabled={disabled} />}><CapyMoreIcon className="size-4" /></DropdownMenu.Trigger></Tooltip>
        <DropdownMenu.Content align="end">
          {canUpdate(row) && <DropdownMenu.Item onClick={() => onUpdate(row)}>Check for update</DropdownMenu.Item>}
          {canRemove(row) && <DropdownMenu.Item onClick={() => onRemove(row)}>Remove</DropdownMenu.Item>}
        </DropdownMenu.Content>
      </DropdownMenu>}
    </div>
  </li>;
}
