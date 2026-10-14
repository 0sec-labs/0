import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "@0/shared";
import { runResearch } from "./research-runner.js";
import type { TargetResearchAdapter } from "./target-research-adapter.js";

const finding = {
  id: "f-cycle", templateId: "t", title: "embedded finding", description: "x", severity: "high",
  category: "other", status: "verified", evidence: { request: "", response: "" }, timestamp: 1,
} as Finding;

/** Adapter whose verify evidence embeds the finding itself, as the unified pipeline adapter does. */
const selfEmbeddingAdapter: TargetResearchAdapter = {
  kind: "test.self-embedding",
  async discover() {
    return { items: [{ id: "c1", title: "candidate", payload: null }] };
  },
  async verify(_target, input) {
    return {
      items: input.candidates.map(candidate => ({
        finding,
        candidateId: candidate.id,
        evidence: [{ stage: "verify" as const, status: "passed" as const, summary: "embedded finding payload", data: finding }],
      })),
    };
  },
};

const artifactRoot = mkdtempSync(join(tmpdir(), "zero-research-runner-test-"));
afterAll(() => rmSync(artifactRoot, { recursive: true, force: true }));

describe("runResearch evidence envelopes", () => {
  it("keeps envelopes JSON-serializable when evidence embeds the finding", async () => {
    const result = await runResearch(selfEmbeddingAdapter, {
      kind: "test.self-embedding", id: "t1", location: "fixture://target", config: {},
    }, { artifactRoot });
    // Pre-fix this threw "Converting circular structure to JSON" once the
    // envelope was attached to finding.researchEvidence downstream.
    expect(() => JSON.stringify(result.envelopes)).not.toThrow();
    expect(() => JSON.stringify(result.findings[0]!.finding.researchEvidence)).not.toThrow();
    const payload = result.envelopes[0]!.native as { oraclePayload: Array<{ data?: unknown }> };
    expect(payload.oraclePayload[0]!.data).toEqual({ ref: "finding", id: "f-cycle", title: "embedded finding" });
  });
});
