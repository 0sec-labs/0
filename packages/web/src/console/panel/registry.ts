import { CapyAttachIcon, CapyDocumentIcon, CapyEyeIcon, CapyGlobeIcon, CapyIssueDashedIcon, CapyPresentationIcon, CapyPullRequestIcon, CapySubagentsIcon, CapyTerminalSparkleIcon, CapyThreadListIcon, type IconComponent } from "@/ui/icons/capy";
import { agentViewId, panelViewKind, panelViewEntity, STATIC_VIEW_IDS, type PanelAgentSummary, type PanelViewId, type PanelViewKind, type StaticViewId } from "./types";

/** `mod` is Cmd on macOS and Ctrl elsewhere; `shift` is always Shift. Keys are lowercase `KeyboardEvent.key` values. */
export type ViewShortcut = { key: string; mod: true; shift: boolean };

export type PanelView = {
  id: StaticViewId;
  title: string;
  icon: IconComponent;
  /** Always shown in the `+` menu even when it has no backing data (their empty states are informative). */
  alwaysListed: boolean;
  /** Opened by default in the right group on first open. */
  closable: boolean;
  shortcut?: ViewShortcut;
  /** Extra search terms. */
  keywords: readonly string[];
};

const shortcut = (key: string): ViewShortcut => ({ key, mod: true, shift: true });

export const panelViewRegistry: Record<StaticViewId, PanelView> = {
  overview: { id: "overview", title: "Overview", icon: CapyThreadListIcon, alwaysListed: true, closable: false, keywords: ["summary", "status", "plan", "target"] },
  findings: { id: "findings", title: "Findings", icon: CapyIssueDashedIcon, alwaysListed: true, closable: true, shortcut: shortcut("f"), keywords: ["vulnerabilities", "issues", "triage"] },
  evidence: { id: "evidence", title: "Evidence", icon: CapyAttachIcon, alwaysListed: false, closable: true, shortcut: shortcut("e"), keywords: ["proof", "request", "response", "screenshots"] },
  fixes: { id: "fixes", title: "Fixes", icon: CapyPullRequestIcon, alwaysListed: false, closable: true, shortcut: shortcut("g"), keywords: ["diff", "patch", "pull request", "pr"] },
  browser: { id: "browser", title: "Browser", icon: CapyGlobeIcon, alwaysListed: true, closable: true, shortcut: shortcut("l"), keywords: ["live", "preview", "page"] },
  visuals: { id: "visuals", title: "Visuals", icon: CapyPresentationIcon, alwaysListed: false, closable: true, shortcut: shortcut("v"), keywords: ["diagram", "graph", "chart", "timeline", "attack path", "visualization"] },
  preview: { id: "preview", title: "Preview", icon: CapyEyeIcon, alwaysListed: false, closable: true, keywords: ["develop", "self-edit", "live preview", "dev server"] },
  report: { id: "report", title: "Report", icon: CapyDocumentIcon, alwaysListed: false, closable: true, keywords: ["export", "summary"] },
  agents: { id: "agents", title: "Agents", icon: CapySubagentsIcon, alwaysListed: false, closable: true, keywords: ["workers", "subagents", "swarm"] },
  tools: { id: "tools", title: "Tools", icon: CapyTerminalSparkleIcon, alwaysListed: false, closable: true, keywords: ["available tools", "catalog"] },
};
export const panelViews: readonly PanelView[] = STATIC_VIEW_IDS.map(id => panelViewRegistry[id]);

/** Menu order for the Views section (agents are a separate section; `agents` itself is the section header link). */
export const VIEW_MENU_ORDER: readonly StaticViewId[] = ["overview", "findings", "evidence", "fixes", "browser", "visuals", "preview", "report", "tools"];

/** The view definition behind any id; per-entity ids reuse their parent kind's icon. */
export function viewDefinition(id: PanelViewId): PanelView {
  const kind: PanelViewKind = panelViewKind(id);
  if (kind === "agent") return panelViewRegistry.agents;
  if (kind === "finding") return { ...panelViewRegistry.findings, id: "findings", shortcut: undefined };
  return panelViewRegistry[kind];
}

/** Tab title. Per-entity views need a caller-provided label; this falls back to a readable default. */
export function viewTitle(id: PanelViewId, label?: string): string {
  const kind = panelViewKind(id);
  if (kind === "agent") return `Agent: ${label ?? panelViewEntity(id) ?? ""}`.trim();
  if (kind === "finding") return `Finding: ${label ?? panelViewEntity(id) ?? ""}`.trim();
  return panelViewRegistry[kind].title;
}

export function agentTitle(agent: Pick<PanelAgentSummary, "id" | "name">): string {
  return viewTitle(agentViewId(agent.id), agent.name || agent.id);
}

/** Group of shortcut rows (command + keys) for a settings list, so the shortcuts page can merge them. */
export function panelShortcutRows(mod: string, shift: string): { command: string; keys: string[]; when: string }[] {
  return [
    { command: "Toggle right panel", keys: [shift, mod, "B"], when: "Chat workspace" },
    ...panelViews.filter(view => view.shortcut).map(view => ({ command: `Open ${view.title}`, keys: [shift, mod, view.shortcut!.key.toUpperCase()], when: "Chat workspace" })),
  ];
}
