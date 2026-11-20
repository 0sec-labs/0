/**
 * `0 scan <target>`: a thread that follows the `scan` skill, then its findings as a report.
 *
 * No scan logic lives here. The command resolves the target to a folder, starts a thread with
 * the skill and a budget, waits, and prints what the thread recorded
 * (docs/design/scan-as-a-thread.md). The thread shows up in `0 threads` like any other.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { exportReport, isReportExportFormat } from "@0/engine";
import { consoleTransportOptions, openConsole, type ConsoleClient, type ConsoleTransportOptions } from "../console-client.js";
import { scanPrompt, type ScanReport } from "@0/engine/shared";
import { mergePasses, scanExitCode, scanJson, toScanReport, type ScanOutcome } from "../scan-report.js";
import { finishWithError, UsageError } from "./output.js";
import { asJson, finishedThread, lastAssistantText, usageLine, type FinishedThread, type Json } from "./thread-output.js";

const exec = promisify(execFile);
const FORMATS = ["json", "md", "sarif", "html", "pdf"] as const;
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const DEFAULT_BUDGET_USD = 5;
/** Chosen by measurement: on the same one-file scan it finished in 26s and $0.0014 and recorded its finding first try; glm-5.3-flash took minutes and rejected a dozen `finding` calls. */
export const DEFAULT_SCAN_MODEL = "gpt-6-luna";
const DEFAULT_TIMEOUT_SECONDS = 3600;
/** Consecutive failed status requests before the scan gives up on the console (about a minute with the backoff). */
const MAX_FAILED_POLLS = 12;
/** Passes that run at the same time: more only crowds the model provider and the console. */
const MAX_PARALLEL_PASSES = 3;
const MAX_PASSES = 5;
const GIT_TARGET = /^(git@|git:\/\/|ssh:\/\/git@)|\.git$|^https:\/\/(github|gitlab)\.com\//;

/**
 * The arguments that run this same program as a headless console for one scan. `--port 0` takes any free port, so another
 * console on the default port (a second user, another job on a shared runner, one started from a different home) cannot make
 * this one exit with "already running" and leave the scan without a console.
 */
export function headlessConsoleArgs(entry: string | undefined): string[] {
  return [...(entry && /\.[cm]?js$/.test(entry) ? [entry] : []), "--headless", "--port", "0"];
}

export interface ScanDeps {
  open(options: ConsoleTransportOptions): Promise<ConsoleClient>;
  out(bytes: Uint8Array | string): void;
  err(text: string): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
  writeBytes(path: string, bytes: Uint8Array): void;
  /** The findings stored under a thread id, as the shared report type, from the engine the thread ran on. */
  loadReport(client: ConsoleClient, threadId: string): Promise<ScanReport>;
  /** Start a headless console for this scan; returns how to stop it. Used only when none is running. */
  startConsole(): Promise<() => void>;
  /** What `git status` lists in the folder, or undefined when it is not a git work tree. A scan must leave it as it found it. */
  changedFiles(folder: string): Promise<Set<string> | undefined>;
  /** Make a folder out of a git URL. Returns the folder and how to remove it. */
  clone(url: string): Promise<{ dir: string; dispose(): void }>;
}
const defaults: ScanDeps = {
  open: options => openConsole(options),
  out: bytes => { process.stdout.write(bytes); },
  err: text => process.stderr.write(`${text}\n`),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => new Date(),
  writeBytes: (path, bytes) => writeFileSync(path, bytes, { mode: 0o600 }),
  async loadReport(client, threadId) {
    const report = asJson(await client.request("GET", `/api/scans/${encodeURIComponent(threadId)}/export?format=json`));
    if (!Array.isArray(report.findings)) throw new Error("The engine returned no report for this scan.");
    return report as unknown as ScanReport;
  },
  async changedFiles(folder) {
    try {
      const { stdout } = await exec("git", ["-C", folder, "status", "--porcelain", "--untracked-files=all"], { maxBuffer: 16 * 1024 * 1024 });
      return new Set(stdout.split("\n").filter(Boolean));
    } catch { return undefined; }
  },
  async startConsole() {
    // Run the same program again as `--headless`: the script when node runs a .js file, else the compiled binary itself.
    const child = spawn(process.execPath, headlessConsoleArgs(process.argv[1]), { stdio: "ignore" });
    child.on("error", () => {});
    return () => { child.kill("SIGTERM"); };
  },
  async clone(url) {
    const dir = mkdtempSync(join(tmpdir(), "0-scan-"));
    // An untrusted repository: no hooks, no external transports, shallow, and `--` before the URL.
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--quiet", "--", url, dir]);
    return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  },
};

