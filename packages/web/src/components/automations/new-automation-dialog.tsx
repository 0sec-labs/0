import { useMemo, useState } from "react";
import { securityWorkflowStarters } from "@0/engine/shared/security-workflow-templates";
import { v } from "@/lib/vocabulary";
import { errorText } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/ui/components/select";
import { useCreateAutomation } from "@/components/automations/use-automations";
import type { Sentinel } from "@/sentinels/model";

const BLANK = "blank";

/** New automation: which Agent owns it, and a starting point. It opens in the Agent's Automations view once created. */
export function NewAutomationDialog({ open, onOpenChange, sentinels, sentinelId, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; sentinels: readonly Sentinel[]; sentinelId?: string;
  onCreated: (sentinelId: string, workflowId: string) => void;
}) {
  const create = useCreateAutomation();
  const [owner, setOwner] = useState(sentinelId ?? "");
  const [template, setTemplate] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const starters = useMemo(() => securityWorkflowStarters(), []);
  const ownerId = sentinelId ?? (sentinels.some(item => item.id === owner) ? owner : sentinels[0]?.id ?? "");
  const submit = async () => {
    if (!ownerId || busy) return;
    setBusy(true); setError("");
    try {
      const ownership = { ownerSentinelId: ownerId };
      const definition = template === BLANK ? await create.blank(ownership) : await create.fromTemplate(template, ownership);
      onOpenChange(false); setTemplate(BLANK);
      onCreated(ownerId, definition.id);
    } catch (cause) { setError(errorText(cause, "Unable to create the automation.")); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setError(""); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>New automation</DialogTitle></DialogHeader>
      <div className="space-y-3">
        {!sentinelId && <div className="space-y-1.5"><span className="text-xs font-medium text-muted-foreground">{v("{Sentinel}")}</span><Select aria-label={v("{Sentinel}")} value={ownerId} onValueChange={setOwner} options={sentinels.map(item => ({ value: item.id, label: item.name }))} /></div>}
        <div className="space-y-1.5"><span className="text-xs font-medium text-muted-foreground">Start from</span><Select aria-label="Start from" value={template} onValueChange={setTemplate} options={[{ value: BLANK, label: "Blank automation" }, ...starters.map(item => ({ value: item.id, label: item.name }))]} /></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="secondary" disabled={busy || !ownerId} onClick={() => void submit()}>{busy ? "Creating" : "Create"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
