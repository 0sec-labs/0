import { useEffect, useRef } from "react";
import type { DockviewApi } from "dockview-react";
import { usePersistentState } from "@/lib/use-persistent-state";
import { normalizePersistedViews, restoreViewPanels, snapshotViewPanels, type DockApiLike, type PersistedPanelViews } from "./dock-views";

export const panelViewsStorageKey = (sessionId: string | undefined) => `0-console-panel:${sessionId ?? "new"}`;

/** Per-chat persisted view tabs. Untrusted storage is normalized on read. */
export function usePersistedPanelViews(sessionId: string | undefined) {
  const [raw, setRaw] = usePersistentState<PersistedPanelViews>(panelViewsStorageKey(sessionId), { views: [] });
  return [normalizePersistedViews(raw), setRaw] as const;
}

/**
 * Restore the saved views once when the dock is ready, then keep storage in step with the dock.
 * Restoring is a no-op for views the dock layout already brought back.
 */
export function usePanelViewPersistence(api: DockviewApi | undefined, sessionId: string | undefined, options: { enabled?: boolean; compact?: boolean; titles?: Record<string, string> } = {}) {
  const [saved, setSaved] = usePersistedPanelViews(sessionId);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const titles = useRef(options.titles);
  titles.current = options.titles;
  const enabled = options.enabled !== false;
  useEffect(() => {
    if (!api || !enabled) return;
    const dock = api;
    restoreViewPanels(dock, savedRef.current, { compact: options.compact, titles: titles.current, dropUnknownEntities: true });
    const write = () => {
      const next = snapshotViewPanels(dock);
      const current = savedRef.current;
      if (next.active === current.active && next.views.length === current.views.length && next.views.every((id, index) => id === current.views[index])) return;
      setSaved(next);
    };
    const subs = [api.onDidAddPanel(write), api.onDidRemovePanel(write), api.onDidActivePanelChange(write)];
    return () => subs.forEach(sub => sub.dispose());
  }, [api, sessionId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
