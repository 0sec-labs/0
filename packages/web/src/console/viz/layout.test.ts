import { describe, expect, it } from "vitest";
import { MAX_ASPECT, layoutGraph } from "./layout";

const chain = (n: number, direction: "LR" | "TB" = "LR") => ({
  direction,
  nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` })),
  edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
}) as never;

describe("layoutGraph bounds", () => {
  it("keeps a 200-node chain near a readable aspect ratio in both directions", () => {
    for (const direction of ["LR", "TB"] as const) {
      const layout = layoutGraph(chain(200, direction));
      expect(layout.nodes).toHaveLength(200);
      expect(Math.max(layout.width / layout.height, layout.height / layout.width)).toBeLessThanOrEqual(MAX_ASPECT + 0.5);
      for (const node of layout.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
        expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
      }
    }
  });
  it("does not wrap short graphs and never overlaps nodes", () => {
    const short = layoutGraph(chain(4));
    expect(new Set(short.nodes.map(node => node.band)).size).toBe(1);
    const long = layoutGraph(chain(60));
    for (let i = 0; i < long.nodes.length; i++) for (let j = i + 1; j < long.nodes.length; j++) {
      const a = long.nodes[i]!, b = long.nodes[j]!;
      expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
    }
  });
});
