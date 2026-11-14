import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { v } from "@/lib/vocabulary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { fieldsFromForm, formFromPreset, type Sentinel, type SentinelFormState, type SentinelPreset } from "@/sentinels/model";
import { SentinelFields } from "./sentinel-fields";
import { SentinelAvatar } from "./sentinel-avatar";
import { LoadingState } from "@/components/state-panel";

const BLANK_AVATAR = { color: "#4f6bed" };

function PresetCard({ preset, onPick }: { preset: SentinelPreset | null; onPick: () => void }) {
  const avatar = preset?.avatar ?? { color: BLANK_AVATAR.color, emoji: "✨" };
  return <button type="button" onClick={onPick} className="flex min-h-28 flex-col gap-2 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-3 text-left outline-none transition-colors hover:bg-card-hover focus-visible:outline-ring-inset">
    <span className="flex items-center gap-2">
      <SentinelAvatar sentinel={{ name: preset?.name ?? "New", avatar, status: "paused" }} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{preset?.name ?? "Start from scratch"}</span>
    </span>
    <span className="line-clamp-2 text-xs text-muted-foreground-1">{preset?.job ?? "A blank Sentinel. You write the mission and the charter."}</span>
    {preset && <span className="mt-auto flex flex-wrap gap-1">
      <Badge variant="neutral">{preset.autonomy}</Badge>
      {preset.feasibility === "needs-engine" ? <Badge variant="warning">Partly available</Badge> : <Badge variant="success">Ready</Badge>}
    </span>}
  </button>;
}

/** Two steps: pick a preset (or blank), then review the inert defaults. New Sentinels are always created paused. */
export function CreateSentinelDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (sentinel: Sentinel) => void }) {
  const presets = useSentinelPresets(open);
  const { create } = useSentinelMutations();
  const [step, setStep] = useState<"pick" | "fields">("pick");
  const [preset, setPreset] = useState<SentinelPreset | null>(null);
  const [form, setForm] = useState<SentinelFormState>(() => formFromPreset(undefined));
  const [error, setError] = useState("");
  const reset = () => { setStep("pick"); setPreset(null); setForm(formFromPreset(undefined)); setError(""); create.reset(); };
  const pick = (next: SentinelPreset | null) => { setPreset(next); setForm(formFromPreset(next ?? undefined)); setError(""); setStep("fields"); };
  const submit = async () => {
    const parsed = fieldsFromForm(form);
    if (!parsed.ok) {
      setError(parsed.error);
      const field = document.getElementById("sentinel-name");
      if (field && !form.name.trim()) { field.setAttribute("aria-invalid", "true"); field.scrollIntoView({ block: "center" }); field.focus(); }
      return;
    }
    setError("");
    try {
      const body: Record<string, unknown> = { ...parsed.fields, ...(preset ? { preset: preset.id } : { avatar: BLANK_AVATAR }), status: "paused" };
      const result = await create.mutateAsync(body);
      reset();
      onCreated(result.sentinel);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create the Sentinel."); }
  };
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) reset(); }}>
    <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{step === "pick" ? v("Create {a sentinel}") : preset?.name ?? v("New {sentinel}")}</DialogTitle>
        <DialogDescription>{step === "pick" ? v("A {sentinel} is a named agent with a standing job. It remembers what it learns and brings in a crew when work is big.") : "Review the defaults. It is created paused, read-only in scope, with a finite budget."}</DialogDescription>
      </DialogHeader>
      {step === "pick" ? <div className="min-h-0 flex-1 overflow-y-auto">
        {presets.isLoading ? <LoadingState label="Loading presets" variant="cards" rows={4} />
          : <div className="grid gap-3 sm:grid-cols-2">
            {(presets.data ?? []).map(item => <PresetCard key={item.id} preset={item} onPick={() => pick(item)} />)}
            <PresetCard preset={null} onPick={() => pick(null)} />
          </div>}
        {presets.error && <p role="alert" className="mt-3 text-sm text-destructive">Presets are unavailable. You can still start from scratch.</p>}
        <p className="mt-4 text-xs text-muted-foreground-1">{v("{Sentinels} only test targets you have authorised and never act outside the autonomy level you choose.")}</p>
      </div> : <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        {preset?.feasibility === "needs-engine" && <p className="rounded-(--radius-control) bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">{preset.feasibilityNote}</p>}
        <SentinelFields form={form} onChange={setForm} />
        {preset && <section aria-label="Suggested automations" className="space-y-2">
          <h3 className="text-sm font-medium">Suggested automations</h3>
          <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)]">
            {preset.suggestedAutomations.map(item => <li key={item.name} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{item.name}<span className="ml-2 text-xs text-muted-foreground-1">{item.trigger.kind === "schedule" ? item.trigger.cadence : item.trigger.kind}</span></span>
              {item.available ? <Badge variant="success">Available</Badge> : <Badge variant="neutral">Needs engine work</Badge>}
            </li>)}
          </ul>
          <p className="text-xs text-muted-foreground-1">Add these from the Automations tab after creating. Nothing runs until you do.</p>
        </section>}
      </div>}
      {error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
      {step === "fields" && <DialogFooter className="sm:justify-between">
        <Button type="button" variant="ghost" onClick={() => { setStep("pick"); setError(""); }}><ArrowLeft aria-hidden="true" />Back</Button>
        <Button type="button" variant="accent" disabled={create.isPending} onClick={() => void submit()}>{create.isPending ? "Creating" : v("Create {sentinel}")}</Button>
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
}
