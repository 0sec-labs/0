import { useState } from "react";
import { v } from "@/lib/vocabulary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { SENTINEL_LIMITS, type Sentinel, type SentinelAutonomy, type SentinelPreset } from "@/sentinels/model";
import { SentinelAvatar } from "./sentinel-avatar";
import { LoadingState } from "@/components/state-panel";

const BLANK_AVATAR = { color: "#4f6bed", icon: "sparkle" };
const AUTONOMY_CHIP: Record<SentinelAutonomy, string> = { observe: "Observes", propose: "Proposes", act: "Acts" };

function PresetCard({ preset, onPick }: { preset: SentinelPreset | null; onPick: () => void }) {
  return <button type="button" onClick={onPick} className="flex min-w-0 items-start gap-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-3 text-left outline-none transition-colors hover:bg-card-hover focus-visible:outline-ring-inset">
    <SentinelAvatar size="sm" sentinel={{ name: preset?.name ?? "New", avatar: preset?.avatar ?? BLANK_AVATAR, status: "paused" }} />
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{preset?.name ?? "Start from scratch"}</span>{preset && <Badge variant="neutral">{AUTONOMY_CHIP[preset.autonomy]}</Badge>}</span>
      <span className="line-clamp-2 text-xs text-muted-foreground-1">{preset?.description ?? "A blank Sentinel."}</span>
    </span>
  </button>;
}

/** Pick a preset (or blank), name it, create. New Sentinels are always created paused with safe defaults; scope, budget and charter are set on its page. */
export function CreateSentinelDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (sentinel: Sentinel) => void }) {
  const presets = useSentinelPresets(open);
  const { create } = useSentinelMutations();
  const [step, setStep] = useState<"pick" | "name">("pick");
  const [preset, setPreset] = useState<SentinelPreset | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const reset = () => { setStep("pick"); setPreset(null); setName(""); setError(""); create.reset(); };
  const pick = (next: SentinelPreset | null) => { setPreset(next); setName(next?.name ?? ""); setError(""); setStep("name"); };
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Give it a name."); return; }
    setError("");
    try {
      const result = await create.mutateAsync({ name: trimmed, ...(preset ? { preset: preset.id } : { avatar: BLANK_AVATAR }), status: "paused" });
      reset();
      onCreated(result.sentinel);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create."); }
  };
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) reset(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{step === "pick" ? v("Create {a sentinel}") : "Name it"}</DialogTitle>
        <DialogDescription className="sr-only">{step === "pick" ? "Choose a preset or start from scratch." : "Enter a name."}</DialogDescription>
      </DialogHeader>
      {step === "pick" ? <div className="min-h-0 flex-1 overflow-y-auto">
        {presets.isLoading ? <LoadingState label="Loading presets" variant="cards" rows={4} />
          : <div className="grid gap-2 sm:grid-cols-2">
            {(presets.data ?? []).map(item => <PresetCard key={item.id} preset={item} onPick={() => pick(item)} />)}
            <PresetCard preset={null} onPick={() => pick(null)} />
          </div>}
        {presets.error && <p role="alert" className="mt-3 text-sm text-destructive">Presets are unavailable.</p>}
      </div> : <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!create.isPending) void submit(); }}>
        <Input id="sentinel-name" aria-label="Name" autoFocus value={name} maxLength={SENTINEL_LIMITS.name} onChange={event => setName(event.target.value)} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </form>}
      {step === "pick" && error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
      {step === "name" && <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => { setStep("pick"); setError(""); }}>Back</Button>
        <Button type="button" variant="accent" disabled={create.isPending} onClick={() => void submit()}>{create.isPending ? "Creating" : "Create"}</Button>
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
}
