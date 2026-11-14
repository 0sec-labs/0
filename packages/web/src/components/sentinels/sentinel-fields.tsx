import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/ui/components/select";
import { AUTONOMY_OPTIONS, SENTINEL_LIMITS, TOOL_ACCESS_OPTIONS, type SentinelFormState } from "@/sentinels/model";

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
    {children}
    {hint && <p className="text-xs text-muted-foreground-1">{hint}</p>}
  </div>;
}

/** The editable body of a Sentinel (Settings view). Creation only asks for a name. */
export function SentinelFields({ form, onChange, disabled = false }: { form: SentinelFormState; onChange: (next: SentinelFormState) => void; disabled?: boolean }) {
  const set = <K extends keyof SentinelFormState>(key: K, value: SentinelFormState[K]) => onChange({ ...form, [key]: value });
  const autonomy = AUTONOMY_OPTIONS.find(option => option.value === form.autonomy);
  const access = TOOL_ACCESS_OPTIONS.find(option => option.value === form.toolAccess);
  return <div className="space-y-5">
    <Field label="Name" htmlFor="sentinel-name"><Input id="sentinel-name" value={form.name} maxLength={SENTINEL_LIMITS.name} disabled={disabled} onChange={event => set("name", event.target.value)} /></Field>
    <Field label="Mission" htmlFor="sentinel-mission" hint={form.mission.length > SENTINEL_LIMITS.mission * 0.8 ? `${form.mission.length}/${SENTINEL_LIMITS.mission}` : undefined}><Input id="sentinel-mission" placeholder="What it covers" value={form.mission} maxLength={SENTINEL_LIMITS.mission} disabled={disabled} onChange={event => set("mission", event.target.value)} /></Field>
    <fieldset className="space-y-4 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] p-3">
      <legend className="px-1 text-sm font-medium">Scope</legend>
      <p className="text-xs text-muted-foreground-1">Only systems you are authorised to test.</p>
      <Field label="Repositories" htmlFor="sentinel-repos"><Textarea className="min-h-14" id="sentinel-repos" placeholder="One per line" rows={2} value={form.repos} disabled={disabled} onChange={event => set("repos", event.target.value)} /></Field>
      <Field label="Targets and domains" htmlFor="sentinel-targets"><Textarea className="min-h-14" id="sentinel-targets" placeholder="One per line" rows={2} value={form.targets} disabled={disabled} onChange={event => set("targets", event.target.value)} /></Field>
      <Field label="Out of scope" htmlFor="sentinel-out"><Textarea className="min-h-14" id="sentinel-out" placeholder="One per line" rows={2} value={form.outOfScope} disabled={disabled} onChange={event => set("outOfScope", event.target.value)} /></Field>
      <div className="flex items-center justify-between gap-4">
        <div><p className="text-sm font-medium" id="sentinel-production-label">Allow production targets</p><p className="text-xs text-muted-foreground-1">Only when production testing is approved.</p></div>
        <Switch aria-labelledby="sentinel-production-label" checked={form.production} disabled={disabled} onCheckedChange={value => set("production", value)} />
      </div>
    </fieldset>
    <Field label="Autonomy" hint={autonomy?.hint}><Select aria-label="Autonomy" size="sm" className="w-auto min-w-32 shrink-0" disabled={disabled} value={form.autonomy} onValueChange={value => set("autonomy", value as SentinelFormState["autonomy"])} options={AUTONOMY_OPTIONS.map(option => ({ value: option.value, label: option.label }))} /></Field>
    <Field label="Tool access" hint={access?.hint}><Select aria-label="Tool access" size="sm" className="w-auto min-w-32 shrink-0" disabled={disabled} value={form.toolAccess} onValueChange={value => set("toolAccess", value as SentinelFormState["toolAccess"])} options={TOOL_ACCESS_OPTIONS.map(option => ({ value: option.value, label: option.label }))} /></Field>
    <fieldset className="space-y-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] p-3">
      <legend className="px-1 text-sm font-medium">Budget</legend>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Per day (USD)" htmlFor="sentinel-daily"><Input id="sentinel-daily" inputMode="decimal" value={form.dailyUsd} disabled={disabled} onChange={event => set("dailyUsd", event.target.value)} /></Field>
        <Field label="Runs per day" htmlFor="sentinel-runs"><Input id="sentinel-runs" inputMode="numeric" value={form.maxRunsPerDay} disabled={disabled} onChange={event => set("maxRunsPerDay", event.target.value)} /></Field>
      </div>
    </fieldset>
  </div>;
}
