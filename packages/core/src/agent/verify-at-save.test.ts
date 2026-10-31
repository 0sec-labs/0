import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, autoVerificationSpec } from "./tools.js";
import type { ToolContext } from "./types.js";
import type { Finding } from "@0/shared";

/**
 * Saving a finding checks cited source evidence without hidden inference.
 * Findings without a verificationSpec use conservative harness-built predicates;
 * fabricated quotes remain `needs_verify`. Business impact is retained only
 * when explicitly provided, rather than inferred during the evidence save.
 */
describe("save_finding harness re-verification", () => {
  let root: string;
  let ctx: ToolContext;
  let executor: ToolExecutor;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "0-verify-save-"));
    ctx = {
      target: "https://example.com",
      scanId: "verify-save-scan",
      findings: [],
      attackResults: [],
      targetInfo: {},
      scopePath: root,
    };
    executor = new ToolExecutor(ctx, null);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const baseFinding = (over: Partial<Finding> = {}): Record<string, unknown> => ({
    title: "Hardcoded comparison bypass in auth helper",
    description: "Auth helper compares secrets without a timing-safe comparison.",
    severity: "high",
    category: "other",
    evidence_request: "GET /api/test",
    evidence_response: `const secret = user.apiKey;\nif (secret === expected) { grant(); }`,
    poc_steps: "1. call the endpoint",
    ...over,
  });

  it("downgrades a finding whose quoted evidence is absent from the cited file", async () => {
    // The file exists but does NOT contain the quoted line — the agent's
    // evidence is fabricated or stale.
    mkdirSync(join(root, "app", "api", "helpers"), { recursive: true });
    writeFileSync(join(root, "app", "api", "helpers", "authHelper.ts"), "export const x = 1;\n");
    const result = await executor.execute({
      name: "save_finding",
      arguments: {
        ...baseFinding(),
        source_path: "app/api/helpers/authHelper.ts",
        source_start_line: 1,
      },
    });
    expect(result.success).toBe(true);
    const saved = ctx.findings[0]!;
    expect(saved.sourceVerification?.status).toBe("not_confirmed");
    expect(saved.publishability).toBe("needs_verify");
  });

  it("confirms a finding whose quoted evidence exists in the cited file", async () => {
    mkdirSync(join(root, "app", "api", "helpers"), { recursive: true });
    writeFileSync(
      join(root, "app", "api", "helpers", "authHelper.ts"),
      "const secret = user.apiKey;\nif (secret === expected) { grant(); }\n",
    );
    const result = await executor.execute({
      name: "save_finding",
      arguments: {
        ...baseFinding(),
        source_path: "app/api/helpers/authHelper.ts",
        source_start_line: 2,
      },
    });
    expect(result.success).toBe(true);
    const saved = ctx.findings[0]!;
    expect(saved.sourceVerification?.status).toBe("matched");
    expect(saved.publishability).toBeUndefined();
  });

  it("leaves missing impact unassessed and makes no hidden model call", async () => {
    const executeNative = vi.fn(async () => { throw new Error("Unexpected unmetered inference"); });
    // Historical callers could supply this legacy property. Saving evidence
    // must never consume their planner runtime or create an unaccounted call.
    Object.assign(ctx, { runtime: { type: "api", executeNative } });
    const result = await executor.execute({
      name: "save_finding",
      arguments: { ...baseFinding() },
    });
    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
    expect(ctx.findings[0]!.impactAssessment).toBeUndefined();
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("retains an explicitly provided impact assessment without model inference", async () => {
    const executeNative = vi.fn();
    Object.assign(ctx, { runtime: { type: "api", executeNative } });
    const assessment = {
      reachability_tier: "remote-auth", blast_radius: "Authenticated customer records",
      weaponizability: "info-leak", business_impact: "notable", rationale: "A caller can read another customer's records.",
    };
    const result = await executor.execute({ name: "save_finding", arguments: {
      ...baseFinding(), impact_assessment: JSON.stringify(assessment),
    } });
    expect(result.success).toBe(true);
    expect(ctx.findings[0]!.impactAssessment).toEqual({ ...assessment, assessment_source: "provided" });
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("honors an agent-supplied verificationSpec over the harness-built one", async () => {
    mkdirSync(join(root, "app", "api", "helpers"), { recursive: true });
    writeFileSync(join(root, "app", "api", "helpers", "authHelper.ts"), "export const x = 1;\n");
    const result = await executor.execute({
      name: "save_finding",
      arguments: {
        ...baseFinding(),
        source_path: "app/api/helpers/authHelper.ts",
        source_start_line: 1,
        verification_spec: JSON.stringify({
          code: [{ kind: "file-contains", file: "app/api/helpers/authHelper.ts", pattern: "export const x = 1;" }],
        }),
      },
    });
    expect(result.success).toBe(true);
    const saved = ctx.findings[0]!;
    // The agent's own predicate matched the file content: no needs_verify.
    expect(saved.sourceVerification?.status).toBe("matched");
  });
});

describe("autoVerificationSpec", () => {
  it("extracts cited source paths and quotable code lines", () => {
    const spec = autoVerificationSpec({
      id: "f1",
      title: "t",
      description: "app/api/helpers/skillHelper.ts runs doc(skillId).set(skill) with no ownership check — see the route.",
      severity: "medium",
      category: "other",
      status: "discovered",
      evidence: { request: "req", response: "resp", poc_steps: [] },
    } as unknown as Finding);
    expect(spec).not.toBeNull();
    expect(spec!.code.length).toBeGreaterThan(0);
    expect(spec!.code.every((p) => p.kind === "file-contains")).toBe(true);
    expect(spec!.code.some((p) => p.file === "app/api/helpers/skillHelper.ts")).toBe(true);
  });

  it("returns null when the finding cites no source paths", () => {
    const spec = autoVerificationSpec({
      id: "f2",
      title: "t",
      description: "No file references here at all.",
      severity: "low",
      category: "other",
      status: "discovered",
      evidence: { request: "GET /", response: "200", poc_steps: [] },
    } as unknown as Finding);
    expect(spec).toBeNull();
  });
});
