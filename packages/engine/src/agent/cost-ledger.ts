// Shared per-scan cost ledger.
//
// A single scan run drives MULTIPLE agent sessions: the unified pipeline
// runs one research session plus a concurrent blind-verify wave (one session
// per finding), and the per-file research loop runs one session per source
// file. Each session tracks its own `state.totalUsage` from zero, so a hard
// per-scan cost ceiling checked against session-local usage binds every
// session individually but never the scan as a whole — a $3 ceiling still
// allowed research($3) + N × verify($3) of real spend (prod 0review scans
// landed at $4.99 / $6.36 against the $3 ZERO_REVIEW_COST_CEILING_USD).
//
// The fix is this ledger: the pipeline creates ONE instance per run and
// threads it through every agent session. Each native-loop turn adds its
// token usage here, and the per-turn ceiling check prices the ledger's
// cross-session cumulative total instead of the session's alone. Verify
// sessions run concurrently (Promise.all); since each adds only its own
// usage and reads the shared total, the wave trips within one turn of the
// collective spend crossing the ceiling (overshoot bounded by one in-flight
// turn per active session).
//
// The ledger is also the source of truth for the scan_completed event's
// cost_usd + per-model cost_breakdown, so the cloud sees the true
// cross-session cumulative rather than any single session's segment.

import { estimateCost, modelProvider, splitCost } from "./cost.js";
import { hasKnownPricing } from "../shared/index.js";
import type { CostBreakdownEntry } from "../events/bus.js";
import type { TokenUsageForPricing } from "../shared/index.js";
import type { NativeRuntimeResult, RuntimeResult } from "../runtime/types.js";

const recordedResults = new WeakMap<NativeRuntimeResult | RuntimeResult, ScanCostLedger>();

/** A runtime wrapper and its agent loop may observe the same billed response. */
export function addRuntimeUsage(ledger: ScanCostLedger | undefined, result: NativeRuntimeResult | RuntimeResult, model?: string): void {
  if (!ledger || recordedResults.get(result) === ledger || (!result.usage && !result.usageByModel?.length)) return;
  if (result.usageByModel?.length) {
    for (const bucket of result.usageByModel) ledger.add(bucket.usage, bucket.model);
  } else if (result.usage) ledger.add(result.usage, model);
  recordedResults.set(result, ledger);
}

interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

export class ScanCostLedger {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private cacheWriteTokens = 0;
  private readonly perModel = new Map<string, UsageBucket>();
  private readonly listeners = new Set<() => void>();
  private unpricedUsage = false;

  private readonly costUnknownModels = new Set<string>();

  /** A model with no pricing entry (free tier, custom or self-hosted endpoint). */
  static isCostUnknown(model?: string): model is string {
    return Boolean(model) && model !== "auto" && model !== "unknown" && !hasKnownPricing(model);
  }

  /** Models whose usage is recorded but whose cost is unknown and counted as $0. */
  costUnknownModelIds(): string[] { return [...this.costUnknownModels]; }

  private noteCostUnknown(model: string): void {
    if (this.costUnknownModels.has(model)) return;
    this.costUnknownModels.add(model);
    if (!this.parent) {
      process.stderr.write(`[0] Warning: model ${model} has no pricing entry, so its cost is unknown and not counted against any cost cap. Use a time cap to bound this run.\n`);
    }
    this.parent?.noteCostUnknown(model);
  }

  /**
   * A response arrived without a usable usage receipt. For a model with no
   * pricing entry this is cost-unknown, not a failure; otherwise the cost
   * ceiling cannot be enforced and the run must stop.
   */
  markUnpricedUsage(model?: string): void {
    if (ScanCostLedger.isCostUnknown(model)) { this.noteCostUnknown(model); return; }
    if (this.unpricedUsage) return;
    this.unpricedUsage = true;
    this.parent?.markUnpricedUsage();
    for (const listener of this.listeners) listener();
  }

  hasUnpricedUsage(): boolean { return this.unpricedUsage; }

  constructor(private readonly parent?: ScanCostLedger) {}

  /** Isolated attribution, with the same root budget for every concurrent run. */
  fork(): ScanCostLedger { return new ScanCostLedger(this); }

