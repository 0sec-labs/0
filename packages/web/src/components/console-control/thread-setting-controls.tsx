import { useEffect, useState } from "react";
import { Slider } from "@/ui/components/slider";
import { Input } from "@/ui/components/input";
import { Select } from "@/components/ui/select";
import type { SettingDefinition } from "./contracts";

type Apply = (value: unknown) => void;

/** Bounded integer setting: a slider with its live value, committed once on release or key press. */
export function NumberSettingControl({ definition, label, value, disabled, apply, choices }: { definition: SettingDefinition; label: string; value: unknown; disabled: boolean; apply: Apply; choices?: readonly { value: number; label: string }[] }) {
  const saved = typeof value === "number" ? value : Number(definition.default);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  if (choices) return <Select aria-label={label} size="sm" className="w-auto min-w-36 shrink-0" value={String(saved)} disabled={disabled} onValueChange={next => apply(Number(next))} options={choices.map(choice => ({ value: String(choice.value), label: choice.label }))} />;
  return <div className="flex w-56 items-center gap-3">
    <Slider label={label} min={definition.min ?? 0} max={definition.max ?? 100} step={definition.step ?? 1} value={draft} disabled={disabled}
      onValueChange={next => setDraft(Array.isArray(next) ? next[0]! : next)} onValueCommitted={next => { const final = Array.isArray(next) ? next[0]! : next; if (final !== saved) apply(final); }} />
    <span aria-hidden="true" className="w-10 shrink-0 text-right text-sm tabular-nums text-muted-foreground-1">{draft}</span>
  </div>;
}

/** Free-text setting, saved when the field loses focus or Enter is pressed. */
export function TextSettingControl({ definition, label, value, disabled, apply }: { definition: SettingDefinition; label: string; value: unknown; disabled: boolean; apply: Apply }) {
  const saved = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => { if (draft !== saved) apply(draft); };
  return <Input aria-label={label} className="w-64" value={draft} maxLength={definition.maxLength} disabled={disabled} placeholder="Optional"
    onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") commit(); }} />;
}
