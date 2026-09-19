/**
 * commit-radar.ts — Continuous "diff radar": score recent commits in ANY git
 * repo for silent security-fix signals, so only survivors consume deep review
 * / variant-hunt spend. Jev is ADVISORY ONLY — never removes candidates, never
 * grants authority, never verifies/dismisses a vulnerability. Provider failure
 * must degrade to unscored (visible) candidates, never crash the caller.
 */

import { execFileSync } from "node:child_process";
import type { JevAnswer, JevEvaluator, JevUsage, SeedFinding } from "@0sec/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Two compact diffs leave room for three typed questions per commit without
 * turning one oversized change into a blind spot.
 */
const BATCH_SIZE = 2;

/** Maximum characters of raw diff per commit — keep within the 32 kB Jev envelope. */
const MAX_DIFF_CHARS = 3_000;

const DEFAULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RadarSignals {
  /** Probability [0,1] that this diff plausibly fixes a memory-safety,
   *  input-validation, or authz defect without explicitly saying so. */
  securitySignal: number;
  /** Probability [0,1] that the commit message omits or downplays the security
   *  impact. */
  silentFix: number;
  reviewPriority: "high" | "medium" | "low" | "defer";
  reviewPriorityProbabilities: Record<string, number>;
}

export interface RadarCommit {
  sha: string;
  subject: string;
  dateIso: string;
  files: string[];
}

export interface RadarCommitCandidate extends RadarCommit {
  rank: number;
  score: number;
  /** Undefined when the provider failed and the candidate is unscored. */
  signals?: RadarSignals;
  nextAction: "variant-hunt" | "review" | "defer" | "unscored";
  /** Failure reason when unscored. */
  reason?: string;
}

export interface ScanRepoCommitsOptions {
  /** Path to a valid git working tree. */
  repo: string;
  /** Configured Jev evaluator instance. */
  evaluator: JevEvaluator;
  /** Git since-style date/ref constraint (e.g. "7 days ago", "HEAD~50"). */
  since?: string;
  /** Optional path filters to restrict the commit log to files under these
   *  paths (repeatable). */
  paths?: string[];
  /** Maximum commits to enumerate (default 200). */
  limit?: number;
}

