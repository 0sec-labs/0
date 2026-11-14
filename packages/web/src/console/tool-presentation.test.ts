import { describe, expect, it } from "vitest";
import { presentToolCall } from "./tool-presentation";

describe("saved visualize calls", () => {
  it("presents a one-line title and the summary instead of the spec JSON", () => {
    const view = presentToolCall({ id: "t1", name: "visualize", arguments: { kind: "graph", title: "Attack path", summary: "3 nodes", spec: { nodes: [] } }, result: undefined } as never);
    expect(view.title).toBe("Visualization: Attack path");
    expect(view.output).toBe("3 nodes");
    expect(view.outputKind).toBe("text");
  });
});
