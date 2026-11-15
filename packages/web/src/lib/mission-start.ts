/**
 * Start-a-mission bus: "run this prompt as the first message of the mission the console opens". The setup card cannot know
 * which mission it lands on (/chats reuses a blank one), so it queues the request here and the mounted console page sends it
 * through the composer's own send path. A request is accepted once until it settles, so a double click never sends twice.
 */
export const MISSION_START_EVENT = "0:mission-start";

let pending: string | null = null;
let inFlight = false;

/** Queue the prompt. False when a start is already queued or running (the caller just navigates). */
export function requestMissionStart(text: string): boolean {
  if (!text.trim() || pending !== null || inFlight) return false;
  pending = text;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MISSION_START_EVENT));
  return true;
}

export function takeMissionStart(): string | null {
  const text = pending;
  pending = null;
  return text;
}

/** Send once; on failure or a throw hand the text to `fallback` (the composer prefill). Returns whether it was sent. */
export async function runMissionStart(text: string, send: (text: string) => Promise<boolean>, fallback: (text: string) => void): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  try {
    const sent = await send(text).catch(() => false);
    if (!sent) fallback(text);
    return sent;
  } finally { inFlight = false; }
}

export function resetMissionStartForTest(): void { pending = null; inFlight = false; held = null; }

/**
 * A mission start that was held back because no connected model can serve it. The prompt is kept so connecting a model
 * resumes it; the console shows the Connect step while it is set.
 */
let held: string | null = null;
const heldListeners = new Set<() => void>();
export function holdMissionStart(text: string | null): void { held = text; heldListeners.forEach(listener => listener()); }
export function heldMissionStart(): string | null { return held; }
export function subscribeHeldMissionStart(listener: () => void): () => void { heldListeners.add(listener); return () => { heldListeners.delete(listener); }; }
