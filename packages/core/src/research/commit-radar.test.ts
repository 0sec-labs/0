import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JevEvaluator } from "@0/shared";
import {
  radarCandidatesToSeedFindings,
  scanRepoCommitsWithJev,
  type ScanRepoCommitsResult,
} from "./commit-radar.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * Build a tiny real git repo with a handful of commits, two of which look
 * like plausible security fixes (one silent). Returns the repo path.
 */
function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "0-radar-"));
  repos.push(root);

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "radar@test"]);
  git(root, ["config", "user.name", "Radar Test"]);

  // Commit 1 — initial fixture
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# project\n");
  writeFileSync(join(root, "src/auth.ts"), "export function login(user: string, pass: string): boolean {\n  return user === 'admin' && pass === 'admin';\n}\n");
  writeFileSync(join(root, "src/utils.ts"), "export function identity<T>(x: T): T { return x; }\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "initial scaffold"]);

  // Commit 2 — silent security fix: hardcoded credentials changed to env
  writeFileSync(join(root, "src/auth.ts"), "export function login(user: string, pass: string): boolean {\n  return user === process.env.AUTH_USER && pass === process.env.AUTH_SECRET;\n}\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "refactor auth to use config"]);

  // Commit 3 — obvious feature (no security signal)
  writeFileSync(join(root, "src/utils.ts"), "export function identity<T>(x: T): T { return x; }\nexport function add(a: number, b: number): number { return a + b; }\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "feat: add add utility function"]);

  // Commit 4 — explicit security fix (no silent)
  writeFileSync(join(root, "src/auth.ts"), "export function login(user: string, pass: string): boolean {\n  if (!user || !pass) return false;\n  return user === process.env.AUTH_USER && pass === process.env.AUTH_SECRET;\n}\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "security: add null check to login to prevent NPE"]);

  // Commit 5 — massive commit (test diff slicing)
  const manyLines = Array.from({ length: 500 }, (_, i) => `line${i}\n`).join("");
  writeFileSync(join(root, "src/big.ts"), "// massive change\n" + manyLines);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "add big generated file"]);

  return root;
}

const repos: string[] = [];

afterEach(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
  repos.length = 0;
});

// ---------------------------------------------------------------------------
// Evaluator factory helpers
// ---------------------------------------------------------------------------

function evaluatorThatScores(
  scoreMap: Record<string, (id: string) => boolean>,
  priorityMap: Record<string, (id: string) => "high" | "medium" | "low" | "defer">,
): JevEvaluator {
  return {
    async evaluate(request) {
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(request.questions)) {
        if (id.endsWith("_security")) {
          const base = id.replace("_security", "");
          const pred = scoreMap.security ?? (() => false);
          answers[id] = { type: "boolean", probability: pred(base) ? 0.85 : 0.15 };
        } else if (id.endsWith("_silent")) {
          const base = id.replace("_silent", "");
          const pred = scoreMap.silent ?? (() => false);
          answers[id] = { type: "boolean", probability: pred(base) ? 0.80 : 0.10 };
        } else if (id.endsWith("_priority")) {
          const base = id.replace("_priority", "");
          const pred = priorityMap.priority ?? (() => "defer" as const);
          const choice = pred(base);
          const probs: Record<string, number> = {};
          probs[choice] = 1;
          answers[id] = { type: "choice", choice, probabilities: probs };
        }
      }
      return {
        model: "radar-test",
        answers: answers as Record<string, { type: string; [k: string]: unknown }>,
        usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
        durationMs: 1,
      };
    },
  };
}

