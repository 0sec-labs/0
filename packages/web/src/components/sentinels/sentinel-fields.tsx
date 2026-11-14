import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/ui/components/segmented-control";
import { AUTONOMY_OPTIONS, SENTINEL_LIMITS, TOOL_ACCESS_OPTIONS, type SentinelFormState } from "@/sentinels/model";

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
    {children}
    {hint && <p className="text-xs text-muted-foreground-1">{hint}</p>}
  </div>;
}

/** The editable body of a Sentinel, shared by the create dialog and the Settings view. */
export function SentinelFields({ form, onChange, disabled = false }: { form: SentinelFormState; onChange: (next: SentinelFormState) => void; disabled?: boolean }) {
  const set = <K extends keyof SentinelFormState>(key: K, value: SentinelFormState[K]) => onChange({ ...form, [key]: value });
  const autonomy = AUTONOMY_OPTIONS.find(option => option.value === form.autonomy);
  const access = TOOL_ACCESS_OPTIONS.find(option => option.value === form.toolAccess);
  return <div className="space-y-5">
    <Field label="Name" htmlFor="sentinel-name"><Input id="sentinel-name" value={form.name} maxLength={SENTINEL_LIMITS.name} disabled={disabled} onChange={event => set("name", event.target.value)} /></Field>
    <Field label="Mission" htmlFor="sentinel-mission" hint={`What it covers, in one line. ${form.mission.length}/${SENTINEL_LIMITS.mission}`}><Input id="sentinel-mission" value={form.mission} maxLength={SENTINEL_LIMITS.mission} disabled={disabled} onChange={event => set("mission", event.target.value)} /></Field>
    <fieldset className="space-y-4 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] p-3">
      <legend className="px-1 text-sm font-medium">Scope</legend>
      <Field label="Repositories" htmlFor="sentinel-repos" hint="One per line. Empty means none."><Textarea className="min-h-14" id="sentinel-repos" rows={2} value={form.repos} disabled={disabled} onChange={event => set("repos", event.target.value)} /></Field>
      <Field label="Targets and domains" htmlFor="sentinel-targets" hint="Only systems you are authorised to test. One per line."><Textarea className="min-h-14" id="sentinel-targets" rows={2} value={form.targets} disabled={disabled} onChange={event => set("targets", event.target.value)} /></Field>
      <Field label="Out of scope" htmlFor="sentinel-out" hint="Never touched, even when nearby."><Textarea className="min-h-14" id="sentinel-out" rows={2} value={form.outOfScope} disabled={disabled} onChange={event => set("outOfScope", event.target.value)} /></Field>
      <div className="flex items-center justify-between gap-4">
        <div><p className="text-sm font-medium" id="sentinel-production-label">Allow production targets</p><p className="text-xs text-muted-foreground-1">Off by default. Turn on only when production testing is approved.</p></div>
        <Switch aria-labelledby="sentinel-production-label" checked={form.production} disabled={disabled} onCheckedChange={value => set("production", value)} />
      </div>
    </fieldset>
    <Field label="Autonomy" hint={autonomy?.hint}><SegmentedControl label="Autonomy" value={form.autonomy} onValueChange={value => set("autonomy", value)} options={AUTONOMY_OPTIONS.map(option => ({ value: option.value, label: option.label, disabled }))} /></Field>
    <Field label="Tool access" hint={access?.hint}><SegmentedControl label="Tool access" value={form.toolAccess} onValueChange={value => set("toolAccess", value)} options={TOOL_ACCESS_OPTIONS.map(option => ({ value: option.value, label: option.label, disabled }))} /></Field>
    <fieldset className="space-y-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] p-3">
      <legend className="px-1 text-sm font-medium">Budget</legend>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Per run (USD)" htmlFor="sentinel-per-run"><Input id="sentinel-per-run" inputMode="decimal" value={form.perRunUsd} disabled={disabled} onChange={event => set("perRunUsd", event.target.value)} /></Field>
        <Field label="Per day (USD)" htmlFor="sentinel-daily"><Input id="sentinel-daily" inputMode="decimal" value={form.dailyUsd} disabled={disabled} onChange={event => set("dailyUsd", event.target.value)} /></Field>
        <Field label="Minutes per run" htmlFor="sentinel-minutes"><Input id="sentinel-minutes" inputMode="numeric" value={form.perRunMinutes} disabled={disabled} onChange={event => set("perRunMinutes", event.target.value)} /></Field>
        <Field label="Runs per day" htmlFor="sentinel-runs"><Input id="sentinel-runs" inputMode="numeric" value={form.maxRunsPerDay} disabled={disabled} onChange={event => set("maxRunsPerDay", event.target.value)} /></Field>
      </div>
    </fieldset>
  </div>;
}
