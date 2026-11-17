import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TRIGGER_FREQUENCIES, type TriggerDraft } from "@/sentinels/model";

const zones = (current: string): string[] => { const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; return all.includes(current) ? all : [current, ...all]; };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}

/** The real schedule fields: how often, at what time, which day, which timezone. Shared by Add trigger and by editing a trigger in place. */
export function ScheduleFields({ draft, set, idPrefix = "trigger" }: { draft: TriggerDraft; set: <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) => void; idPrefix?: string }) {
  return <>
    <FieldRow label="Repeats"><Select aria-label="Repeats" value={draft.frequency} onValueChange={value => set("frequency", value as TriggerDraft["frequency"])} options={TRIGGER_FREQUENCIES.map(([value, label]) => ({ value, label }))} /></FieldRow>
    {draft.frequency === "minutes" && <FieldRow label="Every (minutes, 5 or more)" htmlFor={`${idPrefix}-every`}><Input id={`${idPrefix}-every`} type="number" min={5} max={1440} value={draft.every} onChange={event => set("every", event.target.value)} /></FieldRow>}
    {draft.frequency === "weekly" && <FieldRow label="Day"><Select aria-label="Day" value={draft.weekday} onValueChange={value => set("weekday", value)} options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))} /></FieldRow>}
    {["daily", "weekdays", "weekly"].includes(draft.frequency) && <FieldRow label="Time" htmlFor={`${idPrefix}-time`}><Input id={`${idPrefix}-time`} type="time" value={draft.time} onChange={event => set("time", event.target.value)} /></FieldRow>}
    {draft.frequency === "cron" && <FieldRow label="Cron expression" htmlFor={`${idPrefix}-cron`}><Input id={`${idPrefix}-cron`} placeholder="0 9 * * 1" value={draft.cron} onChange={event => set("cron", event.target.value)} /></FieldRow>}
    <FieldRow label="Timezone"><Select aria-label="Timezone" value={draft.timezone} onValueChange={value => set("timezone", value)} options={zones(draft.timezone).map(zone => ({ value: zone, label: zone.replaceAll("_", " ") }))} /></FieldRow>
  </>;
}
