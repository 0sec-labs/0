import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, exportSecurityWorkflowCode, parseSecurityWorkflowCode, parseSecurityWorkflowInput, SecurityWorkflowBindingsSchema } from "./security-workflows.js";
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
  it("preserves pinned template provenance while rejecting malformed pins", () => {
    const template = { id: "repository-review", revision: 1 };
    const parsed = parseSecurityWorkflowInput({ ...draft(), template });
    expect(parsed.template).toEqual(template);
    expect(parseSecurityWorkflowCode(exportSecurityWorkflowCode(parsed)).template).toEqual(template);
    for (const invalid of [{ id: "repository-review", revision: 0 }, { id: "../escape", revision: 1 }, { ...template, command: "bash" }]) {
      expect(() => parseSecurityWorkflowInput({ ...draft(), template: invalid })).toThrow();
    }
    expect(parseSecurityWorkflowInput(draft()).template).toBeUndefined();
  });
  it("rejects arbitrary executors and plans exceeding actual launch bounds", () => {
    expect(() => parseSecurityWorkflowInput({ ...draft(), command: "curl" })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => ({ ...node, id: "__proto__" })) })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: [{ ...draft().nodes[0], plan: DEFAULT_SECURITY_WORKFLOW_PLAN }, ...draft().nodes.slice(1)] })).toThrow();
    for (const limits of [{ costCapUsd: Infinity }, { costCapUsd: 1001 }, { timeCapMs: 1.5 }, { timeCapMs: 0 }, { runCount: 17 }]) {
      expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN, ...limits } } : node) })).toThrow();
    }
  });
});


describe("portable security workflow JSON and phase policies", () => {
  it("round-trips execution policy without transferring saved identity or approvals", () => {
    const source = { ...draft(), id: "stored-identity", revision: 9, createdAt: "2026-01-01", updatedAt: "2026-02-01", nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, execution: { instructions: "Inspect authentication", allowedAgentTools: [] } } : node) };
    const exported = JSON.parse(exportSecurityWorkflowCode(source));
    expect(exported.schemaVersion).toBe(1);
    expect(exported.workflow).not.toHaveProperty("id"); expect(exported.workflow).not.toHaveProperty("revision"); expect(exported.workflow).not.toHaveProperty("createdAt");
    const imported = parseSecurityWorkflowCode(JSON.stringify(exported));
    expect(imported.nodes[1]?.execution).toEqual({ instructions: "Inspect authentication", allowedAgentTools: [] });
    const clone = parseSecurityWorkflowCode({ schemaVersion: 1, workflow: source });
    expect(clone).not.toHaveProperty("id"); expect(clone).not.toHaveProperty("revision");
  });
  it("rejects unknown code versions, executors, and malformed phase restrictions", () => {
    expect(() => parseSecurityWorkflowCode({ schemaVersion: 2, workflow: draft() })).toThrow();
    expect(() => parseSecurityWorkflowCode({ schemaVersion: 1, script: "process.exit()", workflow: draft() })).toThrow();
    for (const execution of [{ instructions: "x", command: "bash" }, { instructions: "x".repeat(16001) }, { instructions: "x", allowedAgentTools: ["http_request", "http_request"] }, { instructions: "x", allowedAgentTools: ["shell --anything"] }, { instructions: "x", allowedAgentTools: Array.from({ length: 129 }, (_, index) => `tool_${index}`) }]) {
      expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, execution } : node) })).toThrow();
    }
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "trigger" ? { ...node, execution: { instructions: "x" } } : node) })).toThrow();
    expect(() => parseSecurityWorkflowCode(" ".repeat(65537))).toThrow(/64 KiB/);
  });
  it("preserves inheriting and explicit-empty tool policies as different states", () => {
    const parsed = parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, execution: { instructions: "x", allowedAgentTools: ["mcp.server:query", "custom-tool"] } } : node) });
    expect(parsed.nodes[1]?.execution?.allowedAgentTools).toEqual(["mcp.server:query", "custom-tool"]);
    expect(parseSecurityWorkflowInput(draft()).nodes[1]?.execution).toBeUndefined();
  });
});


describe("typed workflow operations and bindings", () => {
  it.each(["verify", "fix", "research", "deep-review"])("accepts a standalone %s operation with bounded defaults", type => {
    const value = { ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, type, inputs: { runner: "local", options: { count: 2 } } } : node) };
    const parsed = parseSecurityWorkflowInput(value);
    expect(parsed.nodes[1]?.plan).toEqual(DEFAULT_SECURITY_WORKFLOW_PLAN);
    expect(parsed.nodes[1]?.fix).toEqual(type === "fix" ? { mode: "candidate" } : undefined);
    expect(parseSecurityWorkflowCode(exportSecurityWorkflowCode(parsed))).toEqual(parsed);
  });
  it("binds finding evidence only from connected executable predecessors", () => {
    const value = draft();
    value.nodes.splice(2, 0, { id: "verify", type: "verify", label: "Verify", enabled: true });
    value.edges = [{ source: "start", target: "audit" }, { source: "audit", target: "verify" }, { source: "verify", target: "report" }];
    const withBinding = (fromStep: string) => ({ ...value, nodes: value.nodes.map(node => node.id === "verify" ? { ...node, input: { fromStep, findingId: "finding_1" } } : node) });
    expect(parseSecurityWorkflowInput(withBinding("audit")).nodes[2]?.input).toEqual({ fromStep: "audit", findingId: "finding_1" });
    for (const fromStep of ["missing", "verify", "report", "start"]) expect(() => parseSecurityWorkflowInput(withBinding(fromStep))).toThrow(/preceding executable/);
    const sibling = withBinding("audit");
    sibling.edges = [{ source: "start", target: "audit" }, { source: "start", target: "verify" }, { source: "audit", target: "report" }, { source: "verify", target: "report" }];
    expect(() => parseSecurityWorkflowInput(sibling)).toThrow(/preceding executable/);
  });
  it.each(["__proto__", "constructor", "prototype"])("rejects raw reserved input key %s before record parsing", key => {
    for (const source of [`{"${key}":{}}`, `{"nested":{"${key}":{}}}`]) {
      const inputs = JSON.parse(source);
      expect(() => SecurityWorkflowBindingsSchema.parse(inputs)).toThrow(/Reserved workflow input key/);
      expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, inputs } : node) })).toThrow(/Reserved workflow input key/);
    }
    expect(SecurityWorkflowBindingsSchema.parse({ nested: { safe: true } })).toEqual({ nested: { safe: true } });
  });
  it("rejects nonportable inputs, credentials, and saved authorization grants", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const badInputs = [{ value: Infinity }, { value: undefined }, { value: () => {} }, { value: new Date() }, cycle, { approval: "apply-to-repository" }, { nested: { allowApply: true } }, { applyApproval: { candidateId: "candidate" } }, { secrets: {} }, { apiKey: "credential" }, { value: "x".repeat(32769) }];
    for (const inputs of badInputs) expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, inputs } : node) })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "trigger" ? { ...node, inputs: {} } : node) })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, fix: { mode: "apply" } } : node) })).toThrow(/Only fix/);
  });
});
