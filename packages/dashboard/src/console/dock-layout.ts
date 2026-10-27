import type { DockviewApi } from "dockview-react";
export type SavedDockLayout = ReturnType<DockviewApi["toJSON"]>;
/** Keep supported panels only, remapping restarted chat IDs without losing split geometry. */
export function restoreDockLayout(value: unknown, chatIds: readonly string[], remap: Record<string, string | null> = {}): SavedDockLayout | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    const layout = structuredClone(value) as SavedDockLayout;
    if (!layout.grid?.root || !layout.panels || typeof layout.panels !== "object") return undefined;
    const allowed = new Set(["chat", "browser", ...chatIds.map(id => `chat:${id}`)]);
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
