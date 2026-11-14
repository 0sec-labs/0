import type { DesktopConsoleSession } from "@0/engine/shared";
import { Button } from "@/components/ui/button";

/** Capability is supplied by the owning gateway, never guessed from elapsed time. */
export function ForceStopControl({ cancellation, canWrite, busy, onForceStop }: {
  cancellation?: DesktopConsoleSession["cancellation"];
  canWrite: boolean;
  busy: boolean;
  onForceStop: () => void;
}) {
  if (!cancellation?.forceStopAvailable || !["timed_out", "unconfirmed"].includes(cancellation.phase)) return null;
  return <Button type="button" size="sm" variant="outline" disabled={!canWrite || busy} onClick={onForceStop}>Force stop</Button>;
}
