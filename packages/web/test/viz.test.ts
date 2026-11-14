import { describe, expect, it } from "vitest";
import { assignLayers, layoutGraph } from "../src/console/viz/layout";
import { niceTicks, pieSlices, yDomain } from "../src/console/viz/chart-model";
import { cleanText, parseVizFence, validateViz, vizKindForFence, VIZ_LIMITS } from "../src/console/viz/parse";
import { specToText, tableToCsv } from "../src/console/viz/export";
import { mermaidLabel } from "../src/console/formatted-code";

const graph = (extra: object = {}) => JSON.stringify({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B", severity: "HIGH" }, { id: "c" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "pivots" }], ...extra });

describe("fence registry", () => {
  it("maps fences to kinds and ignores lookalikes", () => {
    expect(vizKindForFence("attack-graph")).toBe("graph");
    expect(vizKindForFence("mermaid")).toBe("mermaid");
    expect(vizKindForFence("constructor")).toBeUndefined();
    expect(vizKindForFence("js")).toBeUndefined();
  });
});

describe("parseVizFence", () => {
  it("parses a graph and normalises fields", () => {
    const result = parseVizFence("graph", graph());
    expect(result.ok && result.spec.kind === "graph" && result.spec.nodes[1]).toMatchObject({ severity: "high" });
    expect(result.ok && result.spec.kind === "graph" && result.spec.nodes[2]!.label).toBe("c");
  });
  it("checks the size cap before parsing", () => {
    const huge = `{"nodes":"${"x".repeat(VIZ_LIMITS.sourceChars)}"}`;
    const original = JSON.parse;
    let parsed = false;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parsed = true; return original(...args); }) as typeof JSON.parse;
    try {
      expect(parseVizFence("graph", huge)).toMatchObject({ ok: false });
    } finally { JSON.parse = original; }
    expect(parsed).toBe(false);
  });
  it("rejects invalid json, unknown refs, duplicates and over-count graphs", () => {
    expect(parseVizFence("graph", "{nope")).toEqual({ ok: false, reason: "spec is not valid JSON" });
    expect(parseVizFence("graph", graph({ edges: [{ from: "a", to: "zzz" }] }))).toMatchObject({ ok: false });
    expect(parseVizFence("graph", JSON.stringify({ nodes: [{ id: "a" }, { id: "a" }] }))).toMatchObject({ ok: false });
    const nodes = Array.from({ length: VIZ_LIMITS.nodes + 1 }, (_, i) => ({ id: `n${i}` }));
    expect(parseVizFence("graph", JSON.stringify({ nodes }))).toMatchObject({ ok: false });
    const edges = Array.from({ length: VIZ_LIMITS.edges + 1 }, () => ({ from: "a", to: "a" }));
    expect(parseVizFence("graph", JSON.stringify({ nodes: [{ id: "a" }], edges }))).toMatchObject({ ok: false });
  });
  it("treats labels as inert text: strips control and bidi characters, clamps length", () => {
    expect(cleanText("a‮b\u0000c\nd", 50)).toBe("a b c d");
    expect(cleanText("x".repeat(100), 10)).toHaveLength(10);
    const result = parseVizFence("graph", JSON.stringify({ nodes: [{ id: "a", label: "<img src=x onerror=alert(1)>" }] }));
    expect(result.ok && result.spec.kind === "graph" && result.spec.nodes[0]!.label).toBe("<img src=x onerror=alert(1)>");
  });
  it("validates charts", () => {
    const ok = parseVizFence("chart", JSON.stringify({ type: "bar", categories: ["a", "b"], series: [{ name: "s", data: [1, 2] }] }));
    expect(ok.ok).toBe(true);
    expect(parseVizFence("chart", JSON.stringify({ type: "bar", categories: ["a"], series: [{ data: [1, 2] }] }))).toMatchObject({ ok: false });
    expect(parseVizFence("chart", JSON.stringify({ type: "pie", categories: ["a"], series: [{ data: [-1] }] }))).toMatchObject({ ok: false });
    expect(parseVizFence("chart", JSON.stringify({ type: "radar", categories: ["a"], series: [{ data: [1] }] }))).toMatchObject({ ok: false });
    expect(parseVizFence("chart", JSON.stringify({ type: "line", categories: ["a"], series: [{ data: ["1"] }] }))).toMatchObject({ ok: false });
  });
  it("validates timelines and tables, including array rows", () => {
    expect(parseVizFence("timeline", JSON.stringify({ events: [{ t: "10:00", label: "scan" }] })).ok).toBe(true);
    expect(parseVizFence("timeline", JSON.stringify({ events: [{ t: "10:00" }] }))).toMatchObject({ ok: false });
    const table = parseVizFence("table", JSON.stringify({ columns: ["id", { key: "n", label: "N", align: "right" }], rows: [[1, "x"], { id: 2, n: null }] }));
    expect(table.ok && table.spec.kind === "table" && table.spec.rows).toEqual([{ id: 1, n: "x" }, { id: 2, n: null }]);
    expect(parseVizFence("table", JSON.stringify({ columns: ["a", "a"] }))).toMatchObject({ ok: false });
    expect(parseVizFence("table", JSON.stringify({ columns: ["a"], rows: Array.from({ length: VIZ_LIMITS.rows + 1 }, () => [1]) }))).toMatchObject({ ok: false });
  });
  it("caps mermaid source and rejects unknown kinds", () => {
    expect(parseVizFence("mermaid", "graph TD; A-->B").ok).toBe(true);
    expect(parseVizFence("mermaid", "x".repeat(VIZ_LIMITS.mermaidChars + 1))).toMatchObject({ ok: false });
    expect(validateViz("html", {})).toMatchObject({ ok: false });
  });
});

