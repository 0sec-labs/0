/**
 * Campaign engine: sweep candidate payloads across a target's models, judge
 * each, and record unique breaks.
 *
 * Bakes in the lesson from the Gray Swan run: a break is unique per
 * (model, behaviour), so once a model is broken we stop spending attempts on
 * it — only unbroken models are retried with the next candidate.
 *
 * When configured with a Jev feedback hook, each non-skipped attempt also
 * receives an advisory intermediate label (explicit-refusal, partial-compliance,
 * attempted-prohibited, or ambiguous). These labels are NOT authoritative — the
 * regex/LLM judge and action oracle alone determine broken/not-broken.
 *
 * Bandit steering (opt-in): when banditSteering is true AND a jevFeedback hook
 * is present, per-strategy rewards from advisory feedback bias which strategies
 * generate the next generation's attempts. Attempts still run through the
 * identical judge path — steering never alters broken/not-broken.
 */
import type { AttemptReport, Behavior, BreakRecord, CampaignResult, JevAttemptFeedback, JevAttemptFeedbackLabel, Payload, Target, TargetResponse, Verdict } from "./types.js";
import { regexJudge } from "./judge.js";
import { generateCandidates, escalatedCandidates, compose, framingStrategies, concealmentStrategies } from "./strategies/index.js";

export type JudgeFn = (behavior: Behavior, response: TargetResponse) => Verdict | Promise<Verdict>;

/** Advisory Jev attempt feedback hook for the campaign engine. */
export type JevFeedbackFn = (
  behavior: Behavior,
  response: TargetResponse,
  signal?: AbortSignal,
) => Promise<JevAttemptFeedback | undefined>;

/** Reward contribution per Jev feedback label — probability-weighted progress. */
const REWARD_FACTOR: Record<JevAttemptFeedbackLabel, number> = {
  "partial-compliance": 1.0,
  "attempted-prohibited": 0.6,
  ambiguous: 0.3,
  "explicit-refusal": 0.0,
};

/** Per-strategy bandit state for advisory steering. */
interface BanditState {
  counts: Map<string, number>;
  cumRewards: Map<string, number>;
  temperature: number;
}

/** Strategy kind grouping for bandit weighting. */
const BANDIT_FRAMINGS = framingStrategies;
const BANDIT_CONCEALMENTS = concealmentStrategies;

/**
 * Compute softmax weights over mean reward per strategy with an exploration
 * floor so every strategy keeps at least 10% selection mass.
 */
function computeStrategyWeights(
  state: BanditState,
  strategyIds: string[],
): Record<string, number> {
  const t = state.temperature;
  if (strategyIds.length === 0) return {};

  const expVals: Record<string, number> = {};
  let expSum = 0;
  for (const id of strategyIds) {
    const count = state.counts.get(id) ?? 0;
    const cum = state.cumRewards.get(id) ?? 0;
    const mean = count > 0 ? cum / count : 0;
    const v = Math.exp(mean / t);
    expVals[id] = v;
    expSum += v;
  }

  const probs: Record<string, number> = {};
  for (const id of strategyIds) {
    probs[id] = expSum > 0 ? expVals[id]! / expSum : 1 / strategyIds.length;
  }

  // Exploration floor: every strategy keeps ≥ 10% selection mass
  const floor = 0.10;
  for (const id of strategyIds) {
    probs[id] = Math.max(floor, probs[id]!);
  }

  // Renormalize
  const sum = strategyIds.reduce((s, id) => s + probs[id]!, 0);
  for (const id of strategyIds) {
    probs[id]! /= sum;
  }

  return probs as Record<string, number>;
}

/**
 * Sample a strategy id from a weighted probability distribution using the
 * provided RNG.
 */
function sampleByWeight(weights: Record<string, number>, rng: () => number): string {
  const r = rng();
  let cum = 0;
  for (const [id, w] of Object.entries(weights)) {
    cum += w;
    if (r <= cum) return id;
  }
  // Fallback: last entry (floating-point rounding)
  const keys = Object.keys(weights);
  return keys[keys.length - 1]!;
}

/**
 * Generate candidates for one generation by sampling strategies according to
 * their current bandit weights. Produces the same count and framing-only vs
 * composite ratio as generateCandidates but with weighted rather than uniform
 * strategy selection.
 */