interface ScanOptions extends ConsoleTransportOptions {
  budget: string; format: string; output?: string; timeout: string; failOn?: string; model?: string; skill: string; passes: string;
}

export interface ResolvedTarget {
  /** Where the code is on this machine. */
  folder: string;
  /** What the thread, the title and the messages call the target: the folder's path, or a git URL without credentials. */
  label: string;
  /** What the report calls it: the same on every machine (the folder's name, or the git URL without credentials). */
  reportTarget: string;
  /** Finding paths are made relative to these. */
  roots: string[];
  dispose?: () => void;
}

/** A git URL without the user name and password a CI job puts in it, which must not reach a thread, a model or a report. */
export function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch { return url; }
}

const realPath = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

/** A folder or a git URL. */
export async function resolveScanTarget(raw: string, deps: Pick<ScanDeps, "clone">): Promise<ResolvedTarget> {
  const target = raw.trim();
  if (!target) throw new UsageError("Supply a folder or a git URL to scan.");
  if (GIT_TARGET.test(target)) {
    const shown = withoutCredentials(target);
    const cloned = await deps.clone(target);
    return { folder: cloned.dir, label: shown, reportTarget: shown, roots: [...new Set([cloned.dir, realPath(cloned.dir)])], dispose: cloned.dispose };
  }
  const folder = resolve(target);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new UsageError(`${target} is not a folder. Pass a folder or a git URL.`);
  }
  return { folder, label: folder, reportTarget: basename(folder) || folder, roots: [...new Set([folder, realPath(folder)])] };
}

function validate(target: string | undefined, options: ScanOptions): void {
  if (!target?.trim()) throw new UsageError("Supply a folder or a git URL to scan.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.skill)) throw new UsageError("--skill must be a skill id such as scan.");
  if (!(FORMATS as readonly string[]).includes(options.format)) throw new UsageError(`--format must be one of: ${FORMATS.join(", ")}.`);
  if (options.format === "pdf" && !options.output) throw new UsageError("PDF is binary; supply -o <file>.");
  const budget = Number(options.budget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) throw new UsageError("--budget must be a positive USD amount up to 1000.");
  const passes = Number(options.passes);
  if (!Number.isInteger(passes) || passes < 1 || passes > MAX_PASSES) throw new UsageError(`--passes must be a whole number from 1 to ${MAX_PASSES}.`);
  const seconds = Number(options.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--timeout must be a positive number of seconds.");
  if (options.failOn !== undefined && !(SEVERITIES as readonly string[]).includes(options.failOn)) throw new UsageError(`--fail-on must be one of: ${SEVERITIES.join(", ")}.`);
}

const NO_CONSOLE = /No console running/;

/** The engine to run on: the one the options name or that is already running, else a headless one started for this scan. */
async function connect(options: ConsoleTransportOptions, deps: ScanDeps): Promise<{ client: ConsoleClient; stop?: () => void }> {
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  try { return { client: await deps.open(options) }; }
  catch (error) { if (!NO_CONSOLE.test(message(error))) throw error; }
  deps.err("no console is running; starting one for this scan");
  const stop = await deps.startConsole();
  for (let attempt = 0; attempt < 60; attempt++) {
    try { return { client: await deps.open(options), stop }; }
    catch (error) { if (!NO_CONSOLE.test(message(error))) { stop(); throw error; } await deps.sleep(500); }
  }
  stop();
  throw new Error("Could not start a console within 30s. Start one with `0 --headless` and run the scan again.");
}

interface PassContext { client: ConsoleClient; deps: ScanDeps; resolved: ResolvedTarget; options: ScanOptions; total: number; budget: number; deadline: number }
interface PassResult { threadId: string; done: FinishedThread; stored: ScanReport; budgetExhausted: boolean; timedOut: boolean; costUsd?: number }

/** One scan thread: start it, wait for it, and read what it stored. Throws when the thread cannot run or the console is lost. */
async function runPass(ctx: PassContext, index: number): Promise<PassResult> {
  const { client, deps, resolved, options, total, budget, deadline } = ctx;
  const runtime = { runtime: { model: options.model ?? DEFAULT_SCAN_MODEL } };
  const title = total > 1 ? `Scan ${resolved.label} (pass ${index + 1} of ${total})` : `Scan ${resolved.label}`;
  const created = asJson(asJson(await client.request("POST", "/api/console/sessions", { ...runtime, title, costCeilingUsd: budget })).session);
  const id = String(created.id);
  const path = `/api/console/sessions/${encodeURIComponent(id)}`;
  try {
    await client.request("PATCH", `${path}/configuration`, { workspacePath: resolved.folder });
    await client.request("POST", `${path}/messages`, { text: scanPrompt(resolved.label, options.skill) });
  } catch (error) {
    // A thread that never started is no use to anyone; do not leave it in the list.
    const removed = await client.request("POST", `${path}/delete`, {}).then(() => true, () => false);
    const reason = error instanceof Error ? error.message : String(error);
    const hint = /model/i.test(reason) ? ` Pick another with --model (default ${DEFAULT_SCAN_MODEL}).` : "";
    throw new Error(`${reason}${hint}${removed ? "" : ` (thread ${id} was created; remove it with \`0 threads delete ${id} --yes\`)`}`);
  }
  deps.err(`scanning ${resolved.label} in thread ${id} (${total > 1 ? `pass ${index + 1} of ${total}, ` : ""}budget $${Number(budget.toFixed(4))})`);

  let snapshot: Json = {};
  let timedOut = false;
  let failedPolls = 0;
  for (;;) {
    await deps.sleep(1000);
    try {
      snapshot = asJson(asJson(await client.request("GET", path)).snapshot);
      failedPolls = 0;
    } catch (error) {
      // A console busy with several scans, or a provider timing out, can miss a status request while the thread keeps working.
      // Give up only after a run of failures, and say where the thread is.
      if (++failedPolls > MAX_FAILED_POLLS) {
        throw new Error(`Lost contact with the console while scanning: ${error instanceof Error ? error.message : String(error)}. The scan may still be running as thread ${id}; its findings are kept (\`0 findings export --scan ${id}\`).`);
      }
      await deps.sleep(Math.min(5000, 1000 * failedPolls));
      continue;
    }
    const session = asJson(snapshot.session);
    const finished = ["failed", "closed", "waiting"].includes(String(session.status)) || (session.status === "ready" && (lastAssistantText(snapshot) !== undefined || snapshot.lastOutcome != null));
    if (finished) break;
    if (Date.now() > deadline) {
      // Stop the thread and report what it stored so far; a scan that ran out of time still has findings.
      timedOut = true;
      await client.request("POST", `${path}/cancel`, {}).catch(() => undefined);
      await deps.sleep(2000);
      snapshot = await client.request("GET", path).then(value => asJson(asJson(value).snapshot), () => snapshot);
      break;
    }
  }
  const done = finishedThread(snapshot);
  const costUsd = typeof done.usage.costUsd === "number" ? done.usage.costUsd : undefined;
  return { threadId: id, done, stored: await deps.loadReport(client, id), budgetExhausted: asJson(done.session).costCeilingExceeded === true, timedOut, ...(costUsd !== undefined ? { costUsd } : {}) };
}

/** Run `count` tasks, at most `limit` at a time, in order of index. */
async function inPool<T>(count: number, limit: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, count) }, async () => {
    while (next < count) { const index = next++; results[index] = await task(index); }
  }));
  return results;
}