describe("layoutGraph", () => {
  const spec = (edges: [string, string][], ids = ["a", "b", "c", "d"], direction: "LR" | "TB" = "LR") =>
    ({ direction, nodes: ids.map((id) => ({ id, label: id })), edges: edges.map(([from, to]) => ({ from, to })) });
  it("layers a DAG left to right without overlap", () => {
    const layout = layoutGraph(spec([["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]));
    const by = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(by.get("a")!.x).toBeLessThan(by.get("b")!.x);
    expect(by.get("b")!.x).toBeLessThan(by.get("d")!.x);
    expect(by.get("b")!.y).not.toBe(by.get("c")!.y);
    for (const n of layout.nodes) { expect(n.x + n.width).toBeLessThanOrEqual(layout.width); expect(n.y + n.height).toBeLessThanOrEqual(layout.height); }
  });
  it("lays out top to bottom", () => {
    const by = new Map(layoutGraph(spec([["a", "b"]], ["a", "b"], "TB")).nodes.map((n) => [n.id, n]));
    expect(by.get("a")!.y).toBeLessThan(by.get("b")!.y);
  });
  it("survives cycles, self loops and disconnected nodes", () => {
    const { layers, reversed } = assignLayers(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "c", to: "c" }]);
    expect(reversed.size).toBe(1);
    expect(layers.get("a")).not.toBe(layers.get("b"));
    const layout = layoutGraph(spec([["a", "b"], ["b", "a"], ["c", "c"]], ["a", "b", "c", "d"]));
    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges.every((e) => e.path.startsWith("M "))).toBe(true);
  });
  it("handles a 200-node chain without recursion limits", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `n${i}`);
    const layout = layoutGraph(spec(ids.slice(1).map((id, i) => [ids[i]!, id] as [string, string]), ids));
    expect(layout.nodes).toHaveLength(200);
  });
});

describe("chart model", () => {
  it("computes nice ticks and stacked domains", () => {
    const { ticks, min, max } = niceTicks(0, 97);
    expect(min).toBe(0);
    expect(max).toBeGreaterThanOrEqual(97);
    expect(ticks[0]).toBe(0);
    expect(yDomain({ chartType: "stacked", categories: ["a", "b"], series: [{ name: "x", data: [1, 5] }, { name: "y", data: [2, 1] }] })).toEqual({ min: 0, max: 6 });
    expect(niceTicks(5, 5).max).toBeGreaterThan(5);
  });
  it("builds pie slices that sum to 100%", () => {
    const slices = pieSlices(["a", "b", "c"], [1, 0, 3], 0, 0, 10);
    expect(slices).toHaveLength(2);
    expect(slices.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1);
    expect(pieSlices(["a"], [5], 0, 0, 10)[0]!.path).toContain("A 10 10");
    expect(pieSlices(["a"], [0], 0, 0, 10)).toEqual([]);
  });
});

describe("export helpers", () => {
  it("neutralises CSV formula injection and omits the kind from copied specs", () => {
    const csv = tableToCsv({ kind: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: "=HYPERLINK(\"x\")" }, { a: "ok, fine" }] });
    expect(csv).toBe("A\n\"'=HYPERLINK(\"\"x\"\")\"\n\"ok, fine\"");
    const parsed = validateViz("timeline", { events: [{ t: "1", label: "x" }] });
    expect(parsed.ok && JSON.parse(specToText(parsed.spec)).kind).toBeUndefined();
  });
});

describe("mermaidLabel", () => {
  it("describes the diagram type and prefers accessible titles", () => {
    expect(mermaidLabel("sequenceDiagram\n A->>B: hi")).toBe("Mermaid sequence diagram. 2 lines of diagram source");
    expect(mermaidLabel("flowchart TD\n accTitle: Attack path\n accDescr: from web to db\n A-->B")).toBe("Attack path. from web to db");
  });
});
