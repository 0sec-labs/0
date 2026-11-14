import type { DockviewApi } from "dockview-react";
import { chatResourceKey, parseChatResourceKey } from "./chat-host";
export type SavedDockLayout = ReturnType<DockviewApi["toJSON"]>;
/** Keep chat panels only, remapping restarted chat IDs without losing split geometry. */
export function restoreDockLayout(value: unknown, chatIds: readonly string[], remap: Record<string, string | null> = {}): SavedDockLayout | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    const layout = structuredClone(value) as SavedDockLayout;
    if (!layout.grid?.root || !layout.panels || typeof layout.panels !== "object") return undefined;
    // View panels (`view:*`) are restored per chat by `usePanelViewPersistence`, never from the shared layout.
    const allowed = new Set(["chat", ...chatIds.map(id => `chat:${id}`)]);
    const mapped = new Map<string, string>();
    const panels: SavedDockLayout["panels"] = {};
    for (const [id, panel] of Object.entries(layout.panels)) {
      const old = id.startsWith("chat:") ? id.slice(5) : undefined;
      const next = old && Object.hasOwn(remap, old) ? remap[old] ? `chat:${remap[old]}` : null : id;
      if (!next || !allowed.has(next) || panels[next]) continue;
      mapped.set(id, next);
      panels[next] = { ...panel, id: next, contentComponent: "slot", tabComponent: "tab", renderer: "always" };
    }
    const used = new Set<string>();
    const groups = new Set<string>();
    const clean = (node: any): any => {
      if (!node || (node.type !== "leaf" && node.type !== "branch")) return undefined;
      if (node.type === "branch") {
        if (!Array.isArray(node.data)) return undefined;
        const data = node.data.map(clean).filter(Boolean);
        return data.length ? { ...node, data } : undefined;
      }
      if (!Array.isArray(node.data?.views)) return undefined;
      const views = node.data.views.flatMap((id: string) => { const next = mapped.get(id); if (!next || used.has(next)) return []; used.add(next); return [next]; });
      if (!views.length) return undefined;
      groups.add(node.data.id);
      const activeView = mapped.get(node.data.activeView);
      return { ...node, data: { ...node.data, views, activeView: activeView && views.includes(activeView) ? activeView : views[0], tabGroups: node.data.tabGroups?.map((group: any) => ({ ...group, panelIds: group.panelIds?.flatMap((id: string) => mapped.get(id) ? [mapped.get(id)] : []) })).filter((group: any) => group.panelIds?.length) } };
    };
    const root = clean(layout.grid.root);
    if (!root || !used.has("chat")) return undefined;
    return { ...layout, activeGroup: layout.activeGroup && groups.has(layout.activeGroup) ? layout.activeGroup : undefined, grid: { ...layout.grid, root }, panels: Object.fromEntries(Object.entries(panels).filter(([id]) => used.has(id))), floatingGroups: [], popoutGroups: [], edgeGroups: undefined };
  } catch { return undefined; }
}

export interface PersistedDockChat { id: string; title: string; savedId?: string; backendId?: string }
/**
 * The tab roster to mount before the sessions list arrives: exactly the persisted references (valid, deduplicated,
 * never the primary chat), so the dock can restore from the route and persisted layout immediately. Once the
 * authoritative roster loads, normal reconciliation removes or remaps stale entries inside their existing splits.
 */
export function dockChatsBeforeSessions(chats: unknown, { primary, defaultBackendId }: { primary?: { backendId: string; id?: string }; defaultBackendId: string }): PersistedDockChat[] {
  if (!Array.isArray(chats)) return [];
  const seen = new Set<string>();
  const result: PersistedDockChat[] = [];
  for (const value of chats) {
    if (!value || typeof value !== "object" || typeof value.id !== "string") continue;
    if (value.backendId !== undefined && typeof value.backendId !== "string") continue;
    const ref = parseChatResourceKey(value.id, value.backendId ?? defaultBackendId);
    if (!ref || (value.backendId && ref.backendId !== value.backendId)) continue;
    const key = chatResourceKey(ref);
    if (seen.has(key) || (primary?.id && ref.id === primary.id && ref.backendId === primary.backendId)) continue;
    seen.add(key);
    result.push({ id: ref.id, backendId: ref.backendId, title: (typeof value.title === "string" ? value.title : "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200), ...(typeof value.savedId === "string" ? { savedId: value.savedId } : {}) });
  }
  return result;
}
/** Pick the roster to render: the authoritative reconciled one once sessions are loaded, the persisted one before. */
export function dockChatsForRender<T>({ sessionsLoaded, reconciled, persisted }: { sessionsLoaded: boolean; reconciled: readonly T[]; persisted: readonly T[] }): readonly T[] {
  return sessionsLoaded ? reconciled : persisted;
}
