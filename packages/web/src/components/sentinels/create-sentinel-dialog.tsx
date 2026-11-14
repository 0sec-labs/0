import { useState } from "react";
import { v } from "@/lib/vocabulary";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/ui/components/select";
import { useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { SENTINEL_LIMITS, type Sentinel } from "@/sentinels/model";

const BLANK_AVATAR = { color: "#4f6bed", icon: "sparkle" };
const BLANK = "";

/** One small dialog: a name and an optional starting point. New Sentinels are created paused with safe defaults; everything else is set on its page. */
export function CreateSentinelDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (sentinel: Sentinel) => void }) {
  const presets = useSentinelPresets(open);
  const { create } = useSentinelMutations();
  const [presetId, setPresetId] = useState(BLANK);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const reset = () => { setPresetId(BLANK); setName(""); setTouched(false); setError(""); create.reset(); };
  const preset = presets.data?.find(item => item.id === presetId);
  const pick = (id: string) => {
    setPresetId(id);
    if (!touched) setName(presets.data?.find(item => item.id === id)?.name ?? "");
  };
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
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{v("New {sentinel}")}</DialogTitle>
        <DialogDescription className="sr-only">Name it and optionally start from a preset.</DialogDescription>
      </DialogHeader>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!create.isPending) void submit(); }}>
        <Input id="sentinel-name" aria-label="Name" placeholder="Name" autoFocus value={name} maxLength={SENTINEL_LIMITS.name} onChange={event => { setName(event.target.value); setTouched(true); }} />
        <Select aria-label="Preset" disabled={presets.isLoading} value={presetId} onValueChange={pick}
          options={[{ value: BLANK, label: "Blank" }, ...(presets.data ?? []).map(item => ({ value: item.id, label: item.name }))]} />
        {preset && <p className="text-xs text-muted-foreground-1">{preset.description}</p>}
        {presets.error && <p role="alert" className="text-sm text-destructive">Presets are unavailable.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </form>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" variant="secondary" disabled={create.isPending} onClick={() => void submit()}>{create.isPending ? "Creating" : "Create"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
