import { describe, expect, it } from "vitest";
import { AGENT_ROW_CAP, buildViewMenu, flattenMenuRows, handleMenuKey, moveHighlight } from "../src/console/panel/view-menu-model";
import type { PanelAgentSummary } from "../src/console/panel/types";

const agents = (count: number): PanelAgentSummary[] => Array.from({ length: count }, (_, i) => ({ id: `w${i + 1}`, name: `Agent ${i + 1}`, task: i === 2 ? "probe the login form" : `task ${i + 1}`, status: "running" as const }));
const ids = (sections: ReturnType<typeof buildViewMenu>) => flattenMenuRows(sections).map(row => row.kind === "show-all" ? "show-all" : row.id);

describe("view menu model", () => {
  it("always lists overview, findings and browser; hides empty data views", () => {
    expect(ids(buildViewMenu({}))).toEqual(["overview", "findings", "browser"]);
  });
  it("shows data views once they have a count and carries badges", () => {
    const sections = buildViewMenu({ counts: { evidence: 7, fixes: 0, report: 1, tools: "2 tools" } });
    expect(ids(sections)).toEqual(["overview", "findings", "evidence", "browser", "report", "tools"]);
    const tools = flattenMenuRows(sections).find(row => row.kind === "view" && row.id === "tools");
    expect(tools && tools.kind === "view" && tools.badge).toBe("2 tools");
  });
  it("filters views by title and keywords", () => {
    expect(ids(buildViewMenu({ query: "browser" }))).toEqual(["browser"]);
    expect(ids(buildViewMenu({ query: "triage" }))).toEqual(["findings"]);
    expect(buildViewMenu({ query: "zzz" })).toEqual([]);
  });
  it("adds an Agents section, caps it and searches name and task", () => {
    const capped = buildViewMenu({ agents: agents(10) });
    expect(capped.map(section => section.label)).toEqual(["Views", "Agents"]);
    const rows = capped[1]!.rows;
    expect(rows).toHaveLength(AGENT_ROW_CAP + 1);
    expect(rows.at(-1)).toEqual({ kind: "show-all", hidden: 2 });
    expect(buildViewMenu({ agents: agents(10), showAllAgents: true })[1]!.rows).toHaveLength(10);
    expect(ids(buildViewMenu({ agents: agents(10), query: "login" }))).toEqual(["agent:w3"]);
    expect(ids(buildViewMenu({ agents: agents(10), query: "agent 10" }))).toEqual(["agent:w10"]);
  });
  it("omits the agents section without workers", () => {
    expect(buildViewMenu({ agents: [] }).map(section => section.label)).toEqual(["Views"]);
  });
});

describe("view menu keyboard", () => {
  const rows = flattenMenuRows(buildViewMenu({}));
  it("wraps highlight movement", () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
  it("arrows move, Enter selects highlighted or first row, others pass through", () => {
    expect(handleMenuKey("ArrowDown", -1, rows)).toEqual({ highlight: 0 });
    expect(handleMenuKey("ArrowUp", 0, rows)).toEqual({ highlight: rows.length - 1 });
    expect(handleMenuKey("Enter", 1, rows)?.select).toBe(rows[1]);
    expect(handleMenuKey("Enter", -1, rows)?.select).toBe(rows[0]);
    expect(handleMenuKey("Enter", -1, [])?.select).toBeUndefined();
    expect(handleMenuKey("a", 0, rows)).toBeUndefined();
  });
});
