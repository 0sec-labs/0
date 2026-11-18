import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Monitor, Server } from "lucide-react";
import { v } from "@/lib/vocabulary";
import { useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ModelPicker, isModelEnabled } from "@/components/model-picker";
import { useModelCatalog } from "@/console/use-model-catalog";
import { readLastModelChoice } from "@/lib/last-model-choice";
import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { NAME_PLACEHOLDER, THIS_COMPUTER, choosePreset, createRequest, defaultFolder, newAgentDraft, setAvatar, setName, type AgentDraft } from "@/lib/agent-create-model";
import { useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { SENTINEL_LIMITS, type Sentinel } from "@/sentinels/model";
import { AvatarPicker } from "./avatar-picker";
import { FolderPicker } from "./folder-row";
import { SENTINEL_ICONS } from "./sentinel-icons";

const NO_RECENTS: string[] = [];
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-h-12 items-center justify-between gap-4 border-b-[0.5px] border-border-1 py-1"><span className="text-sm font-medium">{label}</span><div className="flex min-w-0 justify-end">{children}</div></div>;
}

/** One 448px dialog: start from, avatar, name, Folder, Computer, Model, Create. The sentinel is created active and the owner lands in its thread. */
export function CreateSentinelDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (sentinel: Sentinel) => void }) {
  const presets = useSentinelPresets(open);
  const { create } = useSentinelMutations();
  const { client, webFetchJson } = useBackendApi();
  const backends = useBackendSelection()?.backends ?? [];
  const catalog = useModelCatalog({ backendId: client.backendId, webFetchJson, enabled: open });
  const [recents] = usePersistentState<string[]>(STORAGE_KEYS.recentWorkspaces, NO_RECENTS);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [error, setError] = useState("");
  const current = draft ?? newAgentDraft({ folder: defaultFolder(Array.isArray(recents) ? recents : []) });
  const update = (next: AgentDraft) => { setDraft(next); setError(""); };
  const reset = () => { setDraft(null); setError(""); create.reset(); };
  const models = useMemo(() => (catalog.data?.models ?? []).filter(isModelEnabled), [catalog.data]);
  const fallback = readLastModelChoice(client.backendId) ?? (() => { const pick = catalog.data?.recommended?.find(item => item.role === "orchestrator") ?? catalog.data?.recommended?.[0]; return pick ? { providerId: pick.providerId, model: pick.model } : undefined; })();
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
  const computers = backends.length > 0 ? backends : [{ id: THIS_COMPUTER, name: "This computer", status: "connected" }];
  const computer = computers.find(item => item.id === current.computerId);
  const computerName = (id: string, name?: string) => id === THIS_COMPUTER ? "This computer" : name || id;
  const ComputerIcon = current.computerId === THIS_COMPUTER ? Monitor : Server;
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
              className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full border-[0.5px] border-border-2 px-2 text-xs outline-none hover:bg-secondary focus-visible:outline-ring-inset", current.presetId === item.id ? "bg-secondary text-foreground" : "text-muted-foreground-1")}>
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
          <Row label="Computer">
            <DropdownMenu>
              <DropdownMenu.Trigger aria-label="Computer" render={<Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-56 gap-1.5 font-normal" />}>
                <ComputerIcon aria-hidden="true" className="size-3.5 shrink-0 text-icon-muted" /><span className="min-w-0 truncate">{computerName(current.computerId, computer?.name)}</span><ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-2" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end" className="w-64">
                {computers.map(item => <DropdownMenu.Item key={item.id} selected={item.id === current.computerId} onClick={() => update({ ...current, computerId: item.id })}>{computerName(item.id, item.name)}</DropdownMenu.Item>)}
              </DropdownMenu.Content>
            </DropdownMenu>
          </Row>
          <Row label="Model">
            <ModelPicker label="Default model" models={models} recommended={catalog.data?.recommended ?? []} backendId={client.backendId} pending={catalog.isPending} onOpen={catalog.refreshIfStale}
              selected={current.model ?? fallback} triggerClassName="h-8 w-auto max-w-56 border-transparent bg-transparent px-2 shadow-none" onSelect={item => update({ ...current, model: { providerId: item.provider, model: item.id } })} />
          </Row>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end"><Button type="submit" variant="default" disabled={create.isPending}>{create.isPending ? "Creating" : v("Create {sentinel}")}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
