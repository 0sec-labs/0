/**
 * Campaign engine: sweep candidate payloads across a target's models, judge
 * each, and record unique breaks.
 *
 * Bakes in the lesson from the Gray Swan run: a break is unique per
 * (model, behaviour), so once a model is broken we stop spending attempts on
 * it — only unbroken models are retried with the next candidate.
 */
import type { AttemptReport, Behavior, BreakRecord, CampaignResult, Payload, Target, TargetResponse, Verdict } from "./types.js";
import { regexJudge } from "./judge.js";
import { generateCandidates, escalatedCandidates } from "./strategies/index.js";

export type JudgeFn = (behavior: Behavior, response: TargetResponse) => Verdict | Promise<Verdict>;

export interface CampaignOptions {
  /** Candidate payloads to sweep; defaults to the full framing×concealment set. */
  candidates?: Payload[];
  /** Judge to use; defaults to the regex/proof judge. May be async (LLM judge). */
  judge?: JudgeFn;
  /** Stop once every model is broken. */
  stopWhenAllBroken?: boolean;
  /** Max total send() calls (budget guard). */
  maxAttempts?: number;
  /** Models already broken (seeded so iterative rounds don't re-hit them). */
  seedBroken?: Iterable<string>;
  /** Called after each attempt for progress reporting. */
  onAttempt?: (info: { model?: string; strategies: string[]; broken: boolean; attempt: number }) => void;
  /** AbortSignal for the entire campaign — cancels in-flight sends and stops
   *  further attempts. */
  signal?: AbortSignal;
}

export async function runCampaign(
  behavior: Behavior,
  target: Target,
  opts: CampaignOptions = {},
): Promise<CampaignResult> {
  const candidates = opts.candidates ?? generateCandidates(behavior);
  const judge = opts.judge ?? regexJudge;
  const models = target.models && target.models.length ? target.models : [undefined];
  const brokenModels = new Set<string>(opts.seedBroken ?? []);
  const breaks: BreakRecord[] = [];
  const attemptReports: AttemptReport[] = [];
  let attempts = 0;

  outer: for (const payload of candidates) {
    for (const model of models) {
      opts.signal?.throwIfAborted();
      const key = model ?? "_single";
      if (brokenModels.has(key)) {
        attemptReports.push({
          model,
          strategies: payload.strategies,
          broken: false,
          index: attemptReports.length + 1,
          skipped: true,
        });
        continue; // unique-breaks: don't re-hit a broken model
      }
      if (opts.maxAttempts && attempts >= opts.maxAttempts) break outer;

      attempts++;
      let verdict: Verdict;
      let response: TargetResponse | undefined;
      try {
        response = await target.send(payload, behavior, model);
        opts.signal?.throwIfAborted();
        verdict = await judge(behavior, response);
      } catch (err) {
        verdict = { broken: false, confidence: 0, judge: "error", evidence: String(err) };
      }

      opts.onAttempt?.({ model, strategies: payload.strategies, broken: verdict.broken, attempt: attempts });

      if (verdict.broken) {
        brokenModels.add(key);
        breaks.push({
          behaviorId: behavior.id,
          target: target.name,
          model,
          strategies: payload.strategies,
          broken: true,
          evidence: verdict.evidence,
          payloadText: payload.text,
          transcriptExcerpt: (response?.transcript ?? "").slice(0, 500),
        });
      }

      opts.signal?.throwIfAborted();

      attemptReports.push({
        model,
        strategies: payload.strategies,
        broken: verdict.broken,
        evidence: verdict.evidence,
        index: attempts,
        skipped: false,
      });
    }
    if (opts.stopWhenAllBroken && brokenModels.size >= models.length) break;
  }

  return {
    behaviorId: behavior.id,
    target: target.name,
    attempts,
    breaks,
    brokenModels: [...brokenModels].filter((m) => m !== "_single"),
    attemptReports,
  };
}

/**
 * Iterative campaign: sweep the base candidate set, then ESCALATE — re-attack
 * only the survivors with every concealment channel stacked at once (the v5
 * "combine all techniques" move). Mirrors how we ground the hardest models.
 */
export async function runIterativeCampaign(
  behavior: Behavior,
  target: Target,
  opts: CampaignOptions = {},
): Promise<CampaignResult> {
  const base = await runCampaign(behavior, target, opts);
  const broken = new Set(base.brokenModels);
  const escalated = await runCampaign(behavior, target, {
    ...opts,
    candidates: escalatedCandidates(behavior),
    seedBroken: broken,
  });
  return {
    behaviorId: behavior.id,
    target: target.name,
    attempts: base.attempts + escalated.attempts,
    breaks: [...base.breaks, ...escalated.breaks],
    brokenModels: [...new Set([...base.brokenModels, ...escalated.brokenModels])],
    attemptReports: [...base.attemptReports, ...escalated.attemptReports],
  };
}
