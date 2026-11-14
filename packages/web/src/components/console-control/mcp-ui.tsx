import type { ReactNode } from "react";
import { CapyCloseIcon as Close, CapyPlusIcon as Plus } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogoTile } from "@/ui/components/logo-tile";
import { safeLogo, type KeyValueRow } from "./mcp-model";

/** Logo tile that only ever renders a same-origin image; anything else falls back to the supplied icon. */
export function EntryLogo({ logo, fallback, className = "size-9" }: { logo?: string; fallback: ReactNode; className?: string }) {
  const src = safeLogo(logo);
  return <LogoTile className={className}>{src ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-[60%] rounded-[3px] object-contain" /> : fallback}</LogoTile>;
}

/** Name/value rows. `secret` masks values and keeps them write-only: existing values are never read back, only their keys are shown. */
export function KeyValueRows({ label, rows, onChange, keyLabel, keyPlaceholder, secret = false, savedKeys = [], disabled = false, error }: { label: string; rows: KeyValueRow[]; onChange: (rows: KeyValueRow[]) => void; keyLabel: string; keyPlaceholder: string; secret?: boolean; savedKeys?: string[]; disabled?: boolean; error?: string }) {
  const set = (index: number, patch: Partial<KeyValueRow>) => onChange(rows.map((row, at) => at === index ? { ...row, ...patch } : row));
  return <fieldset className="grid gap-2 text-sm" disabled={disabled}>
    <legend className="mb-2 font-medium">{label}</legend>
    {savedKeys.length > 0 && <p className="text-xs text-muted-foreground-2">Saved: {savedKeys.join(", ")}. Values are hidden. Enter a name again to replace it.</p>}
    {rows.map((row, index) => <div key={index} className="flex items-center gap-2">
      <Input aria-label={`${keyLabel} ${index + 1}`} className="min-w-0 flex-1" value={row.key} placeholder={keyPlaceholder} autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" onChange={event => set(index, { key: event.target.value })} />
      <Input aria-label={`${keyLabel} ${index + 1} value`} className="min-w-0 flex-1" type={secret ? "password" : "text"} value={row.value} placeholder="Value" autoComplete="new-password" spellCheck={false} data-1p-ignore data-lpignore="true" onChange={event => set(index, { value: event.target.value })} />
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${keyLabel.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.length > 1 ? rows.filter((_, at) => at !== index) : [{ key: "", value: "" }])}><Close /></Button>
    </div>)}
    <div><Button type="button" variant="ghost" size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}><Plus />Add {keyLabel.toLowerCase()}</Button></div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </fieldset>;
}
