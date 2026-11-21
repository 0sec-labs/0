/**
 * `0 fix <finding>`: a thread that follows the `fix-finding` skill in an isolated git work tree, then a pull request.
 *
 * The thread makes the smallest change it can. This command does the rest, the same way every time: it runs the
 * checks you name, commits on a branch of its own and opens or updates one pull request, a draft when a check
 * fails. It never pushes to the default branch and never merges; a person reviews and merges.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { fixPrompt, type FixPromptFinding } from "@0/engine/shared";
import { osecDB, resolveOsecDbPath } from "@0/engine/storage";
import { consoleTransportOptions, type ConsoleClient, type ConsoleTransportOptions } from "../console-client.js";
import { connect, DEFAULT_SCAN_MODEL, defaultScanDeps, waitForThread, type ScanDeps } from "./scan.js";
import { finishWithError, UsageError } from "./output.js";
import { asJson, finishedThread, usageLine } from "./thread-output.js";

const exec = promisify(execFile);
const DEFAULT_BUDGET_USD = 3;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const BRANCH_PREFIX = "0/fix-";

export interface CheckResult { command: string; code: number; output: string }
export interface FindingToFix extends FixPromptFinding { fingerprint: string }

export interface FixDeps extends Pick<ScanDeps, "open" | "err" | "sleep" | "startConsole"> {
  out(text: string): void;
  git(cwd: string, args: string[]): Promise<string>;
  gh(cwd: string, args: string[]): Promise<string>;
  /** Run one check command in the work tree through the shell. Never throws on a failing command. */
  check(cwd: string, command: string): Promise<CheckResult>;
  loadFinding(id: string, dbPath: string | undefined): FindingToFix;
  makeTemp(): string;
  removeTemp(path: string): void;
  writeFile(path: string, text: string): void;
}

