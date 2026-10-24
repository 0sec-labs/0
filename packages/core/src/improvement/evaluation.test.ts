import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateCost } from "@0/shared";
import { parseEvolutionConfig } from "./config.js";
import { evaluateEvolutionCandidate, evolutionComparisonIdentity } from "./evaluation.js";
import { createEvolutionCandidate, snapshotEvolutionSource } from "./registry.js";
import { proposeEvolutionEdits } from "./rewrite.js";
import {
  campaignPromotionAllowed, loadEvolutionCampaign, reconcileCampaignDispatch,
  reserveCampaignDispatch, settleCampaignDispatch,
} from "./safety.js";
import { promoteEvolutionVersion, recordEvolutionVersion, startEvolutionCanary } from "./registry.js";
import type { EvolutionConfig, EvolutionSandbox, EvolutionSnapshot } from "./types.js";

const directories: string[] = [];
afterEach(() => {
  const unlock = (directory: string): void => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) unlock(join(directory, entry.name));
    }
  };
  for (const directory of directories.splice(0)) {
    unlock(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

async function setup(): Promise<{ config: EvolutionConfig; baseline: EvolutionSnapshot; candidate: EvolutionSnapshot }> {
  const directory = mkdtempSync(join(tmpdir(), "0-evaluation-"));
  directories.push(directory);
  const sourceRoot = join(directory, "source");
  mkdirSync(join(sourceRoot, "src"), { recursive: true });
  writeFileSync(join(sourceRoot, "src", "detector.js"), "export const revision = 1;\n");
  const config = parseEvolutionConfig({
    schemaVersion: 1,
    sourceRoot,
    storePath: join(directory, "store"),
    image: "node:22-alpine",
    sourcePaths: ["src"],
    editablePaths: ["src"],
    command: ["node", "src/detector.js"],
    computeUsdPerSecond: 0.001,
    objective: "Detect the intended condition without reporting unrelated findings.",
    promotionPolicy: { minimumCases: 3 },
    repeats: 2,
    maxOutputBytes: 1024,
    cases: ["development", "held-out", "negative-control"].flatMap((lane, group) =>
      [0, 1, 2].map((index) => ({
        id: `${lane}-${index}`, lane,
        input: { key: group * 3 + index, index, negative: lane === "negative-control" },
        expected: { findings: lane === "negative-control" ? [] : [{ category: "intended", location: index }] },
      }))),
  });
  const baseline = await snapshotEvolutionSource(config);
  const file = baseline.files.find((entry) => entry.path === "src/detector.js")!;
  const candidate = await createEvolutionCandidate(baseline, {
    rationale: "Refine the detector", modelCostUsd: 0.01,
    edits: [{ path: file.path, beforeDigest: file.digest, content: "export const revision = 2;\n" }],
  }, config);
  return { config, baseline, candidate };
}

function probe(candidateId: string, mode: "correct" | "unrelated" | "negative-error" | "flaky"): EvolutionSandbox {
  const calls = new Map<number, number>();
  return async ({ snapshot, input }) => {
    const value = input as { key: number; index: number; negative: boolean };
    const challenger = snapshot.id === candidateId;
    const count = calls.get(value.key) ?? 0;
    if (challenger) calls.set(value.key, count + 1);
    const error = mode === "negative-error" && value.negative ? "negative control could not execute" : undefined;
    let findings: Array<{ category: string; location: number }> = [];
    if (!value.negative && (challenger || value.index !== 2)) {
      findings = [{ category: challenger && mode === "unrelated" ? "unrelated" : "intended", location: value.index }];
    }
    if (mode === "flaky" && challenger && value.index === 2 && count > 0) findings = [];
    return {
      exitCode: error ? null : 0, stdout: JSON.stringify({ findings }), stderr: "",
      durationMs: 10, timedOut: false, ...(error ? { error } : {}),
    };
  };
}

describe("independent evolution oracle", () => {
  it("records a sealed critical panel and rejects losses even when the baseline also fails it", async () => {
    const { config, baseline, candidate } = await setup();
    config.retentionPolicy = { profileId: "older-parser-capability", version: 1, criticalCaseIds: ["held-out-2"] };
    const passing = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox: probe(candidate.id, "correct") });
    expect(passing.retention).toMatchObject({ passed: true, checkedCases: 1 });
    expect(passing.decision.status).toBe("requires_human_approval");
    const delegate = probe(candidate.id, "correct");
    const failing: EvolutionSandbox = async request => {
      const execution = await delegate(request);
      // Both baseline and candidate lose a capability from an older profile.
      // This loss is invisible to immediate-baseline retention alone.
      if ((request.input as { key: number }).key === 5) execution.stdout = JSON.stringify({ findings: [] });
      return execution;
    };
    const rejected = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox: failing });
    expect(rejected.retention?.passed).toBe(false);
    expect(rejected.result.ciPassed).toBe(false);
    expect(rejected.decision.status).toBe("rejected");
    expect(rejected.retention?.profileDigest).toBe(passing.retention?.profileDigest);
  });

  it("rejects oversized fixture collections before inspecting attacker-controlled entries", async () => {
    const { config } = await setup();
    let inspected = 0;
    const oversized = Array.from({ length: 1001 }, () => new Proxy({}, {
      get: () => { inspected++; throw new Error("oversized collection entries must not be parsed"); },
    }));
    expect(() => parseEvolutionConfig({ ...config, cases: oversized })).toThrow(/too_big/);
    expect(inspected).toBe(0);
  });

  it("retains every nested promotion-policy default when the object is omitted", async () => {
    const { config } = await setup();
    const { promotionPolicy: _policy, ...withoutPolicy } = config;
    const cases = (["development", "held-out", "negative-control"] as const).flatMap((lane) =>
      Array.from({ length: 10 }, (_, index) => ({ id: `${lane}-${index}`, lane, input: { lane, index }, expected: true })),
    );
    expect(parseEvolutionConfig({ ...withoutPolicy, cases }).promotionPolicy).toEqual({
      minimumCases: 10, minimumDevelopmentLift: 0.05, minimumHeldOutLift: 0.03,
      maximumNegativeControlFpDelta: 0, maximumCostMultiplier: 1.5,
    });
  });

  it("observes selected source bytes and rejects stale provenance after a source edit", async () => {
    const { config } = await setup();
    const identity = { provider: "openai", model: "gpt-4o" };
    const before = evolutionComparisonIdentity(config, identity);
    writeFileSync(join(config.sourceRoot, "src/detector.js"), "export const revision = 99;\n");
    const after = evolutionComparisonIdentity(config, identity);
    expect(after.sourceRevision).not.toBe(before.sourceRevision);
    expect(after.evaluatorDigest).toBe(before.evaluatorDigest);
    expect(before.sourceRevision).not.toBe(before.evaluatorDigest);
  });

  it("rejects a declared model worker before dispatch when durable safety is disabled", async () => {
    const { config, baseline, candidate } = await setup();
    let dispatched = false;
    await expect(evaluateEvolutionCandidate(baseline, candidate, {
      ...config, safety: { enabled: false, holdoutExposureLimit: 100,
        workerModel: { provider: "openai", model: "gpt-4o-mini", maxCostUsdPerExecution: 0.01 } },
    }, { sandbox: async () => { dispatched = true; throw new Error("must not dispatch"); } })).rejects.toThrow(/require enabled durable safety/);
    expect(dispatched).toBe(false);
  });

  it.each([undefined, { enabled: false, holdoutExposureLimit: 100 }, { enabled: true, holdoutExposureLimit: 100 }])(
    "rejects undeclared model billing instead of reporting compute-only evaluation cost (safety %j)", async (safety) => {
      const { config, baseline, candidate } = await setup();
      const sandbox = probe(candidate.id, "correct");
      let dispatched = 0;
      await expect(evaluateEvolutionCandidate(baseline, candidate, { ...config, ...(safety ? { safety } : {}) }, {
        modelIdentity: () => ({ provider: "openai", model: "proposal-model" }),
        sandbox: async (request) => {
          dispatched++;
          return { ...await sandbox(request), workerModelUsage: {
            provider: "openai", model: "gpt-4o-mini", costUsd: 100, receiptDigest: "sha256:" + "c".repeat(64),
          } };
        },
      })).rejects.toThrow(/undeclared worker model charge/);
      expect(dispatched).toBe(1);
      if (safety?.enabled) expect(loadEvolutionCampaign(config.storePath).unknownCost).toBe(true);
    },
  );

  it("reserves and settles evaluated worker model charges separately from compute", async () => {
    const { config, baseline, candidate } = await setup();
    const safe = { ...config, safety: { enabled: true, holdoutExposureLimit: 100,
      workerModel: { provider: "openai", model: "gpt-4o-mini", maxCostUsdPerExecution: 0.01 } } };
    const base = probe(candidate.id, "correct");
    const evaluated = await evaluateEvolutionCandidate(baseline, candidate, safe, {
      modelIdentity: () => ({ provider: "anthropic", model: "proposal-model" }),
      sandbox: async (request) => {
        const ledger = loadEvolutionCampaign(config.storePath);
        expect(ledger.reservations.filter((entry) => entry.state === "reserved").map((entry) => entry.kind)).toEqual(["evaluation", "model"]);
        return { ...await base(request), workerModelUsage: {
          provider: "openai", model: "gpt-4o-mini", costUsd: 0.001, receiptDigest: "sha256:" + "a".repeat(64),
        } };
      },
    });
    const ledger = loadEvolutionCampaign(config.storePath);
    expect(ledger.cumulativeModelCostUsd).toBeCloseTo(0.036);
    expect(ledger.cumulativeEvaluationCostUsd).toBeCloseTo(0.00036);
    expect(evaluated.result.provenance?.resolvedModel).toBe("proposal-model");
    expect(evaluated.result.provenance?.evaluatedWorker).toEqual({ kind: "model", provider: "openai", model: "gpt-4o-mini" });
    expect(evaluated.attempts.candidate[0]?.costUsd).toBeCloseTo(0.00101);
  });

  it("blocks model evaluation when host billing evidence is missing", async () => {
    const { config, baseline, candidate } = await setup();
    const safe = { ...config, safety: { enabled: true, holdoutExposureLimit: 100,
      workerModel: { provider: "openai", model: "gpt-4o-mini", maxCostUsdPerExecution: 0.01 } } };
    let dispatches = 0;
    const sandbox = probe(candidate.id, "correct");
    await expect(evaluateEvolutionCandidate(baseline, candidate, safe, {
      modelIdentity: () => ({ provider: "openai", model: "proposal-model" }),
      sandbox: async (request) => { dispatches++; return sandbox(request); },
    })).rejects.toThrow(/cost is unknown/);
    expect(dispatches).toBe(1);
    const ledger = loadEvolutionCampaign(config.storePath);
    expect(ledger.unknownCost).toBe(true);
    expect(ledger.reservations.find((entry) => entry.kind === "model")?.state).toBe("unknown");
    expect(ledger.cumulativeEvaluationCostUsd).toBeCloseTo(0.00001);
  });

  it("settles an observed worker failover charge before blocking provenance", async () => {
    const { config, baseline, candidate } = await setup();
    const safe = { ...config, safety: { enabled: true, holdoutExposureLimit: 100,
      workerModel: { provider: "openai", model: "gpt-4o-mini", maxCostUsdPerExecution: 0.01 } } };
    const sandbox = probe(candidate.id, "correct");
    await expect(evaluateEvolutionCandidate(baseline, candidate, safe, {
      modelIdentity: () => ({ provider: "openai", model: "proposal-model" }),
      sandbox: async (request) => ({ ...await sandbox(request), workerModelUsage: {
        provider: "other", model: "unapproved", costUsd: 0.002, receiptDigest: "sha256:" + "b".repeat(64),
      } }),
    })).rejects.toThrow(/worker provenance differs/);
    expect(loadEvolutionCampaign(config.storePath).cumulativeModelCostUsd).toBe(0.002);
    expect(campaignPromotionAllowed(config.storePath).allowed).toBe(false);
  });

  it("requires the intended output, not any finding produced by the candidate", async () => {
    const { config, baseline, candidate } = await setup();
    const correct = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox: probe(candidate.id, "correct") });
    const unrelated = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox: probe(candidate.id, "unrelated") });
    expect(correct.decision.status).toBe("requires_human_approval");
    expect(unrelated.decision.status).toBe("rejected");
    expect(unrelated.result.heldOut.challenger.successRate).toBe(0);
  });

  it("does not inflate confidence by repeating the same fixtures", async () => {
    const { config, baseline, candidate } = await setup();
    const first = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox: probe(candidate.id, "correct") });
    const repeated = await evaluateEvolutionCandidate(baseline, candidate, { ...config, repeats: 4 }, { sandbox: probe(candidate.id, "correct") });
    for (const lane of ["development", "heldOut"] as const) {
      for (const variant of ["champion", "challenger"] as const) {
        expect(repeated.result[lane][variant].successRateCI95).toEqual(first.result[lane][variant].successRateCI95);
      }
    }
  });

  it("does not treat failed negative controls as evidence of precision", async () => {
    const { config, baseline, candidate } = await setup();
    const evaluation = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox: probe(candidate.id, "negative-error") });
    expect(evaluation.decision.status).toBe("rejected");
    expect(evaluation.result.negativeControls.challenger.inconclusiveRate).toBe(1);
  });

  it("rejects gains that disappear on repeated execution", async () => {
    const { config, baseline, candidate } = await setup();
    const evaluation = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox: probe(candidate.id, "flaky") });
    expect(evaluation.result.heldOut.challenger.successRate).toBeGreaterThan(evaluation.result.heldOut.champion.successRate);
    expect(evaluation.decision.status).toBe("rejected");
  });

  it("rejects aggregate gains that discard an established capability", async () => {
    const { config, baseline, candidate } = await setup();
    const sandbox: EvolutionSandbox = async ({ snapshot, input }) => {
      const value = input as { key: number; index: number; negative: boolean };
      const challenger = snapshot.id === candidate.id;
      // The candidate learns two held-out cases but forgets the one the
      // baseline already solved. Both aggregate positive-lane scores improve.
      const detects = challenger ? value.key !== 3 : value.index === 0;
      const findings = !value.negative && detects
        ? [{ category: "intended", location: value.index }]
        : [];
      return {
        exitCode: 0, stdout: JSON.stringify({ findings }), stderr: "",
        durationMs: 10, timedOut: false,
      };
    };
    const evaluation = await evaluateEvolutionCandidate(baseline, candidate, config, { sandbox });
    for (const lane of ["development", "heldOut"] as const) {
      expect(evaluation.result[lane].challenger.successRate).toBeGreaterThan(
        evaluation.result[lane].champion.successRate,
      );
    }
    expect(evaluation.decision.status).toBe("rejected");
  });


  it("charges completed executions before admitting the next bounded evaluation", async () => {
    const { config, baseline, candidate } = await setup();
    let dispatches = 0;
    const sandbox: EvolutionSandbox = async ({ input }) => {
      dispatches++;
      const fixture = config.cases.find((entry) => JSON.stringify(entry.input) === JSON.stringify(input))!;
      return { exitCode: 0, stdout: JSON.stringify(fixture.expected), stderr: "", durationMs: 500, timedOut: false };
    };
    await expect(evaluateEvolutionCandidate(baseline, candidate, {
      ...config, timeoutMs: 1000, maxEvaluationCostUsd: 0.0015,
    }, { sandbox })).rejects.toThrow(/budget/);
    expect(dispatches).toBe(2);
  });

  it("retains observed execution cost when the shared pass cap rejects after settlement", async () => {
    const { config, baseline, candidate } = await setup();
    let charged = 0;
    await expect(evaluateEvolutionCandidate(baseline, candidate, {
      ...config, timeoutMs: 1000, safety: { enabled: true, holdoutExposureLimit: 100 },
    }, {
      modelIdentity: () => ({ provider: "openai", model: "gpt-4o" }),
      sandbox: async () => ({ exitCode: 0, stdout: "{}", stderr: "", durationMs: 2000, timedOut: false }),
      evaluationBudget: {
        remainingUsd: () => 0.0015 - charged,
        charge: (costUsd) => {
          charged += costUsd;
          if (charged > 0.0015) throw new Error("shared pass cap exceeded");
        },
      },
    })).rejects.toThrow(/shared pass cap/);
    const ledger = loadEvolutionCampaign(config.storePath);
    expect(ledger.cumulativeEvaluationCostUsd).toBe(0.002);
    expect(ledger.unknownCost).toBe(false);
    expect(charged).toBe(0.002);
  });

  it("reserves real generation before dispatch and retains failed-call unknown cost", async () => {
    const { config, baseline } = await setup();
    const safe = { ...config, model: "anthropic/claude-sonnet-4-6", allowModelSourceAccess: true, safety: { enabled: true, holdoutExposureLimit: 100 } };
    const modelIdentity = () => ({ provider: "anthropic", model: "claude-sonnet-4-6", pricingModel: "anthropic/claude-sonnet-4-6" });
    const usage = { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 1000 };
    const proposal = await proposeEvolutionEdits(baseline, safe, "development only", {
      modelIdentity,
      model: async () => {
        expect(campaignPromotionAllowed(config.storePath).allowed).toBe(false);
        return {
          content: [{ type: "tool_use", id: "proposal", name: "propose_edits", input: { rationale: "No justified change", edits: [] } }],
          stopReason: "tool_use", usage, durationMs: 1,
        };
      },
    });
    expect(proposal.modelCostUsd).toBe(estimateCost(usage, "anthropic/claude-sonnet-4-6"));
    expect(loadEvolutionCampaign(config.storePath).cumulativeModelCostUsd).toBe(proposal.modelCostUsd);
    await expect(proposeEvolutionEdits(baseline, safe, "development only", {
      modelIdentity, model: async () => { throw new Error("provider disconnected after dispatch"); },
    })).rejects.toThrow(/disconnected/);
    expect(loadEvolutionCampaign(config.storePath).unknownCost).toBe(true);
    expect(loadEvolutionCampaign(config.storePath).cumulativeModelCostUsd).toBe(proposal.modelCostUsd);
    expect(campaignPromotionAllowed(config.storePath).allowed).toBe(false);
    let bypassDispatches = 0;
    await expect(proposeEvolutionEdits(baseline, { ...safe, safety: { ...safe.safety, enabled: false } }, "development only", {
      modelIdentity,
      model: async () => {
        bypassDispatches++;
        throw new Error("must not dispatch after disabling a durable gate");
      },
    })).rejects.toThrow(/cannot be disabled/);
    expect(bypassDispatches).toBe(0);
  });

  it("settles the observed failover route and blocks incompatible generator provenance", async () => {
    const { config, baseline } = await setup();
    let resolvedModel = "gpt-4o";
    const usage = { inputTokens: 100, outputTokens: 10 };
    await expect(proposeEvolutionEdits(baseline, {
      ...config, model: "gpt-4o", allowModelSourceAccess: true, safety: { enabled: true, holdoutExposureLimit: 100 },
    }, "development only", {
      modelIdentity: () => ({ provider: "openai", model: resolvedModel, pricingModel: `openai/${resolvedModel}` }),
      model: async () => {
        resolvedModel = "gpt-4o-mini";
        return {
          content: [{ type: "tool_use", id: "proposal", name: "propose_edits", input: { rationale: "Observed failover", edits: [] } }],
          stopReason: "tool_use", usage, durationMs: 1,
        };
      },
    })).rejects.toThrow(/changed or is unresolved/);
    const ledger = loadEvolutionCampaign(config.storePath);
    expect(ledger.cumulativeModelCostUsd).toBe(estimateCost(usage, "openai/gpt-4o-mini"));
    expect(ledger.status).toBe("blocked");
    expect(ledger.unknownCost).toBe(false);
    expect(campaignPromotionAllowed(config.storePath).allowed).toBe(false);
  });

  it("cannot reset the evaluator or holdout exposure by relabeling and reordering fixtures", async () => {
    const { config, baseline, candidate } = await setup();
    const safe = { ...config, safety: { enabled: true, holdoutExposureLimit: 12 } };
    const deps = { sandbox: probe(candidate.id, "correct"), modelIdentity: () => ({ provider: "openai", model: "gpt-4o" }) };
    await evaluateEvolutionCandidate(baseline, candidate, safe, deps);
    await expect(evaluateEvolutionCandidate(baseline, candidate, {
      ...safe, cases: [...safe.cases].reverse().map((entry) => ({ ...entry, id: `renamed-${entry.id}` })),
    }, deps)).rejects.toThrow(/holdout exposure exhausted/);
    expect(loadEvolutionCampaign(config.storePath).exposures[0]?.consumed).toBe(12);
  });

  it("enforces pending and unknown-cost gates inside canary and promotion CAS transitions", async () => {
    const { config, baseline, candidate } = await setup();
    const safe = { ...config, safety: { enabled: true, holdoutExposureLimit: 100 } };
    const evaluation = await evaluateEvolutionCandidate(baseline, candidate, safe, {
      sandbox: probe(candidate.id, "correct"), modelIdentity: () => ({ provider: "openai", model: "gpt-4o" }),
    });
    await recordEvolutionVersion(config.storePath, {
      schemaVersion: 1, id: baseline.id, kind: safe.kind, snapshot: baseline, parentId: null,
      createdAt: new Date().toISOString(), configDigest: evaluation.configDigest, receiptDigest: null, status: "baseline",
    }, safe);
    await recordEvolutionVersion(config.storePath, {
      schemaVersion: 1, id: candidate.id, kind: safe.kind, snapshot: candidate, parentId: baseline.id,
      createdAt: new Date().toISOString(), configDigest: evaluation.configDigest, receiptDigest: evaluation.receiptDigest, status: "candidate",
    }, safe, evaluation);
    const dispatch = reserveCampaignDispatch(config.storePath, "model", 1);
    await expect(startEvolutionCanary(config.storePath, candidate.id, baseline.id)).rejects.toThrow(/pending/);
    settleCampaignDispatch(config.storePath, dispatch.id, null);
    await expect(startEvolutionCanary(config.storePath, candidate.id, baseline.id)).rejects.toThrow(/unknown-cost/);
    reconcileCampaignDispatch(config.storePath, dispatch.id, 0.01, "sha256:" + "b".repeat(64));
    await startEvolutionCanary(config.storePath, candidate.id, baseline.id);
    reserveCampaignDispatch(config.storePath, "model", 1);
    await expect(promoteEvolutionVersion(config.storePath, candidate.id, baseline.id)).rejects.toThrow(/pending/);
  });
  it("rejects missing controls and reused development inputs in held-out lanes", async () => {
    const { config } = await setup();
    expect(() => parseEvolutionConfig({ ...config, cases: config.cases.filter((entry) => entry.lane !== "negative-control") })).toThrow(/negative-control/);
    const cases = config.cases.map((entry) => ({ ...entry }));
    cases[3]!.input = cases[0]!.input;
    expect(() => parseEvolutionConfig({ ...config, cases })).toThrow(/duplicate evaluation input/);
  });
});
