import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding } from "@0/shared";
import type { NativeMessage, NativeRuntime } from "../runtime/types.js";
import { runSourceFix, planSourceFixPublication, publishSourceFixDraftPR } from "./source-fix.js";
import type { GhClient, GitClient } from "../emit/pr-emitter.js";

const tempRepos: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "0-source-fix-"));
  tempRepos.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "auth.js"),
    [
      "export function parse(input) {",
      "  return input; // VULNERABLE",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module" }) + "\n",
  );
  writeFileSync(
    join(root, "test.js"),
    [
      "import assert from 'node:assert/strict';",
      "import { parse } from './src/auth.js';",
      "assert.throws(() => parse(42), TypeError);",
      "assert.equal(parse('accepted'), 'accepted');",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=0-test", "-c", "user.email=0@example.test", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  return root;
}

function finding(): Finding {
  const result: Finding = {
    id: "source-fix-001",
    templateId: "manual",
    title: "Missing input validation",
    description: "input parameter reaches the return path without validation",
    severity: "high",
    category: "missing-validation",
    status: "confirmed",
    evidence: {
      request: "src/auth.js:1",
      response: "parse(42)",
      analysis: "src/auth.js:1 accepts parameter input without validating its type",
    },
    reviewAnnotation: { path: "src/auth.js", startLine: 1 },
    verificationSpec: {
      code: [
        {
          kind: "file-contains",
          file: "src/auth.js",
          pattern: "return input; // VULNERABLE",
        },
      ],
    },
    timestamp: 1,
  };
  Object.assign(result as unknown as Record<string, unknown>, {
    verification_result: { status: "reproduced" },
  });
  return result;
}

function patch(): string {
  return [
    "*** Begin Patch",
    "*** Update File: src/auth.js",
    "@@ export function parse(input) {",
    " export function parse(input) {",
    '+  if (typeof input !== "string") throw new TypeError("input must be string");',
    "-  return input; // VULNERABLE",
    "+  return input;",
    " }",
    "*** End Patch",
  ].join("\n");
}

function runtimeFor(patches: string[], observedMessages?: NativeMessage[][]): NativeRuntime {
  let calls = 0;
  return {
    type: "api",
    async executeNative(_system, messages) {
      observedMessages?.push(messages.map((message) => ({
        ...message,
        content: [...message.content],
      })));
      const candidate = patches[Math.min(calls, patches.length - 1)]!;
      calls += 1;
      return {
        content: [
          {
            type: "tool_use",
            id: `proposal-${calls}`,
            name: "propose_fix",
            input: { patch: candidate, rationale: "Validate input before returning it." },
          },
        ],
        stopReason: "tool_use",
        durationMs: 1,
      };
    },
    async isAvailable() {
      return true;
    },
  };
}

afterEach(() => {
  for (const root of tempRepos.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runSourceFix", () => {
  it("validates a generated patch in an isolated worktree without changing the source repo", async () => {
    const repoRoot = createRepository();

    const result = await runSourceFix({
      repoRoot,
      finding: finding(),
      runtime: runtimeFor([patch()]),
      testCommand: "node test.js",
    });

    expect(result.status).toBe("validated_candidate");
    expect(result.applied).toBe(false);
    expect(result.precondition?.passed).toBe(true);
    expect(result.postcondition?.passed).toBe(false);
    expect(result.test?.exitCode).toBe(0);
    expect(readFileSync(join(repoRoot, "src", "auth.js"), "utf8")).toContain("VULNERABLE");
  });

  it("applies only a candidate that passes its source recheck and test command", async () => {
    const repoRoot = createRepository();

    const result = await runSourceFix({
      repoRoot,
      finding: finding(),
      runtime: runtimeFor([patch()]),
      testCommand: "node test.js",
      apply: true,
    });

    expect(result.status).toBe("applied_and_retested");
    expect(result.applied).toBe(true);
    const source = readFileSync(join(repoRoot, "src", "auth.js"), "utf8");
    expect(source).toContain('typeof input !== "string"');
    expect(source).not.toContain("VULNERABLE");
  });


  it("never applies a patch when the isolated regression command fails", async () => {
    const repoRoot = createRepository();

    const result = await runSourceFix({
      repoRoot,
      finding: finding(),
      runtime: runtimeFor([patch()]),
      testCommand: "node -e 'console.error(\"regression rejected input\"); process.exit(1)'",
      apply: true,
    });

    expect(result.status).toBe("not_fixed");
    expect(result.applied).toBe(false);
    expect(result.test?.exitCode).toBe(1);
    expect(result.test?.stderr).toContain("regression rejected input");
    expect(result.diff).toContain("-  return input; // VULNERABLE");
    expect(readFileSync(join(repoRoot, "src", "auth.js"), "utf8")).toContain("VULNERABLE");
  });
  it("rejects a bad patch, resets the candidate, and retries with the next proposal", async () => {
    const repoRoot = createRepository();
    const invalidPatch = patch().replace("src/auth.js", "src/other.js");
    const observedMessages: NativeMessage[][] = [];

    const result = await runSourceFix({
      repoRoot,
      finding: finding(),
      runtime: runtimeFor([invalidPatch, patch()], observedMessages),
      testCommand: "node test.js",
    });

    expect(result.status).toBe("validated_candidate");
    expect(result.attempts).toEqual([
      expect.objectContaining({ attempt: 1, reason: expect.stringContaining("expected only src/auth.js") }),
    ]);
    expect(observedMessages).toHaveLength(2);
    expect(observedMessages[1]!.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool_result",
        tool_use_id: "proposal-1",
        is_error: true,
      }),
    ]);
  });

  it("refuses to generate a patch when the finding was not independently reproduced", async () => {
    const repoRoot = createRepository();
    const unreproduced = finding();
    delete (unreproduced as unknown as Record<string, unknown>).verification_result;

    const result = await runSourceFix({
      repoRoot,
      finding: unreproduced,
      runtime: runtimeFor([patch()]),
      testCommand: "node test.js",
    });

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toMatch(/reproduced/);
    expect(readFileSync(join(repoRoot, "src", "auth.js"), "utf8")).toContain("VULNERABLE");
  });
});

