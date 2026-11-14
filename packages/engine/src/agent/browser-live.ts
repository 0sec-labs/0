/** Owner-scoped, view-only live browser registry. Frames never enter model history. */
export interface BrowserViewFrame { data: string; mimeType: "image/jpeg"; width?: number; height?: number; capturedAt: string }
export interface BrowserViewDescriptor { id: string; pageId: string; sessionId: string; producerId: string; tab: string; url: string; title?: string; liveAvailable: boolean }
interface View { ownerId: string; descriptor: () => BrowserViewDescriptor; allowed: () => boolean; start?: (frame: (value: BrowserViewFrame) => void) => Promise<() => void>; listeners: Set<(frame: BrowserViewFrame) => void>; stop?: () => void; starting?: Promise<void>; retired?: boolean }
const views = new Map<string, View>();
export function registerBrowserView(ownerId: string, pageId: string, descriptor: View["descriptor"], allowed: View["allowed"], start?: View["start"]): void {
  if (views.has(pageId)) return;
  views.set(pageId, { ownerId, descriptor, allowed, start, listeners: new Set() });
}
export function unregisterBrowserView(pageId: string): void {
  const view = views.get(pageId); if (!view) return;
  views.delete(pageId); view.retired = true; view.listeners.clear(); view.stop?.(); view.stop = undefined;
}
export function listBrowserViews(ownerId: string): BrowserViewDescriptor[] {
  return [...views.values()].filter(view => view.ownerId === ownerId && view.allowed()).map(view => view.descriptor());
}
export async function subscribeBrowserView(ownerId: string, pageId: string, onFrame: (frame: BrowserViewFrame) => void): Promise<() => void> {
  const view = views.get(pageId);
  if (!view || view.ownerId !== ownerId || !view.allowed() || !view.start) throw new Error("Live browser view is unavailable");
  // Bound subscriber work and fanout. Transport must drop frames under backpressure.
  if (view.listeners.size >= 8) throw new Error("Too many live browser subscribers");
  view.listeners.add(onFrame);
  const release = () => { view.listeners.delete(onFrame); if (!view.listeners.size) { view.stop?.(); view.stop = undefined; } };
  if (!view.stop && !view.starting) {
    view.starting = view.start(frame => {
      if (view.retired || !view.allowed() || frame.data.length > 2_800_000) return;
      for (const listener of view.listeners) { try { listener(frame); } catch { /* A consumer cannot disrupt capture. */ } }
    }).then(stop => { if (view.retired || !view.listeners.size) stop(); else view.stop = stop; }).finally(() => { view.starting = undefined; });
  }
  try { await view.starting; } catch (error) { release(); throw error; }
  return release;
}
