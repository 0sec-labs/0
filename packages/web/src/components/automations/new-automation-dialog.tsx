import { useState } from "react";
import { v } from "@/lib/vocabulary";
import { errorText } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/ui/components/select";
import { useCreateAutomation } from "@/components/automations/use-automations";
import type { Sentinel } from "@/sentinels/model";

/** New automation: which Sentinel owns it. It opens in the editor once created. */
export function NewAutomationDialog({ open, onOpenChange, sentinels, sentinelId, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; sentinels: readonly Sentinel[]; sentinelId?: string;
  onCreated: (sentinelId: string, workflowId: string) => void;
}) {
  const create = useCreateAutomation();
  const [owner, setOwner] = useState(sentinelId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ownerId = sentinelId ?? (sentinels.some(item => item.id === owner) ? owner : sentinels[0]?.id ?? "");
  const submit = async () => {
    if (!ownerId || busy) return;
    setBusy(true); setError("");
    try {
      const ownership = { ownerSentinelId: ownerId };
      const definition = await create.blank(ownership);
      onOpenChange(false);
      onCreated(ownerId, definition.id);
    } catch (cause) { setError(errorText(cause, "Unable to create the automation.")); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setError(""); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>New automation</DialogTitle></DialogHeader>
      <div className="space-y-3">
        {!sentinelId && <div className="space-y-1.5"><span className="text-xs font-medium text-muted-foreground">{v("{Sentinel}")}</span><Select aria-label={v("{Sentinel}")} value={ownerId} onValueChange={setOwner} options={sentinels.map(item => ({ value: item.id, label: item.name }))} /></div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="secondary" disabled={busy || !ownerId} onClick={() => void submit()}>{busy ? "Creating" : "Create"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
