import { describe, expect, it } from "vitest";
import { BRANCH_PREFIX, fixBranchName, pullRequestBody, runFix, type FixDeps, type FixOptions, type FindingToFix } from "../fix.js";

const finding: FindingToFix = { id: "f-1234567890ab", fingerprint: "sarif-x:abc", title: "SQL injection in search", severity: "high", category: "sql-injection", tool: "foxguard", description: "d", path: "src/db.ts", startLine: 10 };

function harness(overrides: Partial<{ status: string; checks: Record<string, number>; pulls: string; remote: string }> = {}) {
  const calls: string[] = [];
  const requests: Array<[string, string, unknown]> = [];
  const bodies: string[] = [];
  const client = { request: async (method: string, path: string, body?: unknown) => {
    requests.push([method, path, body]);
    if (method === "POST" && path.endsWith("/sessions")) return { session: { id: "t1" } };
    if (method === "GET") return { snapshot: { session: { status: "ready" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Parameterized the query." }] }], usage: { costUsd: 0.12 } } };
    return {};
  } };
  const deps: FixDeps = {
    open: async () => client as never, err: () => {}, sleep: async () => {}, startConsole: async () => () => {}, out: () => {},
    git: async (_cwd, args) => {
      calls.push(`git ${args.join(" ")}`);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "symbolic-ref") return "origin/main\n";
      if (args[0] === "status") return overrides.status ?? " M src/db.ts\n";
      return "";
    },
    gh: async (_cwd, args) => { calls.push(`gh ${args.join(" ")}`); return args[1] === "list" ? overrides.pulls ?? "[]" : args[1] === "create" ? "https://github.com/o/r/pull/7\n" : ""; },
    check: async (_cwd, command) => ({ command, code: overrides.checks?.[command] ?? 0, output: "out" }),
    loadFinding: () => finding, makeTemp: () => "/tmp/x", removeTemp: () => {}, writeFile: (_p, text) => { bodies.push(text); },
  };
  return { deps, calls, requests, bodies };
}
const options = (extra: Partial<FixOptions> = {}): FixOptions => ({ budget: "3", timeout: "60", pr: true, ...extra });

describe("0 findings fix", () => {
  it("names the branch from the finding, the same every time, and never as the base", () => {
    expect(fixBranchName("a")).toBe(fixBranchName("a"));
    expect(fixBranchName("a")).not.toBe(fixBranchName("b"));
    expect(fixBranchName("a").startsWith(BRANCH_PREFIX)).toBe(true);
  });

  it("works in a separate work tree, pushes only its own branch and opens a ready pull request when checks pass", async () => {
    const h = harness();
    const outcome = await runFix("f-1", options({ test: ["pnpm test"] }), h.deps);
    expect(outcome).toMatchObject({ changed: true, committed: true, verified: true, pullRequest: { created: true, draft: false, url: "https://github.com/o/r/pull/7" } });
    const worktree = h.calls.find(call => call.startsWith("git worktree add"))!;
    expect(worktree).toContain(`-B ${fixBranchName(finding.fingerprint)}`);
    const push = h.calls.find(call => call.startsWith("git push"))!;
    expect(push).toContain("--force-with-lease");
    expect(push).toContain(`${fixBranchName(finding.fingerprint)}:${fixBranchName(finding.fingerprint)}`);
    expect(push).not.toContain(":main");
    expect(h.calls.find(call => call.startsWith("gh pr create"))).not.toContain("--draft");
    expect(h.calls.at(-1)).toContain("worktree remove");
    const message = h.requests.find(([, path]) => path.endsWith("/messages"))![2] as { text: string };
    expect(message.text).toContain("pnpm test");
    expect(message.text).toContain("<finding>");
  });

  it("opens a draft when a check fails, and says which", async () => {
    const h = harness({ checks: { "pnpm lint": 2 } });
    const outcome = await runFix("f-1", options({ test: ["pnpm test", "pnpm lint"] }), h.deps);
    expect(outcome).toMatchObject({ verified: false, pullRequest: { draft: true } });
    expect(h.calls.find(call => call.startsWith("gh pr create"))).toContain("--draft");
    expect(h.bodies[0]).toContain("failed (exit 2)");
  });

  it("updates the pull request that already exists instead of opening another", async () => {
    const h = harness({ pulls: JSON.stringify([{ number: 7, url: "https://github.com/o/r/pull/7", isDraft: true }]) });
    const outcome = await runFix("f-1", options({ test: ["pnpm test"] }), h.deps);
    expect(outcome?.pullRequest).toMatchObject({ created: false, draft: false });
    expect(h.calls.some(call => call.startsWith("gh pr create"))).toBe(false);
    expect(h.calls).toContain("gh pr edit 7 --body-file /tmp/x/body.md");
    expect(h.calls).toContain("gh pr ready 7");
  });

  it("opens nothing when the thread changed nothing", async () => {
    const h = harness({ status: "" });
    const outcome = await runFix("f-1", options(), h.deps);
    expect(outcome).toMatchObject({ changed: false, committed: false });
    expect(h.calls.some(call => call.startsWith("git commit") || call.startsWith("git push") || call.startsWith("gh "))).toBe(false);
  });

  it("commits but does not push with --no-pr, and refuses a remote engine", async () => {
    const h = harness();
    const outcome = await runFix("f-1", options({ pr: false }), h.deps);
    expect(outcome).toMatchObject({ committed: true });
    expect(h.calls.some(call => call.startsWith("git push"))).toBe(false);
    await expect(runFix("f-1", options({ computer: "box" }), harness().deps)).rejects.toThrow("local console");
  });

  it("keeps report text from notifying anyone in the pull request", () => {
    const body = pullRequestBody({ ...finding, title: "ping @victim about #12" }, "see @team", [{ command: "a|b", code: 1, output: "```x```" }]);
    expect(body).not.toMatch(/@(?!​)/);
    expect(body).toContain("Opened as a draft");
  });
});

describe("the commit identity", () => {
  it("uses a neutral one when git has none (a clean machine, an Actions runner), and the person's own when it has", async () => {
    const none = harness();
    await runFix("f-1", options({ pr: false }), none.deps);
    expect(none.calls.find(call => call.includes(" commit "))).toContain("-c user.email=noreply@0.security");
    const named = harness();
    const git = named.deps.git;
    named.deps.git = async (cwd, args) => (args[0] === "config" && args[1] === "user.email" ? "dev@example.com\n" : git(cwd, args));
    await runFix("f-1", options({ pr: false }), named.deps);
    expect(named.calls.find(call => call.includes(" commit "))).not.toContain("user.email");
  });
});
