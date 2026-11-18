import { useRef, useState } from "react";
import { v } from "@/lib/vocabulary";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { NAME_PLACEHOLDER, choosePreset, createRequest, defaultFolder, newAgentDraft, setAvatar, setName, type AgentDraft } from "@/lib/agent-create-model";
import { useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { SENTINEL_LIMITS, type Sentinel } from "@/sentinels/model";
import { AvatarPicker } from "./avatar-picker";
import { FolderPicker } from "./folder-row";
import { ComputerRow, ModelRow, Row } from "./profile-rows";
import { SENTINEL_ICONS } from "./sentinel-icons";

const NO_RECENTS: string[] = [];

/** One 448px dialog: start from, avatar, name, Folder, Computer, Model, Create. The sentinel is created active and the owner lands in its thread. */
export function CreateSentinelDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (sentinel: Sentinel) => void }) {
  const presets = useSentinelPresets(open);
  const { create } = useSentinelMutations();
  const [recents] = usePersistentState<string[]>(STORAGE_KEYS.recentWorkspaces, NO_RECENTS);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [error, setError] = useState("");
  const current = draft ?? newAgentDraft({ folder: defaultFolder(Array.isArray(recents) ? recents : []) });
  const update = (next: AgentDraft) => { setDraft(next); setError(""); };
  const reset = () => { setDraft(null); setError(""); create.reset(); };
  const inflight = useRef(false);
  const submit = async () => {
    if (inflight.current) return;
    const request = createRequest(current);
    if (!request.ok) { setError(request.error); return; }
    inflight.current = true;
    try {
      const result = await create.mutateAsync(request.body);
      reset();
      onCreated(result.sentinel);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create."); }
    finally { inflight.current = false; }
  };
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) reset(); }}>
    <DialogContent className="sm:max-w-[448px]" data-testid="new-agent-dialog">
      <DialogHeader>
        <DialogTitle>{v("New {sentinel}")}</DialogTitle>
        <DialogDescription className="sr-only">Pick a starting point, give it a name and create it.</DialogDescription>
      </DialogHeader>
      <form className="flex min-w-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); if (!create.isPending) void submit(); }}>
        <div role="group" aria-label="Start from" className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <span className="mr-1 shrink-0 text-xs text-muted-foreground-1">Start from</span>
          {[{ id: "", name: "Blank", icon: "agent" }, ...(presets.data ?? []).map(item => ({ id: item.id, name: item.name, icon: item.avatar.icon }))].map(item => {
            const Icon = SENTINEL_ICONS[item.icon];
            return <button key={item.id || "blank"} type="button" aria-pressed={current.presetId === item.id} onClick={() => update(choosePreset(current, presets.data?.find(preset => preset.id === item.id)))}
              className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md border-[0.5px] border-border-2 px-2 text-xs outline-none hover:bg-secondary focus-visible:outline-ring-inset", current.presetId === item.id ? "bg-secondary text-foreground" : "text-muted-foreground-1")}>
              {Icon && <Icon size={12} aria-hidden="true" />}<span>{item.name}</span></button>;
          })}
        </div>
        {presets.error && <p role="alert" className="text-xs text-destructive">Presets are unavailable.</p>}
        <div className="flex flex-col items-center gap-3 pt-1">
          <AvatarPicker name={current.name} avatar={current.avatar} onChange={next => update(setAvatar(current, next))} />
          <Input aria-label="Name" autoFocus placeholder={NAME_PLACEHOLDER} value={current.name} maxLength={SENTINEL_LIMITS.name} onChange={event => update(setName(current, event.target.value))}
            className="h-auto border-0 bg-transparent px-0 text-center text-[24px]/8 font-medium tracking-[-0.02em] shadow-none placeholder:text-muted-foreground-3 focus:border-transparent focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0" />
        </div>
        <div>
          <Row label="Folder"><FolderPicker value={current.folder} onChange={folder => update({ ...current, folder })} /></Row>
          <ComputerRow value={current.computerId} onChange={computerId => update({ ...current, computerId })} />
          <ModelRow enabled={open} value={current.model} onChange={model => update({ ...current, model })} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end"><Button type="submit" variant="default" disabled={create.isPending}>{create.isPending ? "Creating" : v("Create {sentinel}")}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
