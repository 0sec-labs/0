import { createContext, useContext, type ReactNode } from "react";
import { AgentViewActionsProvider, AgentsView, type AgentViewActions } from "./views/agents";
import { AgentDetailView } from "./views/agent-detail";
import { BrowserView } from "./views/browser";
import { EvidenceView } from "./views/evidence";
import { FindingActionsProvider, type FindingActions } from "./views/finding-actions";
import { FindingDetailView } from "./views/finding-detail";
import { FindingsView } from "./views/findings";
import { FixesView } from "./views/fixes";
import { OverviewView } from "./views/overview";
import { VisualsView } from "./views/visuals";
import { PreviewView } from "./views/preview";
import { HarnessActionsProvider, ToolsView, type HarnessActions } from "./views/tools";
import type { PanelViewComponent } from "./types";
import type { PanelViewComponents } from "./panel-view-host";

/**
 * What the chat that owns the right panel hands to its views. Dockview renders every panel in the root's React tree,
 * so views would otherwise see the wrong backend and handlers when a docked chat on another computer is focused.
 */
export type PanelScope = {
  /** Re-provides the owning chat's backend contexts around a view. */
  bind: (node: ReactNode) => ReactNode;
  findingActions: FindingActions;
  agentActions: AgentViewActions;
  harnessActions: HarnessActions;
};
const PanelScopeContext = createContext<PanelScope | undefined>(undefined);
export function PanelScopeProvider({ scope, children }: { scope: PanelScope | undefined; children: ReactNode }) {
  return <PanelScopeContext.Provider value={scope}>{children}</PanelScopeContext.Provider>;
}

function scoped(View: PanelViewComponent): PanelViewComponent {
  return function ScopedView(props) {
    const scope = useContext(PanelScopeContext);
    const node = <FindingActionsProvider value={scope?.findingActions ?? {}}>
      <AgentViewActionsProvider value={scope?.agentActions ?? {}}>
        <HarnessActionsProvider value={scope?.harnessActions ?? {}}><View {...props} /></HarnessActionsProvider>
      </AgentViewActionsProvider>
    </FindingActionsProvider>;
    return <>{scope ? scope.bind(node) : node}</>;
  };
}

/** Module-level so identities are stable across renders. `report` has no view yet and shows the placeholder. */
export const panelViewComponents: PanelViewComponents = {
  overview: scoped(OverviewView),
  findings: scoped(FindingsView),
  finding: scoped(FindingDetailView),
  evidence: scoped(EvidenceView),
  fixes: scoped(FixesView),
  browser: scoped(BrowserView),
  visuals: scoped(VisualsView),
  preview: scoped(PreviewView),
  agents: scoped(AgentsView),
  agent: scoped(AgentDetailView),
  tools: scoped(ToolsView),
};