function publicationFixture(repoRoot: string) {
  const remote = mkdtempSync(join(tmpdir(), "0-fix-local-remote-"));
  tempRepos.push(remote);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoRoot });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repoRoot });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repoRoot });
  const client: GitClient = {
    async run(args, options) {
      return {
        stdout: execFileSync("git", ["-c", "user.name=0-test", "-c", "user.email=0@example.test", ...args], { cwd: options?.cwd, encoding: "utf8" }),
        stderr: "",
      };
    },
  };
  const draftRequests: string[][] = [];
  const gh: GhClient = {
    async isAuthenticated() { return true; },
    async run(args) {
      draftRequests.push(args);
      return { stdout: "https://github.com/fixture/repo/pull/1\n", stderr: "" };
    },
  };
  return { remote, client, gh, draftRequests };
}

async function retainedFix(repoRoot: string, testCommand = "node test.js") {
  const result = await runSourceFix({
    repoRoot, finding: finding(), runtime: runtimeFor([patch()]),
    testCommand, keepWorktree: true,
  });
  if (result.candidate) tempRepos.push(result.candidate.worktree, result.candidate.recordPath);
  return result;
}

describe("verified source-fix draft publication", () => {
  it("requires separate approval and publishes only the reviewed source change without touching new user work", async () => {
    const repoRoot = createRepository();
    const fixture = publicationFixture(repoRoot);
    const result = await retainedFix(repoRoot);
    const worktree = result.candidate!.worktree;
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
    const plan = await planSourceFixPublication(result, { gitClient: fixture.client });
    // A preview cannot create a branch or change the original checkout.
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })).toBe(baseline);
    expect(execFileSync("git", ["branch", "--list", plan.branch], { cwd: repoRoot, encoding: "utf8" })).toBe("");
    await expect(publishSourceFixDraftPR(result, {
      approval: undefined as unknown as "publish-draft-pr", gitClient: fixture.client, ghClient: fixture.gh,
    })).rejects.toThrow(/approval/);
    expect(fixture.draftRequests).toEqual([]);
    writeFileSync(join(repoRoot, "user-note.txt"), "do not publish\n");
    execFileSync("git", ["add", "user-note.txt"], { cwd: repoRoot });
    const originalStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    const published = await publishSourceFixDraftPR(result, { approval: "publish-draft-pr", gitClient: fixture.client, ghClient: fixture.gh });
    expect(published.branch).toBe(plan.branch);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" })).toBe(originalStatus);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })).toBe(baseline);
    expect(readFileSync(join(repoRoot, "src/auth.js"), "utf8")).toContain("VULNERABLE");
    expect(execFileSync("git", ["diff", "--name-only", "main", plan.branch], { cwd: fixture.remote, encoding: "utf8" })).toBe("src/auth.js\n");
    const publishedSource = execFileSync("git", ["show", `${plan.branch}:src/auth.js`], { cwd: fixture.remote, encoding: "utf8" });
    expect(publishedSource).toContain('typeof input !== "string"');
    expect(publishedSource).not.toContain("VULNERABLE");
    expect(fixture.draftRequests).toHaveLength(1);
    expect(fixture.draftRequests[0]).toContain("--draft");
    expect(existsSync(worktree)).toBe(true);
    expect(JSON.parse(readFileSync(result.candidate!.recordPath, "utf8")).test.exitCode).toBe(0);
  });

  it("refuses a modified candidate before committing or pushing", async () => {
    const repoRoot = createRepository();
    const fixture = publicationFixture(repoRoot);
    const result = await retainedFix(repoRoot);
    const plan = await planSourceFixPublication(result, { gitClient: fixture.client });
    writeFileSync(join(result.candidate!.worktree, "src/auth.js"), "export function parse(input) { return input; }\n");
    await expect(publishSourceFixDraftPR(result, { approval: "publish-draft-pr", gitClient: fixture.client, ghClient: fixture.gh })).rejects.toThrow(/changed after review/);
    expect(execFileSync("git", ["branch", "--list", plan.branch], { cwd: fixture.remote, encoding: "utf8" })).toBe("");
    expect(fixture.draftRequests).toEqual([]);
    expect(existsSync(result.candidate!.worktree)).toBe(true);
  });

  it("re-runs regression and cannot publish a previously green candidate whose test now fails", async () => {
    const repoRoot = createRepository();
    const fixture = publicationFixture(repoRoot);
    const result = await retainedFix(repoRoot, "node test.js && test ! -f reject-publication");
    const plan = await planSourceFixPublication(result, { gitClient: fixture.client });
    writeFileSync(join(result.candidate!.worktree, "reject-publication"), "");
    await expect(publishSourceFixDraftPR(result, { approval: "publish-draft-pr", gitClient: fixture.client, ghClient: fixture.gh })).rejects.toThrow(/regression command failed/);
    expect(execFileSync("git", ["branch", "--list", plan.branch], { cwd: fixture.remote, encoding: "utf8" })).toBe("");
    expect(fixture.draftRequests).toEqual([]);
  });

  it("refuses a moved remote baseline rather than including unrelated commits", async () => {
    const repoRoot = createRepository();
    const fixture = publicationFixture(repoRoot);
    const result = await retainedFix(repoRoot);
    writeFileSync(join(repoRoot, "unrelated.txt"), "new user work\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: repoRoot });
    await fixture.client.run(["commit", "-m", "unrelated user commit"], { cwd: repoRoot });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repoRoot });
    await expect(publishSourceFixDraftPR(result, { approval: "publish-draft-pr", gitClient: fixture.client, ghClient: fixture.gh })).rejects.toThrow(/remote base differs/);
    expect(fixture.draftRequests).toEqual([]);
    expect(readFileSync(join(repoRoot, "unrelated.txt"), "utf8")).toBe("new user work\n");
  });

  it("cannot publish unreproduced, missing-source, failed-baseline, failed-test or fabricated candidates", async () => {
    const repoRoot = createRepository();
    const unreproduced = finding();
    delete unreproduced.verification_result;
    const missingSource = finding();
    missingSource.reviewAnnotation = undefined;
    missingSource.evidence = { request: "", response: "" };
    const wrongBaseline = finding();
    wrongBaseline.verificationSpec = { code: [{ kind: "file-contains", file: "src/auth.js", pattern: "already fixed" }] };
    for (const [candidate, testCommand] of [
      [unreproduced, "node test.js"], [missingSource, "node test.js"],
      [wrongBaseline, "node test.js"], [finding(), "node -e 'process.exit(1)'"],
    ] as const) {
      const result = await runSourceFix({ repoRoot, finding: candidate, runtime: runtimeFor([patch()]), testCommand, keepWorktree: true });
      expect(result.candidate).toBeUndefined();
      await expect(publishSourceFixDraftPR(result, { approval: "publish-draft-pr" })).rejects.toThrow(/not generated and verified/);
    }
    await expect(planSourceFixPublication({ status: "validated_candidate", findingId: "template", attempts: [], applied: false, patch: "starter" })).rejects.toThrow(/verified/);
  });

  it("rejects regression commands that mutate the generated diff", async () => {
    const repoRoot = createRepository();
    const result = await retainedFix(repoRoot, "node test.js && printf '\\n// test mutation\\n' >> src/auth.js");
    expect(result.status).toBe("not_fixed");
    expect(result.candidate).toBeUndefined();
    expect(result.attempts.every(({ reason }) => reason.includes("regression command changed"))).toBe(true);
    await expect(publishSourceFixDraftPR(result, { approval: "publish-draft-pr" })).rejects.toThrow(/not generated and verified/);
  });

  it("cannot publish after the repository used by gh changed since review", async () => {
    const repoRoot = createRepository();
    const fixture = publicationFixture(repoRoot);
    const result = await retainedFix(repoRoot);
    await planSourceFixPublication(result, { gitClient: fixture.client });
    execFileSync("git", ["remote", "set-url", "--push", "origin", fixture.remote], { cwd: repoRoot });
    execFileSync("git", ["remote", "set-url", "origin", "/different/repository"], { cwd: repoRoot });
    await expect(publishSourceFixDraftPR(result, { approval: "publish-draft-pr", gitClient: fixture.client, ghClient: fixture.gh })).rejects.toThrow(/fetch repository changed/);
    expect(fixture.draftRequests).toEqual([]);
  });

  it("operator cancellation cannot retain or publish a proposal, even if the runtime returns one", async () => {
    const repoRoot = createRepository();
    const controller = new AbortController();
    const scripted = runtimeFor([patch()]);
    const runtime: NativeRuntime = {
      ...scripted,
      async executeNative(...args) {
        const response = await scripted.executeNative(...args);
        controller.abort();
        return response;
      },
    };
    const result = await runSourceFix({ repoRoot, finding: finding(), runtime, testCommand: "node test.js", keepWorktree: true, signal: controller.signal });
    expect(result.status).toBe("error");
    expect(result.candidate).toBeUndefined();
    expect(readFileSync(join(repoRoot, "src/auth.js"), "utf8")).toContain("VULNERABLE");
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).split("worktree ").length - 1).toBe(1);
    await expect(publishSourceFixDraftPR(result, { approval: "publish-draft-pr" })).rejects.toThrow(/not generated and verified/);
  });
});
