import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { SENTINEL_LIMITS, type SentinelFormState } from "@/sentinels/model";

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
    {children}
  </div>;
}

/** The editable body of a Sentinel (Settings view). Creation only asks for a name. */
export function SentinelFields({ form, onChange, disabled = false }: { form: SentinelFormState; onChange: (next: SentinelFormState) => void; disabled?: boolean }) {
  const set = <K extends keyof SentinelFormState>(key: K, value: SentinelFormState[K]) => onChange({ ...form, [key]: value });
  return <div className="space-y-5">
    <Field label="Name" htmlFor="sentinel-name"><Input id="sentinel-name" value={form.name} maxLength={SENTINEL_LIMITS.name} disabled={disabled} onChange={event => set("name", event.target.value)} /></Field>
    <Field label="Job" htmlFor="sentinel-mission"><Input id="sentinel-mission" placeholder="What it watches for" value={form.mission} maxLength={SENTINEL_LIMITS.mission} disabled={disabled} onChange={event => set("mission", event.target.value)} /></Field>
  </div>;
}