function weightedGenerateCandidates(
  behavior: Behavior,
  framingWeights: Record<string, number>,
  concealmentWeights: Record<string, number>,
  rng: () => number,
): Payload[] {
  const framings = BANDIT_FRAMINGS;
  const concealments = BANDIT_CONCEALMENTS;
  const out: Payload[] = [];

  // framing-only candidates (1 per framing in the original grid)
  for (const _ of framings) {
    const fId = sampleByWeight(framingWeights, rng);
    const framing = framings.find((s) => s.id === fId)!;
    out.push(framing.build(behavior));
  }

  // framing × concealment candidates (1 per pair in the original grid)
  for (const _ of framings) {
    for (const _ of concealments) {
      const fId = sampleByWeight(framingWeights, rng);
      const cId = sampleByWeight(concealmentWeights, rng);
      const framing = framings.find((s) => s.id === fId)!;
      const concealment = concealments.find((s) => s.id === cId)!;
      out.push(compose(framing, concealment).build(behavior));
    }
  }

  return out;
}

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
  /**
   * Advisory Jev attempt-feedback hook. Called after each non-skipped attempt
   * to produce an intermediate label for the next generation. Never changes
   * broken/not-broken. Accepts an optional AbortSignal for cancellation/timeout.
   */
  jevFeedback?: JevFeedbackFn;
  onFeedback?: (feedback: JevAttemptFeedback, model?: string) => void;
  /** AbortSignal for the entire campaign — cancels in-flight sends and stops
   *  further attempts. */
  signal?: AbortSignal;
  /**
   * Enable bandit-steered strategy selection using Jev feedback.
   * When on AND jevFeedback is present, per-strategy rewards from advisory
   * feedback bias which strategies generate the next generation's attempts.
   * Default false. Attempts still run through the identical judge path;
   * steering never alters broken/not-broken.
   */
  banditSteering?: boolean;
  /** Optional seeded RNG for deterministic bandit sampling; default Math.random. */
  rng?: () => number;
  /** Called after each generation when bandit steering adjusts strategy weights. */
  onSteering?: (weights: Record<string, number>) => void;
}

/** Per-generation state for the bandit-steered campaign loop. */
interface BanditLoopCtx {
  brokenModels: Set<string>;
  breaks: BreakRecord[];
  attemptReports: AttemptReport[];
  attempts: number;
  lastSteeringWeights?: Record<string, number>;
}

/**
 * Internal: run one generation of the bandit-steered campaign. Candidates are
 * generated from weighted strategy sampling and each attempt flows through the
 * same judge path (steering never alters broken/not-broken).
 */