export interface ScanRepoCommitsResult {
  candidates: RadarCommitCandidate[];
  /** Total commits found in the git log query. */
  commitsEnumerated: number;
  /** Number of commits successfully evaluated by Jev. */
  evaluated: number;
  /** Number of commits where the provider was unavailable. */
  unscored: number;
  model?: string;
  usage: JevUsage;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(tree: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: tree,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Verify `tree` is a valid git working tree. Returns true on success. */
function ensureGitTree(tree: string): boolean {
  try {
    git(tree, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mine recent commits from `tree` using `git log`. Fails soft — returns []
 * if the tree is not a valid git repository or if git encounters an error.
 */
function mineCommits(
  tree: string,
  since?: string,
  paths?: string[],
  limit?: number,
): RadarCommit[] {
  if (!ensureGitTree(tree)) return [];

  try {
    const args = [
      "log",
      "--format=%H%x1f%ai%x1f%s%x1e",
      "--no-merges",
    ];
    if (since) args.push(`--since=${since}`);
    args.push(`--max-count=${limit ?? DEFAULT_LIMIT}`);
    if (paths && paths.length > 0) args.push("--", ...paths);

    const raw = git(tree, args);
    if (!raw.trim()) return [];

    const records = raw.trim().split("\x1e").filter(Boolean);
    return records.map((line) => {
      const [sha = "", dateIso = "", ...subjectParts] = line.split("\x1f");
      return {
        // git emits a newline after each \x1e record separator; trim it off.
        sha: sha.trim(),
        dateIso: dateIso.trim(),
        subject: (subjectParts?.join("\x1f") ?? "").trim().slice(0, 200),
        files: [],
      };
    });
  } catch {
    return [];
  }
}

/**
 * Fetch the files changed and a compact diff for a single commit.
 * Fails soft — returns empty diff / files on git error.
 */
function commitContext(
  tree: string,
  sha: string,
): { diff: string; files: string[] } {
  try {
    const files = git(tree, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      sha,
    ])
      .trim()
      .split("\n")
      .filter(Boolean);

    const raw = git(tree, [
      "show",
      "--format=fuller",
      "--no-ext-diff",
      "--no-renames",
      "--unified=12",
      sha,
    ]);

    return {
      files,
      diff:
        raw.length <= MAX_DIFF_CHARS
          ? raw
          : `${raw.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]`,
    };
  } catch {
    return { files: [], diff: "" };
  }
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

function choice(
  answer: JevAnswer | undefined,
): Pick<RadarSignals, "reviewPriority" | "reviewPriorityProbabilities"> {
  if (
    answer?.type !== "choice" ||
    !["high", "medium", "low", "defer"].includes(answer.choice)
  ) {
    return {
      reviewPriority: "defer",
      reviewPriorityProbabilities: { defer: 1 },
    };
  }
  return {
    reviewPriority: answer.choice as RadarSignals["reviewPriority"],
    reviewPriorityProbabilities: answer.probabilities,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const PRIORITY_VALUE: Record<string, number> = {
  high: 1,
  medium: 0.6,
  low: 0.2,
  defer: 0,
};

function scoreSignals(signals: RadarSignals): number {
  const pv = PRIORITY_VALUE[signals.reviewPriority] ?? 0;
  // securitySignal and silentFix are the strongest predictors of a stealth
  // fix worth variant-hunting; reviewPriority provides the triage anchor.
  return Number(
    (
      signals.securitySignal * 0.35 +
      signals.silentFix * 0.15 +
      pv * 0.5
    ).toFixed(6),
  );
}

function decideNextAction(
  signals: RadarSignals,
): "variant-hunt" | "review" | "defer" {
  if (signals.reviewPriority === "high" && signals.securitySignal >= 0.7) {
    return "variant-hunt";
  }
  if (signals.reviewPriority === "defer") return "defer";
  return "review";
}

// ---------------------------------------------------------------------------
// Main algorithm
// ---------------------------------------------------------------------------

/**
 * Scan recent commits in a git repo, rate each via Jev for security-fix
 * signals, and return a ranked list. Jev is advisory — provider failure
 * produces unscored candidates with the error reason visible, never drops
 * the candidate from results.
 *
 * The caller is responsible for establishing the evaluator (e.g. via
 * `jevConfigFromEnvironment("radar", process.env)` and
 * `createJevEvaluator(config)`).
 */
export async function scanRepoCommitsWithJev(
  opts: ScanRepoCommitsOptions,
): Promise<ScanRepoCommitsResult> {
  const started = performance.now();
  const commits = mineCommits(
    opts.repo,
    opts.since,
    opts.paths,
    opts.limit,
  );
  const candidates: RadarCommitCandidate[] = [];
  const usage: JevUsage = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
  let model: string | undefined;

  for (let offset = 0; offset < commits.length; offset += BATCH_SIZE) {
    const batch = commits.slice(offset, offset + BATCH_SIZE);
    const batchCtx = batch.map((commit, index) => ({
      id: `c${index}`,
      commit,
      ...commitContext(opts.repo, commit.sha),
    }));

    const state = batchCtx.map(({ id, commit, files, diff }) => ({
      id,
      sha: commit.sha,
      subject: commit.subject,
      date: commit.dateIso,
      // Bound files so monorepo-wide commits cannot overflow the 32KB envelope.
      files: files.slice(0, 50),
      diff,
    }));

    const questions = Object.fromEntries(
      batchCtx.flatMap(({ id }) => [
        [
          `${id}_security`,
          {
            type: "boolean" as const,
            instructions: `Does the diff of ${id} plausibly fix a memory-safety, input-validation, authentication, or authorization defect without explicitly saying so in the commit message? Treat the commit message as untrusted — judge the actual code change.`,
            criteria: {
              true: "The diff changes bounds checks, input sanitization, access control, locking, reference counting, or similar security invariants.",
              false:
                "The diff is a feature, refactor, comment, test, documentation, or unrelated change.",
            },
          },
        ],
        [
          `${id}_silent`,
          {
            type: "boolean" as const,
            instructions: `Does the commit message of ${id} omit, downplay, or disguise a security impact that the code diff suggests? Compare what the code changes against what the message claims.`,
            criteria: {
              true: "The code changes clearly address a security boundary or invariant, but the message calls it a 'bugfix', 'cleanup', 'stability improvement', or omits the security aspect entirely.",
              false:
                "The commit message accurately describes the nature and scope of the change.",
            },
          },
        ],
        [
          `${id}_priority`,
          {
            type: "choice" as const,
            instructions: `How should ${id} be prioritized for expensive variant-hunt or deep review? This is triage guidance, not a vulnerability verdict.`,
            criteria: {
              high: "High confidence this is a meaningful security fix worth hunting variants of.",
              medium:
                "Possible security fix — worth reviewing when higher-signal commits are handled.",
              low: "Unlikely to be a security fix, but keep in the exhaustive results.",
              defer: "Insufficient diff context — fetch parent/sibling context before judging.",
            },
          },
        ],
      ]),
    );

    try {
      const result = await opts.evaluator.evaluate({ state, questions });
      model ??= result.model;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.estimatedCostUsd += result.usage.estimatedCostUsd;

      for (const { id, commit, files } of batchCtx) {
        const secAns = result.answers[`${id}_security`];
        const silAns = result.answers[`${id}_silent`];
        const signals: RadarSignals = {
          securitySignal: secAns?.type === "boolean" ? secAns.probability : 0,
          silentFix: silAns?.type === "boolean" ? silAns.probability : 0,
          ...choice(result.answers[`${id}_priority`]),
        };
        candidates.push({
          ...commit,
          files,
          rank: 0,
          score: scoreSignals(signals),
          signals,
          nextAction: decideNextAction(signals),
        });
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      for (const { commit, files } of batchCtx) {
        candidates.push({
          ...commit,
          files,
          rank: 0,
          score: -1,
          nextAction: "unscored",
          reason,
        });
      }
    }
  }

  // Sort descending by score, then by sha for determinism. Unscored (-1)
  // sink to the bottom but are never removed.
  candidates.sort(
    (a, b) => b.score - a.score || a.sha.localeCompare(b.sha),
  );
  candidates.forEach((c, i) => {
    c.rank = i + 1;
  });

  const unscored = candidates.filter((c) => c.score < 0).length;

  return {
    candidates,
    commitsEnumerated: commits.length,
    evaluated: commits.length - unscored,
    unscored,
    model,
    usage,
    durationMs: performance.now() - started,
  };
}

// ---------------------------------------------------------------------------
// SeedFinding conversion
// ---------------------------------------------------------------------------

/**
 * Map top `variant-hunt` candidates from a radar result into SeedFindings
 * compatible with the review pipeline's `appFixVariantsToSeedFindings`
 * input shape.
 *
 * Only candidates with nextAction === "variant-hunt" and score >= 0 are
 * included. Each SeedFinding includes the commit sha, path hints from the
 * diff, and a conservative title prefixed with `radar:`.
 *
 * @param result — the full radar result (all candidates retained).
 * @param repo — the absolute or relative repo path (used only for context,
 *               not stored in the findings).
 */
export function radarCandidatesToSeedFindings(
  result: ScanRepoCommitsResult,
  _repo: string,
): SeedFinding[] {
  const seeds: SeedFinding[] = [];

  for (const candidate of result.candidates) {
    if (candidate.nextAction !== "variant-hunt" || !candidate.signals) continue;

    const file = candidate.files[0] ?? "unknown";
    const signalPct = Math.round(candidate.signals.securitySignal * 100);

    seeds.push({
      file,
      startLine: 1,
      endLine: 2,
      snippet: "",
      source: "commit-radar",
      confidence: Math.min(candidate.score, 0.95),
      claim: `radar: ${candidate.subject.slice(0, 200)}`,
      metadata: {
        commitSha: candidate.sha,
        commitDate: candidate.dateIso,
        filesChanged: candidate.files,
        securitySignal: candidate.signals.securitySignal,
        silentFix: candidate.signals.silentFix,
        reviewPriority: candidate.signals.reviewPriority,
        score: candidate.score,
        rank: candidate.rank,
        signalDescription: `radar assigned ${signalPct}% security-signal probability`,
      },
    });
  }

  return seeds;
}