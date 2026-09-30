import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, parseSecurityWorkflowInput } from "./security-workflows.js";
const draft = () => ({ name: "Review repository", instructions: "Review dependencies", target: "", nodes: [{ id: "start", type: "trigger", label: "Manual", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }, { id: "report", type: "report", label: "Report", enabled: true }], edges: [{ source: "start", target: "audit" }, { source: "audit", target: "report" }] });
describe("security workflow definition validation", () => {
  it("accepts a draft without authorization target and supplies independent finite audit limits", () => {
    const parsed = parseSecurityWorkflowInput(draft());
    expect(parsed.target).toBe(""); expect(parsed.nodes[1]?.plan).toEqual(DEFAULT_SECURITY_WORKFLOW_PLAN);
    parsed.nodes[1]!.plan!.costCapUsd = 7;
    expect(DEFAULT_SECURITY_WORKFLOW_PLAN.costCapUsd).toBe(5);
  });
  it.each([
    ["cycle", (value: ReturnType<typeof draft>) => { value.edges.push({ source: "audit", target: "start" }); }],
    ["disconnected audit", (value: ReturnType<typeof draft>) => { value.nodes.push({ id: "other", type: "audit", label: "Other", enabled: true }); }],
    ["duplicate IDs", (value: ReturnType<typeof draft>) => { value.nodes[1]!.id = "start"; }],
    ["unknown edge", (value: ReturnType<typeof draft>) => { value.edges[0]!.target = "missing"; }],
    ["report not terminal", (value: ReturnType<typeof draft>) => { value.edges.push({ source: "report", target: "audit" }); }],
    ["multiple triggers", (value: ReturnType<typeof draft>) => { value.nodes[1]!.type = "trigger"; }],
  ] as const)("rejects %s", (_name, change) => { const value = draft(); change(value); expect(() => parseSecurityWorkflowInput(value)).toThrow(); });
  it("rejects arbitrary executors and plans exceeding actual launch bounds", () => {
    expect(() => parseSecurityWorkflowInput({ ...draft(), command: "curl" })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => ({ ...node, id: "__proto__" })) })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: [{ ...draft().nodes[0], plan: DEFAULT_SECURITY_WORKFLOW_PLAN }, ...draft().nodes.slice(1)] })).toThrow();
    for (const limits of [{ costCapUsd: Infinity }, { costCapUsd: 1001 }, { timeCapMs: 1.5 }, { timeCapMs: 0 }, { runCount: 17 }]) {
      expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN, ...limits } } : node) })).toThrow();
    }
  });
});
