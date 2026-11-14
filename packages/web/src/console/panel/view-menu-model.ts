import { VIEW_MENU_ORDER, panelViewRegistry, type PanelView } from "./registry";
import { agentViewId, type PanelAgentSummary, type PanelViewId, type StaticViewId } from "./types";

export const AGENT_ROW_CAP = 8;

/** Counts or labels shown right-aligned. `undefined` means no backing data (row hidden unless always listed). */
export type PanelViewCounts = Partial<Record<StaticViewId, number | string>>;

export type ViewMenuRow =
  | { kind: "view"; id: PanelViewId; view: PanelView; badge?: string }
  | { kind: "agent"; id: PanelViewId; agent: PanelAgentSummary }
  | { kind: "show-all"; hidden: number };
export type ViewMenuSection = { label: "Views" | "Agents"; rows: ViewMenuRow[] };

const matches = (query: string, ...parts: readonly (string | undefined)[]) => parts.some(part => part?.toLowerCase().includes(query));

function badgeFor(count: number | string | undefined): string | undefined {
  if (count === undefined || count === 0 || count === "") return undefined;
  return String(count);
}

/** Pure menu model: filtering, hide-when-empty, agent cap. Row order is the visual and keyboard order. */
export function buildViewMenu(input: { counts?: PanelViewCounts; agents?: readonly PanelAgentSummary[]; query?: string; showAllAgents?: boolean }): ViewMenuSection[] {
  const query = (input.query ?? "").trim().toLowerCase();
  const counts = input.counts ?? {};
  const viewRows: ViewMenuRow[] = [];
  for (const id of VIEW_MENU_ORDER) {
    const view = panelViewRegistry[id];
    const badge = badgeFor(counts[id]);
    const hasData = counts[id] !== undefined && counts[id] !== 0 && counts[id] !== "";
    if (!view.alwaysListed && !hasData) continue;
    if (query && !matches(query, view.title, ...view.keywords)) continue;
    viewRows.push({ kind: "view", id, view, badge });
  }
  const agents = (input.agents ?? []).filter(agent => !query || matches(query, agent.name, agent.task));
  const agentRows: ViewMenuRow[] = [];
  if (agents.length) {
    // While searching, show every match; the cap only keeps the idle menu short.
    const limit = query || input.showAllAgents ? agents.length : AGENT_ROW_CAP;
    for (const agent of agents.slice(0, limit)) agentRows.push({ kind: "agent", id: agentViewId(agent.id), agent });
    if (agents.length > limit) agentRows.push({ kind: "show-all", hidden: agents.length - limit });
  }
  const sections: ViewMenuSection[] = [];
  if (viewRows.length) sections.push({ label: "Views", rows: viewRows });
  if (agentRows.length) sections.push({ label: "Agents", rows: agentRows });
  return sections;
}

export const flattenMenuRows = (sections: readonly ViewMenuSection[]): ViewMenuRow[] => sections.flatMap(section => section.rows);

/** Wrap-around highlight movement; -1 means nothing highlighted yet. */
export function moveHighlight(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}

export type MenuKeyResult = { highlight: number; select?: ViewMenuRow };
/** Keyboard model for the search field: arrows move, Enter selects (first row when none is highlighted). */
export function handleMenuKey(key: string, highlight: number, rows: readonly ViewMenuRow[]): MenuKeyResult | undefined {
  if (key === "ArrowDown") return { highlight: moveHighlight(highlight, 1, rows.length) };
  if (key === "ArrowUp") return { highlight: moveHighlight(highlight, -1, rows.length) };
  if (key === "Home") return { highlight: rows.length ? 0 : -1 };
  if (key === "End") return { highlight: rows.length - 1 };
  if (key === "Enter") {
    const row = rows[highlight < 0 ? 0 : highlight];
    return { highlight, select: row };
  }
  return undefined;
}
