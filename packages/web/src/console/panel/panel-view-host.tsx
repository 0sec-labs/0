import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DockviewApi, IDockviewHeaderActionsProps, IDockviewPanelProps } from "dockview-react";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { agentTitle, viewDefinition, viewTitle } from "./registry";
import { closeViewPanel, isViewPanelId, listViewPanels, openViewPanel, viewIdOfPanel, type DockApiLike, type ViewPanelParams } from "./dock-views";
import { ViewMenu } from "./view-menu";
import { panelViewKind, type OpenViewOptions, type PanelAgentSummary, type PanelViewComponent, type PanelViewId, type PanelViewKind } from "./types";
import type { PanelViewCounts } from "./view-menu-model";

/** Compile-time proof that Dockview's real API satisfies the narrow interface the helpers use. */
const asDockApi = (api: DockviewApi): DockApiLike => api;

export type PanelViewComponents = Partial<Record<PanelViewKind, PanelViewComponent>>;

type PanelViewContextValue = {
  api: DockviewApi | undefined;
  snapshot: ConsoleSessionSnapshot | undefined;
  sessionId: string | undefined;
  backendId: string;
  busy: boolean;
  components: PanelViewComponents;
  title?: string;
  counts?: PanelViewCounts;
  agents?: readonly PanelAgentSummary[];
  openView: (id: PanelViewId, options?: OpenViewOptions) => void;
  closeView: (id: PanelViewId) => void;
};
const PanelViewContext = createContext<PanelViewContextValue | undefined>(undefined);

export type PanelViewProviderProps = Omit<PanelViewContextValue, "openView" | "closeView" | "components" | "busy"> & {
  /** Real view components by kind. Missing kinds render the placeholder. */
  components?: PanelViewComponents;
  busy?: boolean;
  /** Stack the right group under the chat (narrow viewports). */
  compact?: boolean;
  children: ReactNode;
};

/** Everything a view and the `+` menu need; WP6 mounts it once around DockviewReact. */
export function PanelViewProvider({ components = {}, busy = false, compact, children, ...value }: PanelViewProviderProps) {
  const { api, agents } = value;
  const openView = useCallback((id: PanelViewId, options?: OpenViewOptions) => {
    if (!api) return;
    const agent = panelViewKind(id) === "agent" ? agents?.find(item => `agent:${item.id}` === id) : undefined;
    openViewPanel(asDockApi(api), id, { compact, ...options, title: options?.title ?? (agent ? agentTitle(agent) : undefined) });
  }, [api, agents, compact]);
  const closeView = useCallback((id: PanelViewId) => { if (api) closeViewPanel(asDockApi(api), id); }, [api]);
  const memo = useMemo(() => ({ ...value, components, busy, openView, closeView }), [value.api, value.snapshot, value.sessionId, value.backendId, value.title, value.counts, value.agents, components, busy, openView, closeView]); // eslint-disable-line react-hooks/exhaustive-deps
  return <PanelViewContext.Provider value={memo}>{children}</PanelViewContext.Provider>;
}

export function usePanelViews(): PanelViewContextValue {
  const context = useContext(PanelViewContext);
  if (!context) throw new Error("usePanelViews must be used inside PanelViewProvider");
  return context;
}

/** The panel host when this component renders inside one (the dock), otherwise undefined. */
export function useOptionalPanelViews(): PanelViewContextValue | undefined {
  return useContext(PanelViewContext);
}

/** Ids of the views that currently have a tab; re-renders on dock changes. */
export function useOpenViewIds(api: DockviewApi | undefined): PanelViewId[] {
  const read = useCallback(() => (api ? listViewPanels(asDockApi(api)).flatMap(panel => viewIdOfPanel(panel.id) ?? []) : []), [api]);
  const [ids, setIds] = useState<PanelViewId[]>(read);
  useEffect(() => {
    setIds(read());
    if (!api) return;
    const update = () => setIds(previous => { const next = read(); return previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next; });
    const subs = [api.onDidAddPanel(update), api.onDidRemovePanel(update), api.onDidLayoutChange(update)];
    return () => subs.forEach(sub => sub.dispose());
  }, [api, read]);
  return ids;
}

/** Shown for views whose package has not landed yet (or an id with no registered component). */
export function PanelViewPlaceholder({ viewId }: { viewId: PanelViewId }) {
  const definition = viewDefinition(viewId);
  const Icon = definition.icon;
  return <div data-slot="panel-view-placeholder" className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center">
    <Icon aria-hidden="true" className="size-(--icon-lg) text-muted-foreground-3" />
    <p className="text-sm font-medium text-muted-foreground-1">{viewTitle(viewId)}</p>
    <p className="text-xs text-muted-foreground-2">This view is not available yet.</p>
  </div>;
}

/** Dockview panel body: registered under `PANEL_VIEW_COMPONENT`. */
export function PanelViewHost({ params }: IDockviewPanelProps<ViewPanelParams>) {
  const context = useContext(PanelViewContext);
  const viewId = params.viewId;
  const View = context?.components[panelViewKind(viewId)];
  return <div data-slot="panel-view" data-view={viewId} className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain scroll-fade-y bg-background">
    {context && View
      ? <View viewId={viewId} snapshot={context.snapshot} sessionId={context.sessionId} backendId={context.backendId} busy={context.busy} openView={context.openView} closeView={context.closeView} />
      : <PanelViewPlaceholder viewId={viewId} />}
  </div>;
}

/**
 * Dockview `rightHeaderActionsComponent` content: the `+` menu, shown only in groups that hold views.
 * Compose it inside the workspace's existing header actions.
 */
export function ViewMenuHeaderAction({ containerApi, group }: Pick<IDockviewHeaderActionsProps, "containerApi" | "group">) {
  const open = useOpenViewIds(containerApi);
  const [, bump] = useState(0);
  useEffect(() => { const sub = group.api.onDidActivePanelChange(() => bump(value => value + 1)); return () => sub.dispose(); }, [group]);
  if (!group.panels.some(panel => isViewPanelId(panel.id))) return null;
  return <ConnectedViewMenu open={open} />;
}

/** The `+` button wired to the provider: opens the chosen view in the right group. */
export function ConnectedViewMenu({ open }: { open?: readonly PanelViewId[] }) {
  const context = usePanelViews();
  const own = useOpenViewIds(open ? undefined : context.api);
  return <ViewMenu title={context.title} counts={context.counts} agents={context.agents} openViews={open ?? own} onSelect={id => context.openView(id)} />;
}
