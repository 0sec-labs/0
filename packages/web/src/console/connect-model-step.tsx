import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useProviders } from "@/components/console-control/connections-control";
import { ConnectionSheet } from "@/components/console-control/connection-sheet";
import { heldMissionStart, holdMissionStart, requestMissionStart, subscribeHeldMissionStart } from "@/lib/mission-start";

/** Shown in the thread when "Ask 0 to get started" was held back because no connected model works. */
export function ConnectModelStep() {
  const held = useSyncExternalStore(subscribeHeldMissionStart, heldMissionStart, () => null);
  const providers = useProviders();
  const [open, setOpen] = useState(false);
  if (held === null) return null;
  return <section aria-label="Connect a model" data-testid="connect-model-step" className="rounded-(--radius-card) border-[0.5px] border-border-2 bg-card p-4 text-sm">
    <h2 className="font-medium text-foreground">Connect a model to get started</h2>
    <p className="mt-1 text-muted-foreground-2">None of your connections can answer right now, so nothing was sent. Add a working one and 0 will pick up where you left off.</p>
    <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>Add connection</Button>
    <ConnectionSheet open={open} onOpenChange={setOpen} providers={providers.data?.providers ?? []} hostName="this computer"
      onConnected={() => { setOpen(false); const text = heldMissionStart(); holdMissionStart(null); if (text) requestMissionStart(text); }} />
  </section>;
}
