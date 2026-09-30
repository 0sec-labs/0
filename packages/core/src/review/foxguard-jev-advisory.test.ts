import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevEvaluator, JevEvaluationResult, SemgrepFinding } from "@0/shared"
import { assessFoxguardFindings } from "./foxguard-jev-advisory.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function source(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "foxguard-advice-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}
function finding(path: string, overrides: Partial<SemgrepFinding> = {}): SemgrepFinding {
  return { path, ruleId: "js/no-sql-injection", message: "Dynamic query", severity: "high", startLine: 1, endLine: 1, snippet: "", ...overrides };
}
function answer(choice: "actionable" | "false_positive", score = 0.9): JevEvaluationResult {
  return { model: "typesafe-ai/jev", answers: { finding: { type: "choice", choice, probabilities: { actionable: choice === "actionable" ? score : 1 - score, false_positive: choice === "false_positive" ? score : 1 - score } } }, usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.001 }, durationMs: 1 };
}

describe("Foxguard advisory triage", () => {
  it("keeps every original finding and severity while adding distinct non-authoritative assessments", async () => {
    const rootPath = source({ "wrapper.ts": "const launch = `exec ${review}`;\n", "query.ts": "db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);\n" });
    const findings = Object.freeze([
      Object.freeze(finding("wrapper.ts", { metadata: { privateContext: "DO_NOT_SEND_METADATA" } })),
      Object.freeze(finding("query.ts")),
    ]);
    const before = JSON.stringify(findings);
    const requests: string[] = [];
    const evaluator: JevEvaluator = { async evaluate(request) {
      requests.push(JSON.stringify(request.state));
      return requests.length === 1 ? answer("false_positive") : answer("actionable");
    } };
    const report = await assessFoxguardFindings({ findings, rootPath, evaluator });
    expect(report.advisoryOnly).toBe(true);
    expect(report.status).toBe("complete");
    expect(report.assessments.map(a => [a.findingIndex, a.disposition])).toEqual([[0, "possible_false_positive"], [1, "needs_review"]]);
    expect(JSON.stringify(findings)).toBe(before);
    expect(requests.join("\n")).not.toContain("DO_NOT_SEND_METADATA");
    expect(requests[0]).toContain("exec");
  });

  it("does not require readable source or dispatch when disabled or given a zero request allowance", async () => {
    const findings = [finding("absent.ts")];
    const rootPath = "/nonexistent-foxguard-disabled-root";
    const disabled = await assessFoxguardFindings({ findings, rootPath });
    expect(disabled.status).toBe("disabled");
    expect(disabled.assessments[0]?.reason).toBe("disabled");
    let dispatched = 0;
    const evaluator: JevEvaluator = { async evaluate() { dispatched++; return answer("false_positive"); } };
    const limited = await assessFoxguardFindings({ findings, rootPath, evaluator, maxCandidates: 0 });
    expect(dispatched).toBe(0);
    expect(limited.assessments[0]?.reason).toBe("limit");
    await expect(assessFoxguardFindings({ findings, rootPath, evaluator, maxCandidates: 51 })).rejects.toBeInstanceOf(RangeError);
  });

  it("withholds neighbors of later secret findings, aliases, sensitive files and symlink escapes", async () => {
    const rootPath = source({ "shared.ts": 'const password = "PUBLIC_SYNTHETIC_SECRET_MARKER";\n', ".env.production": "PRIVATE=synthetic\n" });
    const outside = source({ "outside.ts": "PRIVATE_OUTSIDE_SCOPE\n" });
    symlinkSync(join(outside, "outside.ts"), join(rootPath, "escape.ts"));
    const findings = [finding("shared.ts"), finding("escape.ts"), finding(".env.production"), finding("./shared.ts", { ruleId: "js/no-hardcoded-secret" })];
    let dispatched = 0;
    const report = await assessFoxguardFindings({ findings, rootPath, evaluator: { async evaluate() { dispatched++; return answer("false_positive"); } } });
    expect(dispatched).toBe(0);
    expect(report.assessments.map(a => a.reason)).toEqual(Array(4).fill("unsafe_source"));
    expect(report.total).toBe(4);
  });

  it("rejects malformed probability/identity responses without retrying or dropping remaining findings", async () => {
    const rootPath = source({ "query.ts": "db.query(input);\n" });
    const findings = [finding("query.ts"), finding("query.ts", { ruleId: "js/no-eval" })];
    const invalid = answer("false_positive");
    invalid.answers.finding = { type: "choice", choice: "false_positive", probabilities: { actionable: 0.7, false_positive: 0.9 } };
    let dispatched = 0;
    const report = await assessFoxguardFindings({ findings, rootPath, evaluator: { async evaluate() { dispatched++; return invalid; } } });
    expect(dispatched).toBe(1);
    expect(report.evaluated).toBe(0);
    expect(report.assessments.map(a => a.reason)).toEqual(["invalid_response", "invalid_response"]);
    const wrongIdentity = answer("false_positive");
    wrongIdentity.answers.extraFinding = wrongIdentity.answers.finding!;
    const extra = await assessFoxguardFindings({ findings, rootPath, evaluator: { async evaluate() { return wrongIdentity; } } });
    expect(extra.assessments[0]?.reason).toBe("invalid_response");
  });

  it("retains partial advice and every unscored finding on provider failure without exposing its error", async () => {
    const rootPath = source({ "query.ts": "db.query(input);\n" });
    const findings = [finding("query.ts"), finding("query.ts"), finding("query.ts")];
    let dispatched = 0;
    const report = await assessFoxguardFindings({ findings, rootPath, evaluator: { async evaluate() {
      if (++dispatched === 1) return answer("actionable");
      throw new Error("https://provider.invalid/?credential=DO_NOT_LEAK");
    } } });
    expect(dispatched).toBe(2);
    expect(report.status).toBe("partial");
    expect(report.assessments.map(a => a.disposition)).toEqual(["needs_review", "unscored", "unscored"]);
    expect(report.assessments.slice(1).map(a => a.reason)).toEqual(["unavailable", "unavailable"]);
    expect(JSON.stringify(report)).not.toContain("DO_NOT_LEAK");
  });

  it("bounds request count and retains candidates beyond the allowance", async () => {
    const rootPath = source({ "query.ts": "db.query(input);\n" });
    let dispatched = 0;
    const report = await assessFoxguardFindings({ findings: [finding("query.ts"), finding("query.ts")], rootPath, maxCandidates: 1, evaluator: { async evaluate() { dispatched++; return answer("false_positive"); } } });
    expect(dispatched).toBe(1);
    expect(report.status).toBe("partial");
    expect(report.assessments.map(a => a.disposition)).toEqual(["possible_false_positive", "unscored"]);
    expect(report.assessments[1]?.reason).toBe("limit");
  });

  it("enforces the total deadline even when an injected evaluator ignores abort", async () => {
    vi.useFakeTimers();
    const rootPath = source({ "query.ts": "db.query(input);\n" });
    let dispatched = 0;
    const pending = assessFoxguardFindings({ findings: [finding("query.ts"), finding("query.ts")], rootPath, evaluator: { evaluate() { dispatched++; return new Promise(() => {}); } } });
    await vi.advanceTimersByTimeAsync(15_000);
    const report = await pending;
    expect(dispatched).toBe(1);
    expect(report.assessments.map(a => a.reason)).toEqual(["timeout", "timeout"]);
  });

  it("propagates parent cancellation rather than disguising it as a provider failure", async () => {
    const rootPath = source({ "query.ts": "db.query(input);\n" });
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled");
    await expect(assessFoxguardFindings({ findings: [finding("query.ts")], rootPath, signal: controller.signal, evaluator: { evaluate() { controller.abort(cancellation); return new Promise(() => {}); } } })).rejects.toBe(cancellation);
  });
});