export async function runScan(target: string | undefined, options: ScanOptions, deps: ScanDeps = defaults): Promise<void> {
  let resolved: ResolvedTarget | undefined;
  let client: ConsoleClient | undefined;
  let stopConsole: (() => void) | undefined;
  try {
    validate(target, options);
    resolved = await resolveScanTarget(target!, deps);
    const budget = Number(options.budget);
    const total = Number(options.passes);
    const startedAt = deps.now().toISOString();
    const before = await deps.changedFiles(resolved.folder);
    ({ client, stop: stopConsole } = await connect(options, deps));
    // --budget is the total: each pass gets an equal share, so the cost stays predictable however many passes run.
    const ctx: PassContext = { client, deps, resolved, options, total, budget: budget / total, deadline: Date.now() + Number(options.timeout) * 1000 };

    const passErrors: string[] = [];
    const results = (await inPool(total, MAX_PARALLEL_PASSES, async (index): Promise<PassResult | undefined> => {
      // The time limit covers all passes: one that has not started when it runs out is not started.
      if (index > 0 && Date.now() > ctx.deadline) { passErrors.push(`pass ${index + 1} did not start before the time limit`); return undefined; }
      try { return await runPass(ctx, index); }
      catch (error) {
        // One scan has nothing else to fall back on. With several, the others still count.
        if (total === 1) throw error;
        passErrors.push(`pass ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    })).filter((result): result is PassResult => result !== undefined);
    if (!results.length) throw new Error(`No scan pass finished. ${passErrors.join(" ")}`);
    for (const message of passErrors) deps.err(message);

    const failedPasses = total - results.length;
    const merged = mergePasses(results.map(result => result.stored.findings), resolved.roots);
    // The thread has the same tools as any thread, so it could edit the code it reads. Say so if it did.
    const after = before ? await deps.changedFiles(resolved.folder) : undefined;
    const changed = before && after ? [...after].filter(line => !before.has(line)) : [];
    const changedError = changed.length
      ? `The scan changed ${changed.length} file${changed.length === 1 ? "" : "s"} in the target (${changed.slice(0, 5).map(line => line.slice(3)).join(", ")}${changed.length > 5 ? ", ..." : ""}). A scan must not edit the code it reads; review and revert them.`
      : undefined;
    if (changedError) deps.err(changedError);

    const budgetExhausted = results.some(result => result.budgetExhausted);
    const timedOut = results.some(result => result.timedOut);
    const cost = results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
    const costKnown = results.some(result => result.costUsd !== undefined);
    // The summary of the pass that found the most is the best account of what was covered.
    const lead = results.reduce((best, result) => (result.stored.findings.length > best.stored.findings.length ? result : best), results[0]!);
    const failed = results.every(result => (result.done.failed && !result.budgetExhausted && !result.timedOut) || result.done.claimBlocked) || changedError !== undefined;
    const firstError = results.map(result => (!result.budgetExhausted && !result.timedOut ? result.done.error : undefined)).find(Boolean);
    const outcome: ScanOutcome = {
      target: resolved.reportTarget, roots: resolved.roots, threadId: results[0]!.threadId, startedAt, completedAt: deps.now().toISOString(), budgetUsd: budget,
      ...(costKnown ? { costUsd: cost } : {}), budgetExhausted, ...(timedOut ? { timedOut } : {}), failed,
      ...(changedError ? { error: changedError } : failed && firstError ? { error: firstError } : {}), ...(lead.done.reply ? { summary: lead.done.reply } : {}),
      ...(total > 1 ? { passes: { requested: total, completed: results.length, failed: failedPasses }, threadIds: results.map(result => result.threadId) } : {}),
    };

    let body: Uint8Array | string;
    if (options.format === "json") body = `${JSON.stringify(scanJson(outcome, merged), null, 2)}\n`;
    else {
      const format = options.format === "md" ? "markdown" : options.format;
      if (!isReportExportFormat(format)) throw new UsageError(`--format must be one of: ${FORMATS.join(", ")}.`);
      body = (await exportReport(toScanReport(outcome, { ...results[0]!.stored, findings: merged }), format, `0-scan-${results[0]!.threadId}`)).body;
    }
    if (options.output) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      deps.writeBytes(options.output, bytes);
      deps.err(`Wrote ${options.output} (${bytes.byteLength} bytes)`);
    } else deps.out(body);
    const usage = results.length === 1 ? usageLine(results[0]!.done.usage) : `Usage: ${results.length} passes, cost ${costKnown ? `$${cost.toFixed(4)}` : "unknown"}`;
    deps.err(`${merged.length} finding${merged.length === 1 ? "" : "s"}${total > 1 ? ` from ${results.length} of ${total} passes` : ""}${budgetExhausted ? `, stopped at the $${budget} budget (partial)` : timedOut ? `, stopped at the ${options.timeout}s time limit (partial)` : ""}\n${usage}`);
    const code = scanExitCode(outcome, merged, options.failOn as typeof SEVERITIES[number] | undefined);
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    finishWithError(error, deps, false);
  } finally {
    client?.dispose();
    stopConsole?.();
    resolved?.dispose?.();
  }
}

export function registerScanCommand(program: Command, deps: ScanDeps = defaults): void {
  consoleTransportOptions(program.command("scan <target>")
    .description("Scan a folder or git repository for security bugs; prints the findings as a report")
    .option("--budget <usd>", "Stop when the estimated spend reaches this many USD; partial findings are kept", String(DEFAULT_BUDGET_USD))
    .option("--format <format>", `Report format: ${FORMATS.join(", ")}`, "md")
    .option("-o, --output <file>", "Write the report to a file instead of stdout")
    .option("--fail-on <severity>", "Exit 1 when a finding is at or above this severity (critical, high, medium, low, info)")
    .option("--passes <n>", `Scan this many times and merge the findings (a scan misses some issues that another run finds); the budget is split between them, up to ${MAX_PASSES}`, "1")
    .option("--skill <id>", "Skill that holds the scan method", "scan")
    .option("--model <model>", `Model for the scan thread (default: ${DEFAULT_SCAN_MODEL})`)
    .option("--timeout <seconds>", "Maximum seconds to wait for the scan", String(DEFAULT_TIMEOUT_SECONDS)))
    .addHelpText("after", "\nExit codes: 0 done, 1 findings at or above --fail-on or the scan failed, 2 usage error, 3 stopped at the budget.\nThe scan is a thread: follow it with `0 threads list`.")
    .action(async (target: string, options: ScanOptions) => { await runScan(target, options, deps); });
}