  onSpend(listener: () => void): () => void {
    const root = this.parent ?? this;
    if (root !== this) return root.onSpend(listener);
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Spend attributable to this run, not its siblings or earlier attempts. */
  runCostUsd(): number { return this.costBreakdown()?.costUsd ?? 0; }

  /**
   * Fold one turn's token usage into the cumulative total. `model` (the
   * session's pricing model) keys the per-model buckets the cost_breakdown
   * is derived from; sessions without a model pick land in "unknown".
   */
  add(rawUsage: TokenUsageForPricing, model?: string): void {
    // A malformed receipt (NaN, Infinity, negative) must never poison the
    // cumulative total: NaN would make every ceiling comparison false and a
    // negative count would erase real spend. Drop the bad field and flag the
    // run as having unpriced usage so a cost ceiling fails closed.
    let malformed = false;
    const clean = (value: number | undefined): number => {
      if (value === undefined) return 0;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      malformed = true;
      return 0;
    };
    const usage: TokenUsageForPricing = {
      ...rawUsage,
      inputTokens: clean(rawUsage.inputTokens),
      outputTokens: clean(rawUsage.outputTokens),
      cachedInputTokens: clean(rawUsage.cachedInputTokens),
      cacheWriteTokens: clean(rawUsage.cacheWriteTokens),
    };
    if (malformed) this.markUnpricedUsage(model);
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    const key = model ?? "unknown";
    if (ScanCostLedger.isCostUnknown(model)) this.noteCostUnknown(model);
    const bucket =
      this.perModel.get(key) ??
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
    bucket.cachedInputTokens += usage.cachedInputTokens ?? 0;
    bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.perModel.set(key, bucket);
    this.parent?.add(usage, model);
    for (const listener of this.listeners) listener();
  }

  /** Cumulative estimated cost (USD) across every contributing session. */
  costUsd(model?: string): number {
    if (ScanCostLedger.isCostUnknown(model)) return 0;
    return estimateCost(
      {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cachedInputTokens: this.cachedInputTokens,
        cacheWriteTokens: this.cacheWriteTokens,
      },
      model,
    );
  }
  /** Exact cumulative spend derived from the per-model buckets. */
  totalCostUsd(): number {
    return this.parent?.totalCostUsd() ?? this.runCostUsd();
  }

  /** Cumulative usage for the final cloud cost_update event. */
  tokenUsage(): TokenUsageForPricing {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      ...(this.cacheWriteTokens > 0 ? { cacheWriteTokens: this.cacheWriteTokens } : {}),
    };
  }

  /**
   * The model every contributing session used, when they all agree (and it
   * is a real model id, not the "unknown" bucket). Undefined for multi-model
   * runs and for runs whose sessions never named one — the caller then
   * leaves the model field to its own resolution.
   */
  soleModel(): string | undefined {
    if (this.perModel.size !== 1) return undefined;
    const [key] = this.perModel.keys();
    return key === "unknown" ? undefined : key;
  }

  /**
   * Aggregate the recorded usage into the cloud's per-(provider, model)
   * cost_breakdown shape — the same aggregation agentic-scanner's
   * emitScanCompleted applies to its per-stage tally, sourced here from the
   * true cross-session cumulative. Zero-usage buckets are skipped so the
   * breakdown stays honest. Returns null when nothing was recorded at all,
   * so callers omit cost_usd / cost_breakdown rather than emit a
   * misleading $0.
   */
  costBreakdown(): { costUsd: number; breakdown: CostBreakdownEntry[] } | null {
    const acc = new Map<string, CostBreakdownEntry>();
    for (const [model, usage] of this.perModel) {
      if (
        usage.inputTokens === 0 &&
        usage.outputTokens === 0 &&
        usage.cachedInputTokens === 0 &&
        usage.cacheWriteTokens === 0
      ) {
        continue;
      }
      const priced = model === "unknown" ? undefined : model;
      const provider = modelProvider(priced);
      const key = `${provider}\x1f${model}`;
      const split = ScanCostLedger.isCostUnknown(priced)
        ? { cost_in: 0, cost_out: 0, ...(usage.cachedInputTokens > 0 ? { cost_cache_read: 0 } : {}) }
        : splitCost(usage, priced);
      const existing = acc.get(key);
      if (existing) {
        existing.cost_in += split.cost_in;
        existing.cost_out += split.cost_out;
        if (split.cost_cache_read !== undefined) {
          existing.cost_cache_read =
            (existing.cost_cache_read ?? 0) + split.cost_cache_read;
        }
      } else {
        acc.set(key, {
          provider,
          model,
          cost_in: split.cost_in,
          cost_out: split.cost_out,
          ...(split.cost_cache_read !== undefined
            ? { cost_cache_read: split.cost_cache_read }
            : {}),
        });
      }
    }
    if (acc.size === 0) return null;
    const breakdown = Array.from(acc.values());
    const costUsd = breakdown.reduce(
      (sum, e) => sum + e.cost_in + e.cost_out + (e.cost_cache_read ?? 0),
      0,
    );
    return { costUsd, breakdown };
  }
}
