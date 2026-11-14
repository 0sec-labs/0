import { useEffect, useRef } from "react";
import { MISSION_START_EVENT, runMissionStart, takeMissionStart } from "@/lib/mission-start";
import { queueComposerPrefill } from "@/lib/composer-prefill";

/**
 * Sends a prompt queued with `requestMissionStart` as the first message of the mission this console owns. `ready` means the
 * mission is loaded; `occupied` means it already has messages or is running, in which case the request is dropped and the
 * user simply lands in that mission. A failed send puts the text in the composer instead.
 */
export function useMissionStart(ready: boolean, occupied: () => boolean, send: (text: string) => Promise<boolean>, onFailed: () => void) {
  const latest = useRef({ occupied, send, onFailed });
  latest.current = { occupied, send, onFailed };
  useEffect(() => {
    if (!ready) return;
    const apply = () => {
      const text = takeMissionStart();
      if (!text || latest.current.occupied()) return;
      void runMissionStart(text, value => latest.current.send(value), value => { queueComposerPrefill(value); latest.current.onFailed(); });
    };
    apply();
    window.addEventListener(MISSION_START_EVENT, apply);
    return () => window.removeEventListener(MISSION_START_EVENT, apply);
  }, [ready]);
}
