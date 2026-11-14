import { describe, expect, it } from "vitest";
import {
  VISUALIZATION_LIMITS as L,
  plainTextProblem,
  validateVisualization,
  validateVisualizationInput,
} from "./visualization.js";

const base = { title: "T", summary: "S" };
const graph = {
  nodes: [{ id: "a", label: "A" }, { id: "b", label: "B", severity: "high" }],
  edges: [{ from: "a", to: "b", kind: "exploits" }],
};

describe("validateVisualizationInput", () => {
  it("accepts every kind and applies graph defaults", () => {
    const g = validateVisualizationInput({ kind: "attack-graph", ...base, spec: graph });
    expect(g.ok && (g.value.spec as { layout: string; direction: string })).toMatchObject({ layout: "layered", direction: "LR" });
    for (const [kind, spec] of [
      ["chart", { type: "bar", series: [{ name: "s", data: [{ x: "a", y: 1 }] }] }],
      ["timeline", { events: [{ t: "10:00", label: "x", severity: "low" }] }],
      ["table", { columns: [{ key: "k", label: "K" }], rows: [{ k: "v" }, { k: 2 }, { k: null }] }],
      ["mermaid", { source: "sequenceDiagram\n  A->>B: hi" }],
    ] as const) {
      expect(validateVisualizationInput({ kind, ...base, spec }).ok, kind).toBe(true);
    }
  });

  it("requires title and summary and rejects unknown envelope keys", () => {
    expect(validateVisualizationInput({ kind: "table", title: "T", spec: {} }).ok).toBe(false);
    expect(validateVisualizationInput({ kind: "graph", title: "", summary: "s", spec: graph }).ok).toBe(false);
    expect(validateVisualizationInput({ kind: "graph", ...base, spec: graph, url: "x" }).ok).toBe(false);
    expect(validateVisualizationInput({ kind: "nope", ...base, spec: graph }).ok).toBe(false);
  });

  it("strips unknown keys inside specs", () => {
    const r = validateVisualizationInput({ kind: "timeline", ...base, spec: { events: [{ t: "1", label: "x" }], onclick: "x" } });
    expect(r.ok && Object.keys(r.value.spec)).toEqual(["events"]);
  });

  it("enforces referential integrity", () => {
    const dup = validateVisualizationInput({ kind: "graph", ...base, spec: { nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }] } });
    expect(!dup.ok && dup.error).toMatch(/duplicate node id/);
    const dangling = validateVisualizationInput({ kind: "graph", ...base, spec: { ...graph, edges: [{ from: "a", to: "zzz" }] } });
    expect(!dangling.ok && dangling.error).toMatch(/edges\.0\.to/);
    const ref = validateVisualizationInput({ kind: "graph", ...base, spec: { nodes: [{ id: "a", label: "A", ref: { findingId: "f", file: "x" } }] } });
    expect(ref.ok).toBe(false);
    const bad = validateVisualizationInput({ kind: "graph", ...base, spec: { nodes: [{ id: "a", label: "A", ref: { url: "x" } }] } });
    expect(bad.ok).toBe(false);
  });

  it("enforces node, edge, row and byte caps", () => {
    const nodes = Array.from({ length: L.graphNodes + 1 }, (_, i) => ({ id: `n${i}`, label: "n" }));
    expect(validateVisualizationInput({ kind: "graph", ...base, spec: { nodes } }).ok).toBe(false);
    const ok = nodes.slice(0, L.graphNodes);
    const edges = Array.from({ length: L.graphEdges + 1 }, () => ({ from: "n0", to: "n1" }));
    expect(validateVisualizationInput({ kind: "graph", ...base, spec: { nodes: ok, edges } }).ok).toBe(false);
    const rows = Array.from({ length: L.tableRows + 1 }, () => ({ k: "v" }));
    expect(validateVisualizationInput({ kind: "table", ...base, spec: { columns: [{ key: "k", label: "K" }], rows } }).ok).toBe(false);
    const fat = Array.from({ length: 300 }, () => ({ k: "x".repeat(L.cell) }));
    const r = validateVisualizationInput({ kind: "table", ...base, spec: { columns: [{ key: "k", label: "K" }], rows: fat } });
    expect(!r.ok && r.error).toMatch(/bytes/);
  });

  it("rejects HTML, URLs, control and bidi characters in every text slot", () => {
    for (const bad of ["<img src=x onerror=1>", "a &lt;b", "see https://evil.test/x", "javascript:alert(1)", "data:text/html;base64,AAA", "x‮y", "a\u0000b", "go www.evil.test"]) {
      expect(plainTextProblem(bad), bad).not.toBeNull();
      expect(validateVisualizationInput({ kind: "graph", ...base, spec: { nodes: [{ id: "a", label: bad }] } }).ok, bad).toBe(false);
      expect(validateVisualizationInput({ kind: "graph", title: bad, summary: "s", spec: graph }).ok, bad).toBe(false);
      expect(validateVisualizationInput({ kind: "graph", title: "t", summary: bad, spec: graph }).ok, bad).toBe(false);
      expect(validateVisualizationInput({ kind: "table", ...base, spec: { columns: [{ key: "k", label: "K" }], rows: [{ k: bad }] } }).ok, bad).toBe(false);
      expect(validateVisualizationInput({ kind: "timeline", ...base, spec: { events: [{ t: "1", label: bad }] } }).ok, bad).toBe(false);
    }
    for (const fine of ["GET /api/users/{id}", "a < b", "metadata: ok", "10.0.0.1:8080", "Data: 5", "q=1&r=2"]) expect(plainTextProblem(fine), fine).toBeNull();
  });

  it("rejects dangerous mermaid constructs", () => {
    for (const source of ["---\ntitle: x\n---\nflowchart TD", "%%{init: {}}%%\nflowchart TD", "flowchart TD\n  A@{ shape: x }", "flowchart TD\n  click A callback", "flowchart TD\n  A[<b>x</b>]", "flowchart TD\n  A-->B\n  click A \"https://x\"", "x".repeat(L.mermaidBytes + 1)]) {
      expect(validateVisualizationInput({ kind: "mermaid", ...base, spec: { source } }).ok, source.slice(0, 20)).toBe(false);
    }
  });

  it("validates chart numbers and pie shape", () => {
    expect(validateVisualizationInput({ kind: "chart", ...base, spec: { type: "line", series: [{ name: "s", data: [{ x: 1, y: Infinity }] }] } }).ok).toBe(false);
    expect(validateVisualizationInput({ kind: "chart", ...base, spec: { type: "pie", series: [{ name: "a", data: [{ x: "x", y: 1 }] }, { name: "b", data: [{ x: "x", y: 1 }] }] } }).ok).toBe(false);
  });

  it("table cells must match declared columns", () => {
    const r = validateVisualizationInput({ kind: "table", ...base, spec: { columns: [{ key: "k", label: "K" }], rows: [{ other: 1 }] } });
    expect(!r.ok && r.error).toMatch(/no matching column/);
  });

  it("never throws on hostile input", () => {
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(validateVisualizationInput({ kind: "graph", ...base, spec: cyc }).ok).toBe(false);
    expect(validateVisualizationInput(null).ok).toBe(false);
    expect(validateVisualizationInput({ kind: "graph", ...base }).ok).toBe(false);
  });
});

describe("validateVisualization (persisted envelope)", () => {
  it("round-trips and rejects unknown versions", () => {
    const input = validateVisualizationInput({ kind: "chart", ...base, spec: { type: "bar", series: [{ name: "s", data: [{ x: "a", y: 1 }] }] } });
    if (!input.ok) throw new Error("fixture");
    const visual = { id: "viz-1", version: 1, createdAt: "2026-01-01T00:00:00Z", ...input.value };
    expect(validateVisualization(JSON.parse(JSON.stringify(visual))).ok).toBe(true);
    expect(validateVisualization({ ...visual, version: 2 }).ok).toBe(false);
    expect(validateVisualization({ ...visual, id: "a b" }).ok).toBe(false);
  });
});
