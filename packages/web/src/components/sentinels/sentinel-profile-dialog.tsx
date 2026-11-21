import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorText } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { toast } from "@/ui/components/toast";
import { THIS_COMPUTER, type AgentAvatar, type AgentModelPick } from "@/lib/agent-create-model";
import { useSentinelMutations } from "@/sentinels/api";
import { SENTINEL_LIMITS, type Sentinel } from "@/sentinels/model";
import { AvatarPicker } from "./avatar-picker";
import { FolderPicker } from "./folder-row";
import { ComputerRow, ModelRow, Row } from "./profile-rows";

interface Form { name: string; mission: string; avatar: AgentAvatar; folder: string; computerId: string; model: AgentModelPick | null }
const formOf = (sentinel: Sentinel): Form => ({
  name: sentinel.name, mission: sentinel.mission, avatar: { color: sentinel.avatar.color, icon: sentinel.avatar.icon ?? "agent" }, folder: sentinel.folder ?? "", computerId: sentinel.hostId ?? THIS_COMPUTER,
  model: sentinel.model ? { providerId: sentinel.model.providerId, model: sentinel.model.model } : null,
});

/** The small Profile dialog (448px like New sentinel): who it is and where it runs. Delete, Archive and Save sit in the footer. */
export function SentinelProfileDialog({ sentinel, readOnly, open, onOpenChange }: { sentinel: Sentinel; readOnly: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { update, remove } = useSentinelMutations();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(() => formOf(sentinel));
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = sentinel.status === "archived";
  const locked = readOnly || archived;
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(sentinel));
  const set = (patch: Partial<Form>) => { setForm(current => ({ ...current, ...patch })); setError(""); };
  const save = async () => {
    const name = form.name.trim();
    if (!name) { setError("Give it a name."); return; }
    setError("");
    try {
      await update.mutateAsync({ id: sentinel.id, version: sentinel.version, fields: {
        name, mission: form.mission.trim(), avatar: { color: form.avatar.color, icon: form.avatar.icon }, folder: form.folder || null,
        hostId: form.computerId === THIS_COMPUTER ? null : form.computerId, model: form.model,
      } });
      onOpenChange(false);
    } catch (cause) { setError(errorText(cause, "Unable to save.")); }
  };
  const archive = async () => {
    try { await update.mutateAsync({ id: sentinel.id, version: sentinel.version, fields: { status: "archived" } }); setConfirmArchive(false); onOpenChange(false); toast({ title: `${sentinel.name} archived`, kind: "success" }); }
    catch (cause) { setConfirmArchive(false); setError(errorText(cause, "Unable to archive.")); }
  };
  const destroy = async () => {
    try { await remove.mutateAsync({ id: sentinel.id, version: sentinel.version }); onOpenChange(false); navigate("/sentinels"); } catch (cause) { setConfirmDelete(false); setError(errorText(cause, "Unable to delete.")); }
  };
  return <>
    <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) { setForm(formOf(sentinel)); setError(""); } }}>
      <DialogContent className="sm:max-w-[448px]" data-testid="agent-profile">
        <DialogHeader>
          <DialogTitle className="sr-only">Profile</DialogTitle>
          <DialogDescription className="sr-only">Name, job, folder, computer and model.</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col items-center gap-3 pt-1">
            <AvatarPicker name={form.name} avatar={form.avatar} onChange={next => { if (!locked) set({ avatar: { ...form.avatar, ...next } }); }} />
            <Input aria-label="Name" value={form.name} maxLength={SENTINEL_LIMITS.name} disabled={locked} onChange={event => set({ name: event.target.value })}
              className="h-auto border-0 bg-transparent px-0 text-center text-[24px]/8 font-medium tracking-[-0.02em] shadow-none focus:border-transparent focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0" />
          </div>
          <div>
            <Row label="Job"><Input aria-label="Job" value={form.mission} maxLength={SENTINEL_LIMITS.mission} disabled={locked} placeholder="What it watches for" onChange={event => set({ mission: event.target.value })} className="h-8 w-64 max-w-full border-transparent bg-transparent text-right shadow-none" /></Row>
            <Row label="Folder"><FolderPicker value={form.folder} onChange={folder => set({ folder })} /></Row>
            <ComputerRow value={form.computerId} onChange={computerId => set({ computerId })} disabled={locked} />
            <ModelRow enabled={open} value={form.model} onChange={model => set({ model })} disabled={locked} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="sm:justify-between">
          {readOnly ? <span /> : <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>}
          <span className="flex items-center gap-2">
            {!readOnly && !archived && <Button type="button" variant="ghost" disabled={update.isPending} onClick={() => setConfirmArchive(true)}>Archive</Button>}
            <Button type="button" variant="default" disabled={locked || !dirty || update.isPending} onClick={() => void save()}>{update.isPending ? "Saving" : "Save"}</Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={confirmArchive} onOpenChange={setConfirmArchive} pending={update.isPending} title={`Archive ${sentinel.name}?`} description="It stops waking, leaves the list and cannot be turned back on."
      confirmLabel="Archive" onConfirm={() => void archive()} />
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} pending={remove.isPending} destructive title={`Delete ${sentinel.name}?`} description="Its instructions, notes and history are removed. Threads it started stay."
      confirmLabel="Delete" onConfirm={() => void destroy()} />
  </>;
}
