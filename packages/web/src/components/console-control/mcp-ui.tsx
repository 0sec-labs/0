import { useState, type ReactNode } from "react";
import { CapyCloseIcon as Close, CapyPlusIcon as Plus, CapySearchIcon as Search } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsCard } from "@/ui/components/settings-card";
import { LogoTile } from "./connection-ui";
import { displayToolDescription, displayToolName } from "@/lib/mcp-tool-name";
import { filterByText, countLabel, safeLogo, type KeyValueRow } from "./mcp-model";

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

/** Tools and skills of one server or plugin, with a shared filter. Renders nothing when the backend reported neither. */
export function ToolSkillLists({ tools, skills }: { tools: { name: string; description: string }[]; skills: { name: string; description: string }[] }) {
  const [filter, setFilter] = useState("");
  if (tools.length === 0 && skills.length === 0) return null;
  const shownTools = filterByText(tools, filter); const shownSkills = filterByText(skills, filter);
  const group = (title: string, count: number, shown: typeof tools, noun: string) => count > 0 && <section className="flex flex-col gap-3">
    <div><h3 className="text-base font-medium">{title}</h3><p className="text-sm text-muted-foreground-2">{countLabel(count, noun)}{shown.length !== count ? `, ${shown.length} shown` : ""}</p></div>
    <SettingsCard className="mx-0">{shown.length ? shown.map(item => <div key={item.name} className="p-4"><h4 title={item.name} className="text-sm font-medium break-words">{displayToolName(item.name)}</h4>{displayToolDescription(item.description) && <p className="text-sm text-muted-foreground-2 break-words">{displayToolDescription(item.description)}</p>}</div>) : <div className="p-4 text-sm text-muted-foreground-2">Nothing matches.</div>}</SettingsCard>
  </section>;
  return <div className="flex flex-col gap-6">
    {tools.length + skills.length > 6 && <div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 size-(--icon-sm) -translate-y-1/2 text-muted-foreground-2" /><Input type="search" aria-label="Filter tools and skills" className="pl-7" placeholder="Filter tools and skills" value={filter} onChange={event => setFilter(event.target.value)} autoComplete="off" /></div>}
    {group("Tools", tools.length, shownTools, "tool")}
    {group("Skills", skills.length, shownSkills, "skill")}
  </div>;
}
