import { Button } from "@/components/ui/button";
import { SheetPanel } from "@/ui/components/sheet-panel";
import { canRemove, canUpdate, isOn, rowControl, toggleIntent } from "@/lib/extensions-model";
import { plainAccess, versionLines, type ExtensionItem } from "@/lib/extensions-list";
import { ExtensionTile } from "./extension-cell";

/** The detail of one extension: what it can read and change in plain words, its version and pinned commit, and what you can do with it. */
export function ExtensionSheet({ item, disabled, onClose, onConnect, onToggle, onUpdate, onRemove }: { item: ExtensionItem | null; disabled: boolean; onClose: () => void; onConnect: (item: ExtensionItem) => void; onToggle: (item: ExtensionItem) => void; onUpdate: (item: ExtensionItem) => void; onRemove: (item: ExtensionItem) => void }) {
  const row = item?.row;
  const access = item ? plainAccess(item) : [];
  const facts = row ? versionLines(row) : [];
  const toggles = row ? rowControl(row).kind === "switch" && toggleIntent(row) !== "none" : false;
  const hasFooter = Boolean(item && row && (canRemove(row) || canUpdate(row) || toggles || item.status.action));
  return <SheetPanel open={item !== null} onOpenChange={next => { if (!next) onClose(); }} title={item?.title ?? ""} description={item?.sentence || undefined} leading={row ? <ExtensionTile builtin={row.builtin} /> : undefined}
    footer={hasFooter && item && row && <>
      {canRemove(row) && <Button variant="ghost" disabled={disabled} onClick={() => onRemove(item)}>Remove</Button>}
      {canUpdate(row) && <Button variant="outline" disabled={disabled} onClick={() => onUpdate(item)}>Check for update</Button>}
      {toggles && <Button variant="outline" disabled={disabled} onClick={() => onToggle(item)}>{isOn(row) ? "Turn off" : "Turn on"}</Button>}
      {item.status.action === "connect" && <Button disabled={disabled} onClick={() => onConnect(item)}>Connect</Button>}
      {item.status.action === "review" && <Button disabled={disabled} onClick={() => onToggle(item)}>Review</Button>}
    </>}>
    {item && row && <>
      <p className="text-sm text-muted-foreground-1">{item.status.label}</p>
      {access.length > 0 && <section aria-label="What it can do"><h3 className="text-sm font-medium text-foreground">It can</h3><ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground-1">{access.map(line => <li key={line}>{line}</li>)}</ul></section>}
      {facts.length > 0 && <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">{facts.map(fact => <div key={fact.label} className="contents"><dt className="text-muted-foreground-2">{fact.label}</dt><dd className={`min-w-0 break-all text-foreground ${fact.label === "Pinned to" ? "font-mono text-xs leading-5" : "text-sm"}`}>{fact.value}</dd></div>)}</dl>}
      {row.kind === "git" && row.sourceLabel && <p className="text-xs break-all text-muted-foreground-2">{row.sourceLabel}</p>}
      {row.status === "refused" && row.refusal && <p role="alert" className="text-sm text-destructive">{row.refusal.reason}</p>}
    </>}
  </SheetPanel>;
}
