import { describe, expect, it } from "vitest";
import { DevelopmentSummaryCache, type DevelopmentObservation } from "./development-summary.js";
const limits = { maxCases: 10, maxObservations: 100, maxExamplesPerGroup: 2, maxBytes: 4000, maxTokens: 4000, maxCachedReceipts: 2 };
function observation(caseId: string, overrides: Partial<DevelopmentObservation["attempt"]> = {}): DevelopmentObservation {
  return { attempt: { caseId, lane: "development", repeat: 0, matched: false, inconclusive: false, costUsd: 1, execution: { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }, ...overrides } };
}
describe("development-only offline summary", () => {
  it("excludes private lanes entirely and never scans raw traces", () => {
    const summary = new DevelopmentSummaryCache(limits).summarize([
      observation("public", { execution: { exitCode: 0, stdout: "secret-api-key ".repeat(100000), stderr: "false vulnerability truth", durationMs: 1, timedOut: false } }),
      observation("SEALED_EXPECTED_ID", { lane: "held-out", matched: true }),
      observation("NEGATIVE_ANSWER", { lane: "negative-control", matched: false }),
    ]);
    expect(summary.processedObservations).toBe(1);
    expect(summary.prompt).not.toMatch(/SEALED|NEGATIVE|secret|vulnerability|public/);
    expect(summary.groups[0].outcome).toBe("unknown");
  });
  it("preserves successes and requires independent verifier adjudication for misses", () => {
    const success = observation("success", { matched: true });
    const miss = observation("miss");
    miss.adjudication = { category: "confirmed-detection-miss", verifierReceiptDigest: `sha256:${"a".repeat(64)}` };
    const unsupported = observation("unsupported");
    unsupported.adjudication = { category: "confirmed-detection-miss", verifierReceiptDigest: "model-said-so" };
    const summary = new DevelopmentSummaryCache(limits).summarize([success, miss, unsupported]);
    expect(summary.groups.map(g => g.outcome)).toEqual(["preserve-success", "confirmed-detection-miss", "unknown"]);
  });
  it("distinguishes setup failures from generic inconclusive receipts", () => {
    const setup = observation("setup", { inconclusive: true, execution: { exitCode: 127, stdout: "", stderr: "missing compiler", durationMs: 1, timedOut: false } });
    const timeout = observation("timeout", { inconclusive: true, execution: { exitCode: 1, stdout: "", stderr: "", durationMs: 1, timedOut: true } });
    const result = new DevelopmentSummaryCache(limits).summarize([setup, timeout]);
    expect(result.groups.map(g => g.outcome)).toEqual(["incomplete-coverage", "tool-setup-failure"]);
  });
  it("bounds iteration including malformed and hidden traces, prompt size and examples", () => {
    let visited = 0;
    function* endless(): Generator<DevelopmentObservation> { for (;;) { visited++; yield observation(String(visited)); } }
    const summary = new DevelopmentSummaryCache({ ...limits, maxObservations: 20, maxBytes: 128, maxTokens: 128 }).summarize(endless());
    expect(visited).toBe(21);
    expect(summary.truncated).toBe(true);
    expect(Buffer.byteLength(summary.prompt)).toBeLessThanOrEqual(128);
    expect(summary.processedObservations).toBe(10);
  });
  it("deduplicates observations and caches isolated return values without private data affecting identity", () => {
    const cache = new DevelopmentSummaryCache(limits);
    const item = observation("dev");
    const a = cache.summarize([item, item]);
    expect(a.groups[0].count).toBe(1);
    a.groups[0].count = 99;
    const b = cache.summarize([item, item, observation("secret", { lane: "held-out" })]);
    expect(b.developmentDigest).toBe(a.developmentDigest);
    expect(b.groups[0].count).toBe(1);
  });
});
