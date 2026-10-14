import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formalArtifactDigest as hash, type FormalArtifactOptions, type FormalChallenge } from "../verify/formal-artifact.js";
import { runFormalResearchCampaign } from "./formal-campaign.js";

const challenge: FormalChallenge = {
  claimId: "tenant", claimPolarity: "invariant", theoremName: "tenant_isolation",
  targetSourceRevision: "v1", targetSourceDigest: hash("target"),
  trustedStatement: "tenant matches", trustedStatementDigest: hash("tenant matches"),
  trustedModel: "tenant model", modelDigest: hash("tenant model"),
  toolchainVersion: "pinned", dependencyLock: "Std", dependencyLockDigest: hash("Std"),
};
const verification: FormalArtifactOptions = {
  checkerIdentity: "comparator", checkerVersion: "1", externalCheckerIdentity: "nanoda", externalCheckerVersion: "2",
  checker: async request => {
    const { trustedStatement: _s, trustedModel: _m, dependencyLock: _d, ...fields } = request.challenge;
    return { ...fields, invocationNonce: request.invocationNonce, challengeDigest: request.challengeDigest,
      proofDigest: request.proofDigest, checkerIdentity: "comparator", checkerVersion: "1",
      externalCheckerIdentity: "nanoda", externalCheckerVersion: "2", outcome: "checked",
      comparatorMatched: true, externalCheckerAccepted: true, axiomDependencies: [] };
  },
};
const tasks = Array.from({ length: 5 }, (_, index) => ({ id: `task-${index}`, challenge }));

describe("bounded Zero formal research campaign", () => {
  it("caps concurrent generators and stops after a checked proof per task", async () => {
    let active = 0; let peak = 0;
    const result = await runFormalResearchCampaign({ tasks, verification, maxConcurrency: 2,
      generate: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return { proof: "proof" }; },
    });
    expect(peak).toBe(2);
    expect(result.totalAttempts).toBe(5);
    expect(result.tasks.every(task => task.status === "checked" && task.attempts.length === 1)).toBe(true);
    expect(result.scope).toBe("formal-model");
  });
  it("enforces the global attempt cap across parallel tasks", async () => {
    const result = await runFormalResearchCampaign({ tasks, verification, maxTotalAttempts: 3, generate: async () => ({ invalid: "proof" }) });
    expect(result.totalAttempts).toBe(3);
    expect(result.tasks.flatMap(task => task.attempts)).toHaveLength(3);
    expect(result.stopReason).toBe("Total attempt budget exhausted");
  });
  it("passes failures back to the next attempt without changing the trusted question", async () => {
    const result = await runFormalResearchCampaign({ tasks: tasks.slice(0, 1), verification,
      generate: async context => {
        expect(Object.isFrozen(context.challenge)).toBe(true);
        expect(context.challenge.trustedStatement).toBe(challenge.trustedStatement);
        if (context.attempt === 1) return { bad: true };
        expect(context.previous[0].status).toBe("artifact-rejected");
        expect(Object.isFrozen(context.previous[0])).toBe(true);
        return { proof: "revised proof" };
      },
    });
    expect(result.tasks[0].status).toBe("checked");
    expect(result.totalAttempts).toBe(2);
  });
  it("does not generate for unavailable checkers or invalid challenges", async () => {
    let calls = 0;
    const generate = async () => { calls++; return { proof: "proof" }; };
    const result = await runFormalResearchCampaign({ tasks, verification: { ...verification, checker: undefined }, generate });
    expect(calls).toBe(0);
    expect(result.tasks.every(task => task.status === "unresolved")).toBe(true);
    const invalid = await runFormalResearchCampaign({ tasks: [{ id: "bad", challenge: { ...challenge, modelDigest: hash("wrong") } }], verification, generate });
    expect(invalid.totalAttempts).toBe(0);
    expect(calls).toBe(0);
  });
  it("cancels stalled generation and does not launch additional tasks", async () => {
    let calls = 0; let signal: AbortSignal | undefined;
    const result = await runFormalResearchCampaign({ tasks, verification, maxConcurrency: 1, timeCapMs: 10,
      generate: async context => { calls++; signal = context.signal; return new Promise(() => {}); },
    });
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(result.stopReason).toBe("Campaign deadline exceeded");
    expect(result.tasks[0].attempts[0].result.status).toBe("inconclusive");
  });
  it("never generates when pre-cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const result = await runFormalResearchCampaign({ tasks, verification, signal: controller.signal,
      generate: async () => { calls++; return { proof: "proof" }; },
    });
    expect(calls).toBe(0);
    expect(result.stopReason).toBe("Cancelled");
  });
  it("retains challenge and proof bytes with results in a fresh directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-formal-campaign-test-"));
    try {
      const result = await runFormalResearchCampaign({ tasks: tasks.slice(0, 1), verification, artifactRoot: root,
        generate: async () => ({ proof: "reviewable proof" }),
      });
      expect(readdirSync(result.artifactDir!)).toEqual(["challenges.json", "results.json", "task-0-attempt-1.json"]);
      expect(JSON.parse(readFileSync(join(result.artifactDir!, "task-0-attempt-1.json"), "utf8")).proof).toBe("reviewable proof");
      expect(JSON.parse(readFileSync(join(result.artifactDir!, "results.json"), "utf8")).scope).toBe("formal-model");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects unbounded limits and duplicate task IDs", async () => {
    await expect(runFormalResearchCampaign({ tasks, verification, maxConcurrency: Infinity, generate: async () => ({ proof: "proof" }) })).rejects.toThrow("maxConcurrency");
    await expect(runFormalResearchCampaign({ tasks: [tasks[0], tasks[0]], verification, generate: async () => ({ proof: "proof" }) })).rejects.toThrow("unique");
  });
});
