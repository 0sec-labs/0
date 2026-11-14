import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/ui/components/select";
import { AUTONOMY_OPTIONS, SENTINEL_LIMITS, TOOL_ACCESS_OPTIONS, type SentinelFormState } from "@/sentinels/model";

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
    {children}
  </div>;
}

/** The editable body of a Sentinel (Settings view). Creation only asks for a name. */
export function SentinelFields({ form, onChange, disabled = false }: { form: SentinelFormState; onChange: (next: SentinelFormState) => void; disabled?: boolean }) {
  const set = <K extends keyof SentinelFormState>(key: K, value: SentinelFormState[K]) => onChange({ ...form, [key]: value });
  const lines = (id: string, label: string, key: "repos" | "targets" | "outOfScope") => <Field label={label} htmlFor={id}><Textarea className="min-h-14" id={id} placeholder="One per line" rows={2} value={form[key]} disabled={disabled} onChange={event => set(key, event.target.value)} /></Field>;
  return <div className="space-y-5">
    <Field label="Name" htmlFor="sentinel-name"><Input id="sentinel-name" value={form.name} maxLength={SENTINEL_LIMITS.name} disabled={disabled} onChange={event => set("name", event.target.value)} /></Field>
    <Field label="Job" htmlFor="sentinel-mission"><Input id="sentinel-mission" placeholder="What it watches for" value={form.mission} maxLength={SENTINEL_LIMITS.mission} disabled={disabled} onChange={event => set("mission", event.target.value)} /></Field>
    {lines("sentinel-repos", "Repositories", "repos")}
    {lines("sentinel-targets", "Targets", "targets")}
    {lines("sentinel-out", "Off limits", "outOfScope")}
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm font-medium" id="sentinel-production-label">Production targets</p>
      <Switch aria-labelledby="sentinel-production-label" checked={form.production} disabled={disabled} onCheckedChange={value => set("production", value)} />
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Approval"><Select aria-label="Approval" disabled={disabled} value={form.autonomy} onValueChange={value => set("autonomy", value as SentinelFormState["autonomy"])} options={AUTONOMY_OPTIONS.map(option => ({ value: option.value, label: option.label }))} /></Field>
      <Field label="Access"><Select aria-label="Access" disabled={disabled} value={form.toolAccess} onValueChange={value => set("toolAccess", value as SentinelFormState["toolAccess"])} options={TOOL_ACCESS_OPTIONS.map(option => ({ value: option.value, label: option.label }))} /></Field>
      <Field label="Daily budget (USD)" htmlFor="sentinel-daily"><Input id="sentinel-daily" inputMode="decimal" value={form.dailyUsd} disabled={disabled} onChange={event => set("dailyUsd", event.target.value)} /></Field>
      <Field label="Runs per day" htmlFor="sentinel-runs"><Input id="sentinel-runs" inputMode="numeric" value={form.maxRunsPerDay} disabled={disabled} onChange={event => set("maxRunsPerDay", event.target.value)} /></Field>
    </div>
  </div>;
}
