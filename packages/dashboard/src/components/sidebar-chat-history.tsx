import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { ConsoleSessionRail } from "@/console/session-rail";
import { useConsoleWorkspace } from "@/console/use-console-workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type DeleteChat = { id: string; title: string; saved: boolean };

/** Shared cached history remains available when the main view is another tool. */
export function SidebarChatHistory({ onSelect }: { onSelect?: () => void } = {}) {
  const navigate = useNavigate();
  const workspace = useConsoleWorkspace(undefined, null);
  const { archiveConsoleSession, deleteConsoleSession, deleteSavedConsoleSession, resumeConsoleSession } = useBackendApi();
  const team = useTeamAccess();
  const [deletion, setDeletion] = useState<DeleteChat | null>(null);
  const readOnly = team.enabled && team.user?.role === "viewer";
  const remove = async () => {
    if (!deletion || readOnly || workspace.busy) return;
    const target = deletion;
    const result = await workspace.perform(async () => {
      if (target.saved) await deleteSavedConsoleSession(target.id);
      else await deleteConsoleSession(target.id);
      return true;
    }, target.id);
    if (result !== undefined) { workspace.forgetDrafts(target.id); setDeletion(null); }
  };
  return <>
    <ConsoleSessionRail workspace={workspace} onSelect={onSelect} showMobileFooter={false}
      onCreate={() => { onSelect?.(); navigate("/console?new=1"); }}
      onRename={() => {}}
      onExport={() => {}}
      onArchiveLive={session => { if (!readOnly) void workspace.perform(() => archiveConsoleSession(session.id), session.id); }}
      onArchive={(saved, archived) => { if (!readOnly) void workspace.perform(() => archiveConsoleSession(saved.id, true, archived), saved.id); }}
      onResume={saved => {
        onSelect?.();
        if (readOnly) { navigate(`/console/saved/${saved.id}`); return; }
        void workspace.perform(() => resumeConsoleSession(saved.id, {}), saved.id).then(created => { if (created) navigate(`/console/${created.id}`); });
      }}
      onDeleteLive={session => setDeletion({ id: session.id, title: session.title || session.target || "this conversation", saved: false })}
      onDelete={saved => setDeletion({ id: saved.id, title: saved.summary || saved.target || "this conversation", saved: true })}
    />
    {workspace.error && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">{workspace.error}</p>}
    <Dialog open={Boolean(deletion)} onOpenChange={open => { if (!open) setDeletion(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Delete chat?</DialogTitle><DialogDescription>Delete “{deletion?.title}”? This cannot be undone.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={workspace.busy} onClick={() => setDeletion(null)}>Cancel</Button><Button variant="destructive" disabled={workspace.busy || readOnly} onClick={() => void remove()}>{workspace.busy ? "Deleting…" : "Delete chat"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
