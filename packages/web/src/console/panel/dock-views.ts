import { panelViewKind, parsePanelViewId, type PanelViewId } from "./types";
import { viewTitle } from "./registry";

/** Dockview component key WP6 registers `PanelViewHost` under. */
export const PANEL_VIEW_COMPONENT = "panel-view";
export const VIEW_PANEL_PREFIX = "view:";
/** Capy default: chat 62%, right panel group 38%. */
export const RIGHT_GROUP_RATIO = 0.38;
export const RIGHT_GROUP_MIN_WIDTH = 240;

export type ViewPanelParams = { viewId: PanelViewId };

/** The slice of Dockview these helpers use; `DockviewApi` satisfies it structurally. */
export interface DockGroupLike { id: string; api: { setSize(size: { width?: number; height?: number }): void } }
export interface DockPanelLike {
  id: string;
  group: DockGroupLike;
  params?: unknown;
  api: { setActive(): void; close(): void; setTitle?(title: string): void };
}
export interface DockAddPanelOptions {
  id: string;
  title: string;
  component: string;
  tabComponent: string;
  renderer: "always" | "onlyWhenVisible";
  params: ViewPanelParams;
  minimumWidth: number;
  inactive?: boolean;
  position: { referencePanel?: string; referenceGroup?: string; direction: "right" | "within" };
}
export interface DockApiLike {
  readonly width: number;
  readonly panels: readonly DockPanelLike[];
  readonly activePanel?: DockPanelLike | undefined;
  getPanel(id: string): DockPanelLike | undefined;
  addPanel(options: DockAddPanelOptions): DockPanelLike;
}

export const viewPanelId = (id: PanelViewId) => `${VIEW_PANEL_PREFIX}${id}`;
export const isViewPanelId = (panelId: string) => panelId.startsWith(VIEW_PANEL_PREFIX);
export const viewIdOfPanel = (panelId: string): PanelViewId | undefined =>
  isViewPanelId(panelId) ? parsePanelViewId(panelId.slice(VIEW_PANEL_PREFIX.length)) : undefined;

export type OpenViewPanelOptions = {
  /** Tab title; defaults to the registry title. Pass the worker or finding name for per-entity views. */
  title?: string;
  /** Focus the panel (default true). */
  activate?: boolean;
  /** Dockview panel the right group is created next to (default `chat`). */
  anchorPanelId?: string;
  /** Stack under the anchor instead of splitting (narrow viewports). */
  compact?: boolean;
};

/** Panels currently holding a view, in dock order. */
export const listViewPanels = (api: Pick<DockApiLike, "panels">) => api.panels.filter(panel => isViewPanelId(panel.id));

/**
 * Open (or focus) a view in the right group. The first open creates the group at 62/38; later opens join
 * the existing group as a new tab. Returns the panel.
 */
export function openViewPanel(api: DockApiLike, id: PanelViewId, options: OpenViewPanelOptions = {}): DockPanelLike {
  const activate = options.activate !== false;
  const existing = api.getPanel(viewPanelId(id));
  if (existing) {
    if (activate) existing.api.setActive();
    return existing;
  }
  const sibling = listViewPanels(api)[0];
  const title = options.title ?? viewTitle(id);
  const base = { id: viewPanelId(id), title, component: PANEL_VIEW_COMPONENT, tabComponent: "tab", renderer: "onlyWhenVisible" as const, params: { viewId: id }, minimumWidth: RIGHT_GROUP_MIN_WIDTH, inactive: !activate };
  const panel = api.addPanel({
    ...base,
    position: sibling
      ? { referenceGroup: sibling.group.id, direction: "within" }
      : { referencePanel: options.anchorPanelId ?? "chat", direction: options.compact ? "within" : "right" },
  });
  if (!sibling && !options.compact && api.width > 0) panel.group.api.setSize({ width: Math.max(RIGHT_GROUP_MIN_WIDTH, Math.round(api.width * RIGHT_GROUP_RATIO)) });
  return panel;
}

/** Focus an open view; returns false when it is not open. */
export function focusViewPanel(api: DockApiLike, id: PanelViewId): boolean {
  const panel = api.getPanel(viewPanelId(id));
  panel?.api.setActive();
  return Boolean(panel);
}

/** Close a view tab. Overview is permanent; returns whether a panel was closed. */
export function closeViewPanel(api: DockApiLike, id: PanelViewId): boolean {
  if (id === "overview") return false;
  const panel = api.getPanel(viewPanelId(id));
  panel?.api.close();
  return Boolean(panel);
}

/** Toggle the whole right panel: close all view tabs, or reopen `fallback` (default Overview). */
export function toggleViewPanels(api: DockApiLike, saved?: PersistedPanelViews, options?: OpenViewPanelOptions): boolean {
  const open = listViewPanels(api);
  if (open.length) { for (const panel of [...open]) panel.api.close(); return false; }
  restoreViewPanels(api, saved && saved.views.length ? saved : { views: ["overview"], active: "overview" }, options);
  return true;
}

export const isViewOpen = (api: Pick<DockApiLike, "getPanel">, id: PanelViewId) => Boolean(api.getPanel(viewPanelId(id)));

/** Per-chat persisted shape: which views are open and which one is active. */
export type PersistedPanelViews = { views: PanelViewId[]; active?: PanelViewId };

export function snapshotViewPanels(api: Pick<DockApiLike, "panels" | "activePanel">): PersistedPanelViews {
  const views = listViewPanels(api).flatMap(panel => viewIdOfPanel(panel.id) ?? []);
  const active = api.activePanel && viewIdOfPanel(api.activePanel.id);
  return { views, active: active && views.includes(active) ? active : undefined };
}

/** Validate untrusted saved state: unknown ids dropped, duplicates removed. */
export function normalizePersistedViews(value: unknown): PersistedPanelViews {
  const raw = value && typeof value === "object" ? value as { views?: unknown; active?: unknown } : {};
  const views = [...new Set(Array.isArray(raw.views) ? raw.views.flatMap(item => parsePanelViewId(item) ?? []) : [])];
  const active = parsePanelViewId(raw.active);
  return { views, active: active && views.includes(active) ? active : undefined };
}

/**
 * Re-open saved views. `titles` supplies tab names for per-entity views (workers, findings); entities
 * whose title is unknown are skipped when `dropUnknownEntities` is set so stale workers do not reappear.
 */
export function restoreViewPanels(api: DockApiLike, saved: PersistedPanelViews, options: OpenViewPanelOptions & { titles?: Record<string, string>; dropUnknownEntities?: boolean } = {}): void {
  const { titles, dropUnknownEntities, ...open } = options;
  for (const id of saved.views) {
    if (dropUnknownEntities && panelViewKind(id) !== id && !titles?.[id]) continue;
    openViewPanel(api, id, { ...open, title: titles?.[id] ?? open.title, activate: false });
  }
  if (saved.active) focusViewPanel(api, saved.active);
}