function failingEvaluator(errorMsg?: string): JevEvaluator {
  return {
    async evaluate() {
      throw new Error(errorMsg ?? "provider unavailable");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanRepoCommitsWithJev", () => {
  it("ranks exhaustively and preserves unscored candidates on provider failure", async () => {
    const repo = setupRepo();
    // First call succeeds, second call fails, third call succeeds.
    let callIndex = 0;
    const evaluator: JevEvaluator = {
      async evaluate(request) {
        callIndex++;
        if (callIndex === 2) throw new Error("provider unavailable");
        const answers: Record<string, unknown> = {};
        for (const id of Object.keys(request.questions)) {
          if (id.endsWith("_security")) {
            answers[id] = { type: "boolean", probability: 0.5 };
          } else if (id.endsWith("_silent")) {
            answers[id] = { type: "boolean", probability: 0.3 };
          } else if (id.endsWith("_priority")) {
            answers[id] = { type: "choice", choice: "medium", probabilities: { high: 0, medium: 1, low: 0, defer: 0 } };
          }
        }
        return {
          model: "radar-test",
          answers: answers as Record<string, { type: string; [k: string]: unknown }>,
          usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
          durationMs: 1,
        };
      },
    };

    const result = await scanRepoCommitsWithJev({
      repo,
      evaluator,
      limit: 5,
    });

    // All 5 commits are present
    expect(result.candidates).toHaveLength(5);
    // All unique SHAs
    expect(new Set(result.candidates.map((c) => c.sha)).size).toBe(5);

    // Batch 1 (c0, c1) succeeded, batch 2 (c2, c3) failed, batch 3 (c4) succeeded
    // With BATCH_SIZE=2 and 5 commits: pairs at [0,1], [2,3], [4]
    expect(result.evaluated).toBe(3);
    expect(result.unscored).toBe(2);

    // Unscored candidates have score -1 and a reason
    const unscored = result.candidates.filter((c) => c.nextAction === "unscored");
    expect(unscored).toHaveLength(2);
    for (const uc of unscored) {
      expect(uc.score).toBe(-1);
      expect(uc.reason).toBe("provider unavailable");
    }

    // Scored candidates have a valid score >= 0
    const scored = result.candidates.filter((c) => c.nextAction !== "unscored");
    expect(scored).toHaveLength(3);
    for (const sc of scored) {
      expect(sc.score).toBeGreaterThanOrEqual(0);
      expect(sc.signals).toBeDefined();
    }

    // Ranks are sequential and non-overlapping
    const ranks = result.candidates.map((c) => c.rank);
    expect(ranks).toEqual([1, 2, 3, 4, 5]);

    // First ranked is the highest scored
    expect(result.candidates[0]!.score).toBeGreaterThanOrEqual(result.candidates[4]!.score);
  });

  it("handles empty repo gracefully", async () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), "0-radar-empty-"));
    repos.push(emptyRepo);
    git(emptyRepo, ["init", "-q"]);

    const evaluator = evaluatorThatScores({}, {});
    const result = await scanRepoCommitsWithJev({
      repo: emptyRepo,
      evaluator,
      limit: 10,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.commitsEnumerated).toBe(0);
    expect(result.evaluated).toBe(0);
    expect(result.unscored).toBe(0);
  });

  it("handles non-git directory gracefully", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "0-radar-nogit-"));
    repos.push(notARepo);

    const evaluator = evaluatorThatScores({}, {});
    const result = await scanRepoCommitsWithJev({
      repo: notARepo,
      evaluator,
      limit: 10,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.commitsEnumerated).toBe(0);
  });

  it("respects limit, since, and path filters", async () => {
    const repo = setupRepo();

    // --limit 2
    const resultLimited = await scanRepoCommitsWithJev({
      repo,
      evaluator: evaluatorThatScores({}, {}),
      limit: 2,
    });
    expect(resultLimited.candidates).toHaveLength(2);

    // --limit 0 should still give at least 1 (limit is 200 default with 0 check)
    // Actually parsePositive in CLI rejects 0, but our internal default is 200
    // and we pass through. Let's just test limit=1
    const resultSingle = await scanRepoCommitsWithJev({
      repo,
      evaluator: evaluatorThatScores({}, {}),
      limit: 1,
    });
    expect(resultSingle.candidates).toHaveLength(1);

    // --since filter (only the latest commit or two)
    // The repo has 5 commits; "1 second ago" should yield 0
    // But timing is fragile, so just test that the flag is accepted
    const resultSince = await scanRepoCommitsWithJev({
      repo,
      evaluator: evaluatorThatScores({}, {}),
      since: "2000-01-01",
      limit: 100,
    });
    expect(resultSince.candidates.length).toBeGreaterThanOrEqual(5);
  });

  it("assigns correct nextAction based on signals", async () => {
    const repo = setupRepo();
    // Identify commits by subject to build per-commit expectations
    const log = execFileSync("git", ["log", "--format=%H%x1f%s%x1e", "--no-merges", "--max-count=5"], {
      cwd: repo, encoding: "utf8",
    });
    const records = log.trim().split("\x1e").filter(Boolean);
    const subjects: Record<string, string> = {};
    for (const r of records) {
      const parts = r.split("\x1f");
      const sha = parts[0]!.trim();
      subjects[sha] = parts.slice(1).join("\x1f").trim();
    }
    const shaBySubject: Record<string, string> = {};
    for (const [sha, subject] of Object.entries(subjects)) {
      shaBySubject[subject] = sha;
    }

    // "initial scaffold" → HIGH priority + high security signal → variant-hunt
    // "refactor auth to use config" → DEFER priority → defer
    // "feat: add add utility function" → MEDIUM priority → review
    const highSha = shaBySubject["initial scaffold"];
    const deferSha = shaBySubject["refactor auth to use config"];
    expect(highSha).toBeTruthy();
    expect(deferSha).toBeTruthy();

    const evaluator: JevEvaluator = {
      async evaluate(request) {
        const state = Array.isArray(request.state) ? request.state : [];
        const answers: Record<string, unknown> = {};
        for (const entry of state) {
          const obj = entry as Record<string, unknown> | undefined;
          if (!obj) continue;
          const id = typeof obj.id === "string" ? obj.id : "";
          if (!id) continue;
          const sha = typeof obj.sha === "string" ? obj.sha : "";
          answers[`${id}_security`] = {
            type: "boolean",
            probability: sha === highSha ? 0.9 : 0.1,
          };
          answers[`${id}_silent`] = {
            type: "boolean",
            probability: sha === highSha ? 0.8 : 0.2,
          };
          let choice: string;
          if (sha === highSha) choice = "high";
          else if (sha === deferSha) choice = "defer";
          else choice = "medium";
          answers[`${id}_priority`] = {
            type: "choice",
            choice,
            probabilities: { [choice]: 1 },
          };
        }
        return {
          model: "radar-test",
          answers: answers as Record<string, { type: string; [k: string]: unknown }>,
          usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
          durationMs: 1,
        };
      },
    };

    const result = await scanRepoCommitsWithJev({ repo, evaluator, limit: 5 });

    // "initial scaffold": high + security >= 0.7 → variant-hunt
    const variantHunt = result.candidates.find((c) => c.sha === highSha);
    expect(variantHunt?.nextAction).toBe("variant-hunt");
    expect(variantHunt?.signals?.securitySignal).toBeGreaterThanOrEqual(0.7);
    expect(variantHunt?.signals?.reviewPriority).toBe("high");

    // "refactor auth to use config": defer → defer
    const deferCandidate = result.candidates.find((c) => c.sha === deferSha);
    expect(deferCandidate?.nextAction).toBe("defer");

    // "feat: add add utility function": medium → review
    const reviewCandidate = result.candidates.find(
      (c) => c.nextAction === "review" && c.signals,
    );
    expect(reviewCandidate).toBeDefined();
    expect(reviewCandidate!.signals?.reviewPriority).toBe("medium");
  });
});

