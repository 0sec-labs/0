import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DockviewApi } from "dockview-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { PanelRightIcon } from "@/ui/icons/panel";
import { isViewPanelId, listViewPanels, restoreViewPanels, snapshotViewPanels, viewIdOfPanel, type DockApiLike, type PersistedPanelViews } from "./dock-views";
import { useOpenViewIds, usePanelViews } from "./panel-view-host";
import { usePanelViewPersistence } from "./use-panel-views";
import { agentTitle } from "./registry";
import { shortcutHint } from "@/lib/shortcuts";
import { panelViewEntity, panelViewKind, type OpenViewOptions, type PanelViewId } from "./types";
import { useViewShortcuts } from "./use-view-shortcuts";

/** What the page needs from the dock's panel views without owning Dockview. */
export type PanelControls = {
  /** True once the dock layout is restored and views can open. */
  ready: boolean;
  openView: (id: PanelViewId, options?: OpenViewOptions) => void;
  /** Open the saved views (or Overview), or close every view. Returns whether the panel is now open. */
  toggle: () => boolean;
};

const closedViews = new WeakMap<object, PersistedPanelViews>();

/** Toggle the whole right panel. Remembers the closed tabs so the next open brings them back. */
export function usePanelToggle() {
  const { api, snapshot, openView } = usePanelViews();
  const titles = useMemo(() => Object.fromEntries((snapshot?.workers ?? []).map(worker => [`agent:${worker.id}`, agentTitle(worker)])), [snapshot?.workers]);
  const latest = useRef({ api, titles });
  latest.current = { api, titles };
  return useCallback((): boolean => {
    const { api: dock, titles: names } = latest.current;
    if (!dock) return false;
    const like = dock as unknown as DockApiLike;
    const open = listViewPanels(like);
    if (open.length) {
      closedViews.set(dock, snapshotViewPanels(like));
      for (const panel of [...open]) panel.api.close();
      return false;
    }
    const saved = closedViews.get(dock);
    const compact = typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches;
    if (saved?.views.length) restoreViewPanels(like, saved, { compact, titles: names, dropUnknownEntities: true });
    else openView("overview");
    return true;
  }, [openView]);
}

/** Header toggle for the right panel; mirrors whether any view tab is open. */
export function RightPanelToggle() {
  const { api } = usePanelViews();
  const open = useOpenViewIds(api).length > 0;
  const toggle = usePanelToggle();
  const toggleShortcut = shortcutHint("panel.toggle");
  return <Tooltip content={<>{open ? "Hide right panel" : "Show right panel"} <span className="text-muted-foreground-2">{toggleShortcut}</span></>}>
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Toggle right panel" aria-expanded={open} aria-keyshortcuts="Meta+Shift+B Control+Shift+B" className="text-muted-foreground" onClick={() => void toggle()}><PanelRightIcon filled={open} /></Button>
  </Tooltip>;
}

/**
 * Renders nothing. Lives inside `PanelViewProvider` to: persist views per chat, close the previous chat's tabs when
 * the owning chat changes, register the shortcuts, and hand `PanelControls` and the visible agent tab to the page.
 */
export function PanelViewBridge({ ready, onControls, onVisibleAgent }: { ready: boolean; onControls?: (controls: PanelControls | null) => void; onVisibleAgent?: (workerId: string | null) => void }) {
  const { api, snapshot, sessionId, openView, agents } = usePanelViews();
  const toggle = usePanelToggle();
  const compact = typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches;
  const titles = useMemo(() => Object.fromEntries((agents ?? []).map(agent => [`agent:${agent.id}`, agentTitle(agent)])), [agents]);
  // Entity tabs can only be named once their chat has loaded; restoring earlier would drop them.
  const loaded = !sessionId || snapshot?.session.id === sessionId;
  usePanelViewPersistence(api as DockviewApi | undefined, sessionId, { enabled: ready && loaded, compact, titles });
  // Declared after the persistence hook so its subscriptions are disposed first and this cleanup is never saved.
  const closeAll = useRef<() => void>(() => {});
  useEffect(() => {
    if (!api) return;
    closeAll.current = () => { for (const panel of [...api.panels]) if (isViewPanelId(panel.id)) panel.api.close(); };
    return () => closeAll.current();
  }, [api, sessionId]);

  useViewShortcuts(action => {
    if (!ready) return;
    if (action.type === "toggle-panel") void toggle();
    else openView(action.id);
  });

  // Stable identity (callbacks read through a ref) so the page does not re-render whenever the worker list changes.
  const latest = useRef({ openView, toggle });
  latest.current = { openView, toggle };
  const hasApi = Boolean(api);
  const controls = useMemo<PanelControls | null>(() => hasApi ? { ready, openView: (id, options) => latest.current.openView(id, options), toggle: () => latest.current.toggle() } : null, [hasApi, ready]);
  useEffect(() => { onControls?.(controls); }, [controls, onControls]);
  useEffect(() => () => onControls?.(null), [onControls]);

  // Dockview leaves the active tab half-scrolled in a narrow strip; keep it fully visible.
  useEffect(() => {
    if (!api) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      for (const panel of api.panels) {
        if (!isViewPanelId(panel.id)) continue;
        const group = panel.group as unknown as { element?: HTMLElement } | undefined;
        group?.element?.querySelector<HTMLElement>(".dv-tab.dv-active-tab")?.scrollIntoView({ inline: "nearest", block: "nearest" });
        return;
      }
    };
    // Dockview adjusts the strip after its own events, so reveal again once it has settled.
    const reveal = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = requestAnimationFrame(run);
      timer = setTimeout(run, 150);
    };
    const subs = [api.onDidActivePanelChange(reveal), api.onDidAddPanel(reveal), api.onDidLayoutChange(reveal)];
    reveal();
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); subs.forEach(sub => sub.dispose()); };
  }, [api]);

  const visibleAgent = useRef<string | null>(null);
  useEffect(() => {
    if (!api) return;
    const read = () => {
      const group = api.panels.find(panel => isViewPanelId(panel.id))?.group;
      const active = group?.activePanel?.id;
      const id = active ? viewIdOfPanel(active) : undefined;
      const next = id && panelViewKind(id) === "agent" ? panelViewEntity(id) ?? null : null;
      if (next !== visibleAgent.current) { visibleAgent.current = next; onVisibleAgent?.(next); }
    };
    read();
    const subs = [api.onDidAddPanel(read), api.onDidRemovePanel(read), api.onDidLayoutChange(read), api.onDidActivePanelChange(read)];
    return () => subs.forEach(sub => sub.dispose());
  }, [api, onVisibleAgent]);
  return null;
}