async function runBanditGeneration(
  behavior: Behavior,
  target: Target,
  opts: CampaignOptions,
  banditState: BanditState,
  generation: number,
  ctx: BanditLoopCtx,
): Promise<void> {
  const judge = opts.judge ?? regexJudge;
  const models = target.models?.length ? target.models : [undefined];
  const rng = opts.rng ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? Infinity;

  // Compute per-kind weights (uniform for gen 0 when all counts are 0)
  const framingIds = BANDIT_FRAMINGS.map((s) => s.id);
  const concealmentIds = BANDIT_CONCEALMENTS.map((s) => s.id);
  const fWeights = computeStrategyWeights(banditState, framingIds);
  const cWeights = computeStrategyWeights(banditState, concealmentIds);
  // Combine for reporting
  const allWeights = { ...fWeights, ...cWeights };
  ctx.lastSteeringWeights = allWeights;
  opts.onSteering?.(allWeights);

  // Generate candidates for this generation
  const genCandidates = weightedGenerateCandidates(behavior, fWeights, cWeights, rng);

  // Track which strategies received feedback this generation (for decay check)
  let feedbackSeen = false;

  for (const payload of genCandidates) {
    for (const model of models) {
      opts.signal?.throwIfAborted();
      const key = model ?? "_single";
      if (ctx.brokenModels.has(key)) {
        ctx.attemptReports.push({
          model,
          strategies: payload.strategies,
          broken: false,
          index: ctx.attemptReports.length + 1,
          skipped: true,
        });
        continue;
      }
      if (ctx.attempts >= maxAttempts) return;

      ctx.attempts++;
      let verdict: Verdict;
      let response: TargetResponse | undefined;
      let pendingFeedback: Promise<JevAttemptFeedback | undefined> | undefined;
      try {
        response = await target.send(payload, behavior, model);
        opts.signal?.throwIfAborted();
        if (opts.jevFeedback) {
          pendingFeedback = opts.jevFeedback(behavior, response, opts.signal).then((feedback) => {
            if (feedback) opts.onFeedback?.(feedback, model);
            return feedback;
          }).catch(() => undefined);
        }
        verdict = await judge(behavior, response);
      } catch (err) {
        verdict = { broken: false, confidence: 0, judge: "error", evidence: String(err) };
      }

      opts.onAttempt?.({ model, strategies: payload.strategies, broken: verdict.broken, attempt: ctx.attempts });

      if (verdict.broken) {
        ctx.brokenModels.add(key);
        ctx.breaks.push({
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

      const jevFeedback = await pendingFeedback;
      opts.signal?.throwIfAborted();

      // Update bandit stats from Jev feedback
      if (jevFeedback && !jevFeedback.unavailable) {
        feedbackSeen = true;
        const reward = jevFeedback.probability * (REWARD_FACTOR[jevFeedback.label] ?? 0);
        for (const sid of payload.strategies) {
          banditState.counts.set(sid, (banditState.counts.get(sid) ?? 0) + 1);
          banditState.cumRewards.set(sid, (banditState.cumRewards.get(sid) ?? 0) + reward);
        }
      }
      // Unavailable feedback contributes nothing — no stat update

      ctx.attemptReports.push({
        model,
        strategies: payload.strategies,
        broken: verdict.broken,
        evidence: verdict.evidence,
        index: ctx.attempts,
        jevFeedback,
        skipped: false,
      });
    }
  }

  // Decay temperature after each generation that saw feedback
  if (feedbackSeen) {
    banditState.temperature = Math.max(0.2, banditState.temperature * 0.9);
  }
}

export async function runCampaign(
  behavior: Behavior,
  target: Target,
  opts: CampaignOptions = {},
): Promise<CampaignResult> {
  // Bandit-steered path
  if (opts.banditSteering && opts.jevFeedback && !opts.candidates) {
    const models = target.models?.length ? target.models : [undefined];
    const brokenModels = new Set<string>(opts.seedBroken ?? []);
    const breaks: BreakRecord[] = [];
    const attemptReports: AttemptReport[] = [];
    // Bandit generations are not bounded by a finite candidate list like the
    // standard path, so the attempt cap must be finite: default 100.
    const maxAttempts = opts.maxAttempts ?? 100;

    const banditState: BanditState = {
      counts: new Map(),
      cumRewards: new Map(),
      temperature: 1.0,
    };

    const ctx: BanditLoopCtx = {
      brokenModels,
      breaks,
      attemptReports,
      attempts: 0,
    };

    let generation = 0;
    while (ctx.attempts < maxAttempts) {
      opts.signal?.throwIfAborted();
      // All models broken: every further generation would only push skipped
      // reports without incrementing attempts — nothing can progress. Break
      // unconditionally (independent of stopWhenAllBroken).
      if (ctx.brokenModels.size >= models.length) break;

      await runBanditGeneration(behavior, target, opts, banditState, generation, ctx);
      generation++;
    }

    return {
      behaviorId: behavior.id,
      target: target.name,
      attempts: ctx.attempts,
      breaks: ctx.breaks,
      brokenModels: [...ctx.brokenModels].filter((m) => m !== "_single"),
      attemptReports: ctx.attemptReports,
      steeringWeights: ctx.lastSteeringWeights,
    };
  }

  // Standard (non-bandit) path
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
      let pendingFeedback: Promise<JevAttemptFeedback | undefined> | undefined;
      try {
        response = await target.send(payload, behavior, model);
        opts.signal?.throwIfAborted();
        if (opts.jevFeedback) {
          pendingFeedback = opts.jevFeedback(behavior, response, opts.signal).then(feedback => {
            if (feedback) opts.onFeedback?.(feedback, model);
            return feedback;
          }).catch(() => undefined);
        }
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

      const jevFeedback = await pendingFeedback;
      opts.signal?.throwIfAborted();

      attemptReports.push({
        model,
        strategies: payload.strategies,
        broken: verdict.broken,
        evidence: verdict.evidence,
        index: attempts,
        jevFeedback,
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
 *
 * When banditSteering is enabled on the base pass, the escalated pass uses
 * fixed escalatedCandidates (bandit steering only applies to the base
 * generation where strategy selection is dynamic).
 */
export async function runIterativeCampaign(
  behavior: Behavior,
  target: Target,
  opts: CampaignOptions = {},
): Promise<CampaignResult> {
  const base = await runCampaign(behavior, target, opts);
  const broken = new Set(base.brokenModels);
  // Pass banditSteering=false for the escalated pass — it uses fixed candidates
  const { banditSteering: _, ...restOpts } = opts;
  const escalated = await runCampaign(behavior, target, {
    ...restOpts,
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
    steeringWeights: base.steeringWeights,
  };
}