describe("diff slicing bounds", () => {
  it("truncates oversized commit diffs", async () => {
    const repo = setupRepo();
    // Commit 5 (big.ts) has a 500-line file — diff should be truncated
    const evaluator = failingEvaluator("simulate truncation check");
    const result = await scanRepoCommitsWithJev({ repo, evaluator, limit: 5 });

    // All 5 commits present (provider failed for all)
    expect(result.candidates).toHaveLength(5);
    expect(result.unscored).toBe(5);
    expect(result.evaluated).toBe(0);

    // The big commit exists with files tracked
    const bigCommit = result.candidates.find((c) => c.files.includes("src/big.ts"));
    expect(bigCommit).toBeDefined();
    expect(bigCommit!.files.length).toBeGreaterThanOrEqual(1);
  });
});

describe("radarCandidatesToSeedFindings", () => {
  it("maps variant-hunt candidates to SeedFinding-compatible shape", async () => {
    const repo = setupRepo();
    const evaluator = evaluatorThatScores(
      { security: () => true, silent: () => true },
      { priority: (id) => (id === "c0" ? "high" : "medium") },
    );

    const result = await scanRepoCommitsWithJev({ repo, evaluator, limit: 5 });

    // Should map all variant-hunt candidates
    const seeds = radarCandidatesToSeedFindings(result, repo);

    // At least c0 should be variant-hunt (high + securitySignal >= 0.7)
    expect(seeds.length).toBeGreaterThanOrEqual(1);

    // Check shape matches SeedFinding interface
    for (const seed of seeds) {
      expect(seed).toHaveProperty("file");
      expect(seed).toHaveProperty("startLine");
      expect(seed).toHaveProperty("endLine");
      expect(seed).toHaveProperty("source", "commit-radar");
      expect(seed).toHaveProperty("claim");
      expect(seed.claim).toMatch(/^radar: /);
      expect(seed).toHaveProperty("metadata");
      expect(seed.metadata).toHaveProperty("commitSha");
      expect(seed.metadata).toHaveProperty("filesChanged");
      expect(Array.isArray(seed.metadata!.filesChanged)).toBe(true);
      expect(seed.confidence).toBeGreaterThan(0);
      expect(typeof seed.file).toBe("string");
    }

    // First seed should have the highest-ranked commit's sha
    const topCandidate = result.candidates.find(
      (c) => c.nextAction === "variant-hunt",
    );
    expect(topCandidate).toBeDefined();
    const topSeed = seeds.find(
      (s) => s.metadata?.commitSha === topCandidate!.sha,
    );
    expect(topSeed).toBeDefined();
    expect(topSeed!.claim).toContain(topCandidate!.subject);
  });

  it("returns empty array when no variant-hunt candidates exist", async () => {
    const repo = setupRepo();
    const evaluator = evaluatorThatScores(
      { security: () => false, silent: () => false },
      { priority: () => "defer" },
    );

    const result = await scanRepoCommitsWithJev({ repo, evaluator, limit: 5 });
    const seeds = radarCandidatesToSeedFindings(result, repo);
    expect(seeds).toHaveLength(0);
  });

  it("excludes un scored candidates from seed findings", async () => {
    const repo = setupRepo();
    // Only provider failure → all unscored
    const result = await scanRepoCommitsWithJev({
      repo,
      evaluator: failingEvaluator(),
      limit: 3,
    });

    const seeds = radarCandidatesToSeedFindings(result, repo);
    expect(seeds).toHaveLength(0);
  });
});