function resolveRow(rows: Array<Record<string, unknown>>, id: string): Record<string, unknown> {
  const exact = rows.find(row => row.id === id);
  if (exact) return exact;
  const matches = rows.filter(row => typeof row.id === "string" && row.id.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  throw new UsageError(matches.length ? `'${id}' matches ${matches.length} findings; use more of the id.` : `Finding '${id}' not found.`);
}

const defaults: FixDeps = {
  open: defaultScanDeps.open, err: defaultScanDeps.err, sleep: defaultScanDeps.sleep, startConsole: defaultScanDeps.startConsole,
  out: text => process.stdout.write(`${text}\n`),
  async git(cwd, args) { return (await exec("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout; },
  async gh(cwd, args) { return (await exec("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout; },
  async check(cwd, command) {
    try {
      const { stdout, stderr } = await exec("/bin/sh", ["-c", command], { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      return { command, code: 0, output: `${stdout}${stderr}` };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      return { command, code: typeof failure.code === "number" ? failure.code : failure.killed ? 124 : 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  },
  loadFinding(id, dbPath) {
    const db = new osecDB(resolveOsecDbPath(dbPath));
    try {
      const row = resolveRow(db.listFindings({ limit: 5000 }) as unknown as Array<Record<string, unknown>>, id);
      const annotation = db.getFindingReviewFields(String(row.id)).reviewAnnotation;
      return {
        id: String(row.id), title: String(row.title), severity: String(row.severity), category: String(row.category),
        tool: typeof row.tool === "string" ? row.tool : null, description: String(row.description ?? ""),
        fingerprint: String(row.fingerprint ?? row.id),
        ...(annotation ? { path: annotation.path, startLine: annotation.startLine, ...(annotation.endLine ? { endLine: annotation.endLine } : {}) } : {}),
        ...(typeof row.evidenceResponse === "string" && row.evidenceResponse ? { snippet: row.evidenceResponse } : {}),
      };
    } finally { db.close(); }
  },
  makeTemp: () => mkdtempSync(join(tmpdir(), "0-fix-")),
  removeTemp: path => rmSync(path, { recursive: true, force: true }),
  writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
};

/** The same finding always gets the same branch, so a second run updates the same pull request. */
export function fixBranchName(fingerprint: string): string {
  return `${BRANCH_PREFIX}${createHash("sha256").update(fingerprint).digest("hex").slice(0, 12)}`;
}

/** Report text goes into a pull request body: stop it from notifying people or referencing other issues. */
const inert = (text: string): string => text.replace(/@/g, "@\u200b").replace(/(^|\s)#(\d)/g, "$1#\u200b$2");

export function pullRequestBody(finding: FindingToFix, summary: string | undefined, checks: CheckResult[]): string {
  const where = finding.path ? `\`${finding.path}${finding.startLine ? `:${finding.startLine}` : ""}\`` : "not given";
  const rows = checks.length ? checks.map(check => `| \`${check.command.replace(/\|/g, "\\|")}\` | ${check.code === 0 ? "passed" : `failed (exit ${check.code})`} |`).join("\n") : "| none were run | |";
  const failed = checks.filter(check => check.code !== 0);
  const tails = failed.map(check => `<details><summary>${inert(check.command)}</summary>\n\n\`\`\`\n${check.output.slice(-2000).replace(/```/g, "'''")}\n\`\`\`\n</details>`).join("\n");
  return [
    `Fixes finding ${finding.id.slice(0, 12)}: ${inert(finding.title)}`,
    "",
    `| Severity | Category | Reported by | Where |\n| --- | --- | --- | --- |\n| ${finding.severity} | ${finding.category} | ${finding.tool ?? "0"} | ${where} |`,
    "",
    "### What changed",
    inert((summary ?? "The change is in the diff.").slice(0, 5000)),
    "",
    "### Checks",
    `| Command | Result |\n| --- | --- |\n${rows}`,
    ...(tails ? ["", tails] : []),
    "",
    failed.length ? "Opened as a draft because a check failed. Review it before it is marked ready." : "A person should review this before merging; 0 does not merge.",
  ].join("\n");
}

export interface FixOptions extends ConsoleTransportOptions {
  repo?: string; base?: string; test?: string[]; budget: string; model?: string; timeout: string; pr: boolean; format?: string;
}

export interface FixOutcome {
  finding: string; branch: string; changed: boolean; committed: boolean; checks: CheckResult[]; verified: boolean;
  pullRequest?: { url: string; created: boolean; draft: boolean }; threadId?: string; costUsd?: number; budgetExhausted?: boolean; timedOut?: boolean; summary?: string;
}

async function defaultBase(deps: FixDeps, repo: string, requested?: string): Promise<{ ref: string; name: string }> {
  if (requested) return { ref: requested, name: requested.replace(/^origin\//, "") };
  try {
    const head = (await deps.git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (head) return { ref: head, name: head.replace(/^origin\//, "") };
  } catch { /* no remote HEAD */ }
  const current = (await deps.git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return { ref: "HEAD", name: current === "HEAD" ? "main" : current };
}

export async function runFix(id: string, options: FixOptions, deps: FixDeps): Promise<FixOutcome | undefined> {
  let stopConsole: (() => void) | undefined;
  let temp: string | undefined;
  let repo = "";
  let tree = "";
  let madeBranch: { repo: string; branch: string; existed: boolean } | undefined;
  let committedBranch = false;
  try {
    const budget = Number(options.budget);
    if (!Number.isFinite(budget) || budget <= 0) throw new UsageError("--budget must be a positive number of USD.");
    if (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0) throw new UsageError("--timeout must be a positive number of seconds.");
    if (options.computer || options.engineUrl) throw new UsageError("0 fix edits files on this machine; run it against the local console.");
    const finding = deps.loadFinding(id, options.dbPath);
    try { repo = (await deps.git(resolve(options.repo ?? process.cwd()), ["rev-parse", "--show-toplevel"])).trim(); }
    catch { throw new UsageError("Run this inside the git repository the finding is in, or pass --repo."); }
    const base = await defaultBase(deps, repo, options.base);
    const branch = fixBranchName(finding.fingerprint);
    if (branch === base.name || !branch.startsWith(BRANCH_PREFIX)) throw new Error("Refusing to work on the base branch.");

    temp = deps.makeTemp();
    tree = join(temp, "tree");
    const branchExisted = await deps.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
    await deps.git(repo, ["worktree", "add", "--quiet", "-B", branch, tree, base.ref]);
    madeBranch = { repo, branch, existed: branchExisted };
    deps.err(`fixing ${finding.title} on branch ${branch} (isolated work tree, base ${base.name})`);

    const { client, stop } = await connect(options, deps);
    stopConsole = stop;
    const outcomeBase = { finding: finding.id, branch };
    const thread = await runThread(client, deps, tree, finding, options, budget);
    const status = (await deps.git(tree, ["status", "--porcelain", "--untracked-files=all"])).trim();
    const common = { ...outcomeBase, threadId: thread.id, ...(thread.costUsd !== undefined ? { costUsd: thread.costUsd } : {}), ...(thread.budgetExhausted ? { budgetExhausted: true } : {}), ...(thread.timedOut ? { timedOut: true } : {}), ...(thread.reply ? { summary: thread.reply } : {}) };
    if (!status) {
      deps.err(thread.error ?? "The thread made no change; no pull request was opened.");
      return { ...common, changed: false, committed: false, checks: [], verified: false };
    }

    const checks: CheckResult[] = [];
    for (const command of options.test ?? []) { deps.err(`running: ${command}`); checks.push(await deps.check(tree, command)); }
    const verified = checks.every(check => check.code === 0) && !thread.failed;

    await deps.git(tree, ["add", "-A"]);
    await deps.git(tree, ["commit", "--quiet", "-m", `fix: ${finding.title.slice(0, 120)}\n\nFinding ${finding.id}`]);
    committedBranch = true;
    const outcome: FixOutcome = { ...common, changed: true, committed: true, checks, verified };
    if (!options.pr) { deps.err(`committed on ${branch}; not pushed (--no-pr).`); return outcome; }

    // The branch is ours and only ours: never the base, always with a lease so a person's later push is not overwritten.
    await deps.git(tree, ["push", "--force-with-lease", "--set-upstream", "origin", `${branch}:${branch}`]);
    const bodyFile = join(temp, "body.md");
    deps.writeFile(bodyFile, pullRequestBody(finding, thread.reply, checks));
    const draft = !verified;
    const existing = JSON.parse((await deps.gh(tree, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,isDraft"])) || "[]") as Array<{ number: number; url: string; isDraft: boolean }>;
    let url: string; let created = false;
    if (existing[0]) {
      url = existing[0].url;
      await deps.gh(tree, ["pr", "edit", String(existing[0].number), "--body-file", bodyFile]);
      if (existing[0].isDraft && !draft) await deps.gh(tree, ["pr", "ready", String(existing[0].number)]);
      if (!existing[0].isDraft && draft) await deps.gh(tree, ["pr", "ready", "--undo", String(existing[0].number)]);
    } else {
      created = true;
      url = (await deps.gh(tree, ["pr", "create", "--base", base.name, "--head", branch, "--title", `fix: ${finding.title.slice(0, 120)}`, "--body-file", bodyFile, ...(draft ? ["--draft"] : [])])).trim().split("\n").pop() ?? "";
    }
    return { ...outcome, pullRequest: { url, created, draft } };
  } finally {
    stopConsole?.();
    if (tree && repo) await deps.git(repo, ["worktree", "remove", "--force", tree]).catch(() => undefined);
    // A branch this run made and never committed to is only clutter.
    if (madeBranch && !madeBranch.existed && !committedBranch) await deps.git(madeBranch.repo, ["branch", "-D", madeBranch.branch]).catch(() => undefined);
    if (temp) deps.removeTemp(temp);
  }
}

async function runThread(client: ConsoleClient, deps: FixDeps, folder: string, finding: FindingToFix, options: FixOptions, budget: number) {
  const created = asJson(asJson(await client.request("POST", "/api/console/sessions", { runtime: { model: options.model ?? DEFAULT_SCAN_MODEL }, title: `Fix: ${finding.title}`.slice(0, 120), costCeilingUsd: budget })).session);
  const id = String(created.id);
  const path = `/api/console/sessions/${encodeURIComponent(id)}`;
  await client.request("PATCH", `${path}/configuration`, { workspacePath: folder });
  await client.request("POST", `${path}/messages`, { text: fixPrompt(finding, { tests: options.test ?? [] }) });
  deps.err(`working in thread ${id} (budget $${Number(budget.toFixed(4))})`);
  const { snapshot, timedOut } = await waitForThread(client, deps, id, Date.now() + Number(options.timeout) * 1000);
  const done = finishedThread(snapshot);
  const costUsd = typeof done.usage.costUsd === "number" ? done.usage.costUsd : undefined;
  return { id, reply: done.reply, error: done.error, failed: done.failed && !timedOut, timedOut, budgetExhausted: asJson(done.session).costCeilingExceeded === true, usage: usageLine(done.usage), ...(costUsd !== undefined ? { costUsd } : {}) };
}

export function registerFixCommand(program: Command, deps: FixDeps = defaults): void {
  const collect = (value: string, previous: string[] = []) => [...previous, value];
  consoleTransportOptions(program.command("fix <finding>")
    .description("Fix one finding in an isolated git work tree and open a pull request for review")
    .option("--repo <dir>", "Git repository the finding is in (default: the current directory)")
    .option("--base <branch>", "Branch to start from and open the pull request against (default: the remote's default branch)")
    .option("--test <command>", "Check to run after the change; repeat for several. A failing check makes the pull request a draft", collect)
    .option("--no-pr", "Commit on the fix branch but do not push or open a pull request")
    .option("--budget <usd>", "Stop when the estimated spend reaches this many USD", String(DEFAULT_BUDGET_USD))
    .option("--model <model>", `Model for the fix thread (default: ${DEFAULT_SCAN_MODEL})`)
    .option("--timeout <seconds>", "Maximum seconds to wait for the fix", String(DEFAULT_TIMEOUT_SECONDS))
    )
    .addHelpText("after", "\nNothing is pushed to the base branch and nothing is merged: the change goes to a branch named 0/fix-<id>, and running it again updates the same pull request.\nExit codes: 0 a verified change (or committed with --no-pr), 1 no change or a failed check, 2 usage error, 3 stopped at the budget or time limit.")
    .action(async (finding: string, options: FixOptions) => {
      try {
        const outcome = await runFix(finding, options, deps);
        if (!outcome) return;
        if (options.format === "json") deps.out(JSON.stringify(outcome, null, 2));
        else if (outcome.pullRequest) deps.out(`${outcome.pullRequest.created ? "Opened" : "Updated"} ${outcome.pullRequest.draft ? "draft " : ""}pull request: ${outcome.pullRequest.url}`);
        else if (outcome.committed) deps.out(`Committed on ${outcome.branch}.`);
        else deps.out("No change was made.");
        process.exitCode = outcome.budgetExhausted || outcome.timedOut ? 3 : outcome.changed && outcome.verified ? 0 : 1;
      } catch (error) { finishWithError(error, { err: deps.err }, options.format === "json"); }
    });
}
