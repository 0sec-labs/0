/**
 * `0 campaign` — self-directed long-running pentest supervisor.
 *
 * Every iteration is an engine-attached chat session titled
 * "Campaign iter N: <slug>", so the whole campaign streams live in the
 * console UI. The supervisor loops: run the session, read the findings
 * that accumulated, ask the model for the NEXT objective, run the next
 * session — until iterations/budget are exhausted or the model declares
 * coverage complete. When no local engine is running on the campaign
 * database, iterations fall back to headless `0 console --print` children
 * with a printed warning.
 *
 * Safety: children and sessions always run under a hard timeout (child
 * tree SIGKILL / engine session cancel); the journal is written
 * atomically after every state change; API keys are never logged.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { connectLocalEngine } from "../local-engine.js";
import { buildObjectiveBrief } from "./campaign-brief.js";
import {
  buildObjectivePrompt,
  generateObjective,
  type CampaignObjective,
} from "./campaign-objective.js";
import {
  callTriageLlm,
  fetchDocsPage,
  OsecTriageDb,
  runDocsTriage,
} from "./campaign-triage.js";
import {
  campaignSessionTitle,
  countFindingsInDb,
  initJournal,
  listFindingSummaries,
  loadJournal,
  parseScanSummary,
  planIterations,
  readScopeHosts,
  sanitizeTarget,
  saveJournal,
  type CampaignIterationRecord,
  type CampaignJournal,
  type CampaignPlannedIteration,
} from "./campaign-journal.js";

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = "openrouter/z-ai/glm-5.3-flash";
const ENGINE_POLL_MS = 5_000;
/** Sessions blocked on operator input (ask_operator) are cancelled after this
 * long so an unattended campaign cannot burn its iteration cap on a question
 * nobody is there to answer. */
const OPERATOR_WAIT_CAP_MS = 10 * 60_000;
const CHILD_OUTPUT_CAP = 16 * 1024 * 1024;
const OBJECTIVE_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface CampaignOptions {
  target: string;
  iterations: number;
  runTimeoutMs: number;
  totalTimeoutMs: number;
  costCeiling: string;
  maxToolCalls: number;
  model: string;
  identities?: string;
  accessControlFixtures?: string;
  scope: string;
  dbPath: string;
  journal: string;
  rateLimit: string;
  pauseBetweenMs: number;
  withScan: boolean;
  dryRun: boolean;
  format: "terminal" | "json";
  /** Docs URL fetched once per campaign for docs-grounded severity triage. */
  docsUrl?: string;
  /** Optional second docs URL for triage context. */
  docsUrl2?: string;
  /** --no-docs-triage disables the docs-triage step entirely. */
  noDocsTriage?: boolean;
}

export interface ChildRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Minimal engine-attached console session surface used by the supervisor. */
export interface CampaignEngine {
  createSession(config: Record<string, unknown>): Promise<unknown>;
  getSession(sessionId: string): Promise<unknown>;
  sendMessage(sessionId: string, text: string): Promise<unknown>;
  getSessionEvents(sessionId: string, after?: number): Promise<unknown>;
  cancelSession(sessionId: string): Promise<unknown>;
  dispose(): Promise<void> | void;
}

export interface CampaignDependencies {
  /** Resolves the local engine for the campaign db, or null when headless. */
  connectEngine?: () => Promise<CampaignEngine | null>;
  spawnChild?: (argv: string[], timeoutMs: number) => Promise<ChildRunResult>;
  generate?: typeof generateObjective;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Docs-grounded triage LLM; defaults to one OpenRouter chat-completions call. */
  triageLlm?: (prompt: string) => Promise<string>;
  /** Docs fetcher for triage context; defaults to the plain https fetch. */
  fetchDocsPage?: (url: string) => Promise<string | null>;
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

function toMillis(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${label} must be a positive number of milliseconds.`);
  return parsed;
}

function toPositiveInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${label} must be a positive integer.`);
  return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Resolve the compiled CLI entrypoint to spawn children from — the same
 * pattern the dashboard daemon uses (`process.argv[1]`).
 */
function cliEntrypoint(): string {
  return process.argv[1] ? resolve(process.argv[1]) : join(process.cwd(), "dist", "index.js");
}

/** Echo a child command line without leaking credential flag values. */
function maskChildArgv(argv: readonly string[]): string {
  const parts: string[] = [];
  let maskNext = false;
  for (const token of argv) {
    if (maskNext) { parts.push("<redacted>"); maskNext = false; continue; }
    if (token === "--api-key" || token === "--engine-token-env") { maskNext = true; parts.push(token); continue; }
    if (/^--(api-key|engine-token-env)=/.test(token)) {
      parts.push(`${token.slice(0, token.indexOf("=") + 1)}<redacted>`);
      continue;
    }
    parts.push(token);
  }
  return parts.join(" ");
}

/** Extract the newest assistant message text from a session snapshot. */
function lastAssistantText(snapshot: unknown): string {
  const messages = record(snapshot)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role !== "assistant") continue;
    const text = messageContent(message);
    if (text) return text;
  }
  return "";
}

function messageContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => record(block)?.text)
    .filter((entry): entry is string => typeof entry === "string")
    .join("");
}

/** Flatten streamed console events into supervisor-visible progress lines. */
function eventLines(payload: unknown): string[] {
  const events = record(payload)?.events;
  if (!Array.isArray(events)) return [];
  const lines: string[] = [];
  for (const event of events) {
    const item = record(event);
    if (!item) continue;
    if (item.type === "assistant-delta" && typeof item.text === "string") {
      const text = item.text.replace(/\s+/g, " ").trim();
      if (text) lines.push(`    ↳ ${text.slice(0, 160)}`);
    } else if (item.type === "tool-start") {
      const call = record(item.call);
      if (call?.name) lines.push(`    ⚙ ${String(call.name)}`);
    }
  }
  return lines;
}

function eventCursor(payload: unknown): number {
  const cursor = record(payload)?.cursor;
  return typeof cursor === "number" ? cursor : 0;
}

function transcriptFromSnapshot(snapshot: unknown): string {
  const messages = record(snapshot)?.messages;
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  for (const message of messages) {
    const item = record(message);
    if (!item) continue;
    const role = item.role === "assistant" ? "engine" : item.role === "user" ? "operator" : String(item.role ?? "?");
    const content = messageContent(item);
    if (!content) continue;
    lines.push(`## ${role}`, "", content, "");
  }
  return lines.join("\n");
}

function delay(ms: number): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
}

// ── Child process execution (timeout + tree kill) ───────────────────────────

let activeChild: ChildProcess | null = null;

/**
 * Run a child CLI command with a mandatory wall-clock cap. On expiry the
 * whole child process group is killed with SIGKILL (the child is spawned
 * detached on POSIX so `-pid` reaches its descendants). The timer/event
 * wiring requires the executor form — Promise.withResolvers cannot
 * resolve before the child events fire.
 */
function runChild(argv: string[], timeoutMs: number): Promise<ChildRunResult> {
  return new Promise((resolveRun) => {
    const detached = process.platform !== "win32";
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      ...(detached ? { detached: true } : {}),
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(detached ? -child.pid : child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, Math.max(1, timeoutMs));
    const settle = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChild = null;
      resolveRun({ stdout, stderr, exitCode, timedOut, ...(error ? { stderr: `${stderr}\n${error}` } : {}) });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < CHILD_OUTPUT_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < CHILD_OUTPUT_CAP) stderr += chunk.toString("utf8");
    });
    child.once("error", (error: Error) => settle(null, error.message));
    child.once("close", (code) => settle(code));
  });
}

// ── Engine attachment ───────────────────────────────────────────────────────

/**
 * Discover the local engine that owns the campaign database — the same
 * discovery `0 console` uses — so campaign sessions stream live in the
 * console UI. Returns null when no engine is running (headless fallback).
 */
export async function connectCampaignEngine(dbPath: string): Promise<CampaignEngine | null> {
  const runtime = await connectLocalEngine({ dbPath, workspace: process.cwd() });
  return runtime === null ? null : runtime as unknown as CampaignEngine;
}

interface ChatIterationResult {
  summary: string;
  sessionId: string | null;
  transcript: string;
  timedOut: boolean;
  costUsd: number;
}

async function waitForEngineTurn(
  engine: CampaignEngine,
  sessionId: string,
  timeoutMs: number,
  out: (text: string) => void,
): Promise<{ snapshot: unknown; timedOut: boolean }> {
  const start = Date.now();
  let eventsAfter = 0;
  while (Date.now() - start <= timeoutMs) {
    const snapshot = await engine.getSession(sessionId);
    const status = sessionStatus(snapshot);
    try {
      const eventsPayload = await engine.getSessionEvents(sessionId, eventsAfter);
      for (const line of eventLines(eventsPayload)) out(`${line}\n`);
      eventsAfter = eventCursor(eventsPayload);
    } catch {
      // event streaming is best-effort; the turn continues regardless
    }
    if (status === "working" || status === "waiting") {
      // A "waiting" session is blocked on operator input (e.g. ask_operator).
      // Nobody may be watching: cap how long we tolerate it, then cancel and
      // move on so a single pending question cannot burn the iteration cap.
      if (status === "waiting" && Date.now() - start > OPERATOR_WAIT_CAP_MS) {
        try {
          await engine.cancelSession(sessionId);
        } catch {
          // session already gone
        }
        return { snapshot: await engine.getSession(sessionId).catch(() => null), timedOut: true };
      }
      await delay(ENGINE_POLL_MS);
      continue;
    }
    if (status === "ready" || status === "failed" || status === "closed") return { snapshot, timedOut: false };
    await delay(ENGINE_POLL_MS);
  }
  try {
    await engine.cancelSession(sessionId);
  } catch {
    // session already gone
  }
  return { snapshot: await engine.getSession(sessionId).catch(() => null), timedOut: true };
}

function sessionStatus(snapshot: unknown): string {
  const session = record(snapshot)?.session;
  const status = record(session)?.status;
  return typeof status === "string" ? status : "";
}

async function runEngineChatIteration(options: {
  engine: CampaignEngine;
  brief: string;
  title: string;
  target: string;
  scopeJson: Record<string, unknown> | null;
  timeoutMs: number;
  out: (text: string) => void;
}): Promise<ChatIterationResult> {
  const { engine, brief, title, target, scopeJson, timeoutMs, out } = options;
  // A configured engine owns its scope; a plain engine takes ours so
  // yolo sessions are scope-bounded. Fall back if the engine insists.
  const createConfig: Record<string, unknown> = { target, title, autonomyMode: "yolo", ...(scopeJson ? { scope: scopeJson } : {}) };
  let created: { id?: unknown } | null;
  try {
    created = record(await engine.createSession(createConfig));
  } catch (error) {
    if (!scopeJson) throw error;
    out(chalk.yellow(`[campaign] engine rejected the campaign scope (${error instanceof Error ? error.message : String(error)}); attaching with the engine's own scope\n`));
    created = record(await engine.createSession({ target, title, autonomyMode: "yolo" }));
  }
  const sessionId = typeof created?.id === "string" ? created.id : null;
  if (sessionId === null) throw new Error("The engine did not return a console session id.");
  try {
    await engine.sendMessage(sessionId, brief);
  } catch (error) {
    return {
      summary: `engine session ${sessionId} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      sessionId,
      transcript: "",
      timedOut: false,
      costUsd: 0,
    };
  }
  const { snapshot, timedOut } = await waitForEngineTurn(engine, sessionId, timeoutMs, out);
  const usage = record(record(snapshot)?.usage);
  const costUsd = typeof usage?.costUsd === "number" ? usage.costUsd : 0;
  const status = sessionStatus(snapshot);
  const transcript = transcriptFromSnapshot(snapshot);
  const summary = timedOut
    ? `engine session ${sessionId} hit its ${Math.round(timeoutMs / 1000)}s cap and was cancelled`
    : status === "failed"
      ? `engine session ${sessionId} failed: ${(lastAssistantText(snapshot) || "turn error").slice(0, 300)}`
      : `engine session ${sessionId} completed: ${(lastAssistantText(snapshot) || "(no assistant text)").slice(0, 300)}`;
  return { summary, sessionId, transcript, timedOut, costUsd };
}

// ── The campaign runner ─────────────────────────────────────────────────────

export interface CampaignRunReport {
  journal: CampaignJournal;
  attached: boolean;
  plan: CampaignPlannedIteration[];
}

/** Recon objective that seeds iteration 1 of the all-chat campaign. */
export const RECON_OBJECTIVE: CampaignObjective = {
  objective:
    "Reconnaissance and surface mapping: enumerate the target's attack surface (routes, parameters, authentication flows, error behavior) and replay the authorized identity matrix to find access-control gaps. Record concrete confirmed issues with save_finding.",
  tests: [
    "Map public routes and parameters from crawled responses",
    "Probe authentication boundaries for each provided identity",
    "Replay private-resource requests across identities to detect missing authorization checks",
  ],
  stop: false,
  reason: "iteration 1 recon brief",
};

export async function runCampaign(options: CampaignOptions, deps: CampaignDependencies = {}): Promise<CampaignRunReport> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? Date.now;
  const generate = deps.generate ?? generateObjective;
  const connectEngine = deps.connectEngine ?? (() => connectCampaignEngine(options.dbPath));
  const spawnChild = deps.spawnChild ?? runChild;
  const journalDir = dirname(options.journal);

  // 1. Journal: load or init, resuming after the last completed iteration.
  const existing = loadJournal(options.journal);
  let journal: CampaignJournal;
  if (existing && existing.target === options.target) {
    journal = existing;
    out(chalk.dim(`[campaign] resuming journal after ${existing.iterations.length} completed iteration(s)\n`));
  } else {
    if (existing) err(chalk.yellow(`[campaign] journal belongs to target '${existing.target}'; starting a fresh campaign for '${options.target}'\n`));
    journal = initJournal(options.target, { ...options }, countFindingsInDb(options.dbPath));
    saveJournal(options.journal, journal);
  }

  const scopeJson = loadScopeJson(options.scope);
  const scopeHosts = readScopeHosts(options.scope);
  const engine = await connectEngine();
  const attached = engine !== null;
  if (attached) {
    out(chalk.green("[campaign] attached to the local engine — sessions stream live in the console view\n"));
  } else {
    err(chalk.yellow(
      `[campaign] no local engine is running for ${options.dbPath} — falling back to headless chat children; sessions will NOT stream in the console view. Run \`0 web\` with the same --db-path for live streaming.\n`,
    ));
  }

  const plan = planIterations({ iterations: options.iterations, withScan: options.withScan });
  const startedAt = now();

  // Docs-grounded severity triage (--docs-url/--docs-url-2, disabled by
  // --no-docs-triage). The docs fetch targets the operator-provided
  // documentation URL, not the target, and happens ONCE per campaign:
  // resumes reuse the pages cached in the journal.
  const docsTriageEnabled = options.noDocsTriage !== true
    && typeof options.docsUrl === "string" && options.docsUrl.length > 0;
  const docsUrls = docsTriageEnabled
    ? [options.docsUrl!, options.docsUrl2].filter((url): url is string => typeof url === "string" && url.length > 0)
    : [];
  if (docsTriageEnabled && journal.docsPages === undefined) {
    const pages: string[] = [];
    for (const url of docsUrls) {
      out(chalk.dim(`[campaign] fetching target docs for severity triage: ${url}\n`));
      const page = await (deps.fetchDocsPage ?? fetchDocsPage)(url);
      if (page === null) {
        err(chalk.yellow(`[campaign] docs fetch failed for ${url}; triage continues without that page\n`));
      }
      pages.push(page ?? "");
    }
    journal.docsPages = pages;
    journal.docsContext = pages.join("\n\n");
    saveJournal(options.journal, journal);
  }
  let aborted = false;
  const abort = () => {
    aborted = true;
  };
  process.once("SIGINT", abort);
  try {
    for (const planned of plan.slice(journal.iterations.length)) {
      if (aborted) {
        journal.iterations.push({
          kind: planned.kind,
          startedAt: new Date(now()).toISOString(),
          finishedAt: new Date(now()).toISOString(),
          exitCode: 130,
          summary: "interrupted (SIGINT) before starting",
          sessionId: null,
        });
        break;
      }
      const elapsed = now() - startedAt;
      const remainingTotal = options.totalTimeoutMs - elapsed;
      if (remainingTotal <= 0) {
        out(chalk.yellow(`[campaign] total timeout reached before iteration ${planned.index}; stopping\n`));
        break;
      }
      // Objective generation (the self-goal step) happens before the chat
      // session starts; a stop verdict ends the campaign.
      let objective: CampaignObjective | undefined;
      if (planned.kind === "chat") {
        objective = journal.iterations.length === 0
          ? RECON_OBJECTIVE
          : await generate({
            model: options.model,
            apiKey: process.env.OPENROUTER_API_KEY ?? "",
            endpoint: OBJECTIVE_ENDPOINT,
            prompt: buildObjectivePrompt({
              target: options.target,
              scopeHosts,
              findings: listFindingSummaries(options.dbPath),
              priorSummaries: journal.iterations.map((entry) => entry.summary),
            }),
          });
        if (objective.stop) {
          out(chalk.green(`[campaign] the model declared coverage complete: ${objective.reason || "stop requested"}\n`));
          break;
        }
      }
      const iterationTimeout = Math.min(options.runTimeoutMs, remainingTotal);
      let result: { record: CampaignIterationRecord; costUsd: number };
      try {
        result = await runIteration(planned, {
          options,
          journal,
          journalDir,
          engine,
          iterationTimeout,
          scopeHosts,
          scopeJson,
          objective,
          out,
          spawnChild,
        });
      } catch (error) {
        // One failed iteration (engine backend timeout, session error) must not
        // kill the campaign: record it and keep going with the next objective.
        const message = error instanceof Error ? error.message : String(error);
        out(chalk.red(`[campaign] iteration ${planned.index} failed: ${message}; continuing\n`));
        result = {
          record: {
            kind: planned.kind,
            startedAt: new Date(now()).toISOString(),
            finishedAt: new Date(now()).toISOString(),
            exitCode: 1,
            summary: `iteration failed: ${message}`,
            sessionId: null,
          },
          costUsd: 0,
        };
      }
      journal.iterations.push(result.record);
      journal.totalCostEstimateUsd += result.costUsd;
      // After each chat iteration (spec): triage NEW findings against the
      // cached docs. An LLM failure skips the pass silently and leaves the
      // cursor in place so the next iteration retries the same findings.
      if (planned.kind === "chat" && docsTriageEnabled && (journal.docsPages ?? []).some((page) => page.length > 0)) {
        const triage = await runDocsTriage({
          db: new OsecTriageDb(options.dbPath),
          docsPages: journal.docsPages ?? [],
          llm: deps.triageLlm ?? ((prompt: string) =>
            callTriageLlm(prompt, { model: options.model, apiKey: process.env.OPENROUTER_API_KEY ?? "" })),
          lastTriagedRowid: journal.lastTriagedRowid,
        });
        journal.lastTriagedRowid = triage.lastTriagedRowid;
        (journal.triageRuns ??= []).push({
          at: new Date(now()).toISOString(),
          checked: triage.checked,
          downgraded: triage.downgraded,
          unchanged: triage.unchanged,
        });
        if (triage.checked > 0) {
          out(chalk.dim(`[campaign] docs triage: ${triage.checked} finding(s) checked, ${triage.downgraded} downgraded, ${triage.unchanged} unchanged\n`));
        }
      }
      saveJournal(options.journal, journal);
      if (planned.index !== plan[plan.length - 1]!.index) await sleep(options.pauseBetweenMs);
    }
  } finally {
    process.removeListener("SIGINT", abort);
    if (engine) await engine.dispose();
  }
  return { journal, attached, plan };
}

async function runIteration(planned: CampaignPlannedIteration, context: {
  options: CampaignOptions;
  journal: CampaignJournal;
  journalDir: string;
  engine: CampaignEngine | null;
  iterationTimeout: number;
  scopeHosts: string[];
  scopeJson: Record<string, unknown> | null;
  objective?: CampaignObjective;
  spawnChild: (argv: string[], timeoutMs: number) => Promise<ChildRunResult>;
  out: (text: string) => void;
}): Promise<{ record: CampaignIterationRecord; costUsd: number }> {
  const { options, journal, journalDir, engine, iterationTimeout, scopeHosts, scopeJson, objective, spawnChild, out } = context;
  const startedAt = new Date().toISOString();
  mkdirSync(journalDir, { recursive: true });
  const pad = String(planned.index).padStart(3, "0");

  if (planned.kind === "scan") {
    const argv = scanChildArgv(options);
    out(chalk.bold(`[campaign] iteration ${planned.index}: breadth scan (timeout ${Math.round(iterationTimeout / 1000)}s)\n`));
    out(`${chalk.dim(`    $ ${maskChildArgv(argv)}`)}\n`);
    const result = await spawnChild(argv, iterationTimeout);
    const parsed = parseScanSummary(result.stdout);
    const transcriptPath = join(journalDir, `iter-${pad}-scan.md`);
    writeFileSync(transcriptPath, result.stdout);
    const summaryBits = [
      `scan exit ${result.exitCode}${result.timedOut ? " (timed out, child tree killed)" : ""}`,
      parsed.attacks !== null ? `${parsed.attacks} attacks` : "",
      parsed.findings !== null ? `${parsed.findings} findings` : "",
      `findings in db: ${countFindingsInDb(options.dbPath)}`,
    ].filter(Boolean).join(", ");
    return {
      record: {
        kind: "scan",
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        summary: summaryBits,
        timedOut: result.timedOut,
        transcriptPath,
      },
      costUsd: 0,
    };
  }

  // Chat iteration with the prepared objective (never undefined here).
  const chatObjective = objective!;
  const title = campaignSessionTitle(planned.index, chatObjective.objective);
  const brief = buildObjectiveBrief(
    options.target,
    scopeHosts,
    chatObjective.objective,
    chatObjective.tests,
    listFindingSummaries(options.dbPath).map((finding) => finding.title),
    planned.index,
  );
  out(chalk.bold(`[campaign] iteration ${planned.index}: ${title} (${Math.round(iterationTimeout / 1000)}s cap)\n`));

  let chat: ChatIterationResult;
  if (engine) {
    chat = await runEngineChatIteration({
      engine,
      brief,
      title,
      target: options.target,
      scopeJson,
      timeoutMs: iterationTimeout,
      out,
    });
  } else {
    const argv = chatChildArgv(options, brief);
    out(`${chalk.dim(`    $ ${maskChildArgv(argv)}`)}\n`);
    const result = await spawnChild(argv, iterationTimeout);
    const transcriptPath = join(journalDir, `iter-${pad}-chat.md`);
    writeFileSync(transcriptPath, result.stdout);
    chat = {
      summary: `headless chat exit ${result.exitCode}${result.timedOut ? " (timed out, child tree killed)" : ""}: ${result.stdout.replace(/\s+/g, " ").trim().slice(0, 260)}`,
      sessionId: null,
      transcript: "",
      timedOut: result.timedOut,
      costUsd: 0,
    };
  }
  const transcriptPath = chat.transcript ? join(journalDir, `iter-${pad}-chat.md`) : undefined;
  if (transcriptPath) writeFileSync(transcriptPath, chat.transcript);
  const findingsBefore = countFindingsInDb(options.dbPath);
  return {
    record: {
      kind: "chat",
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: chat.timedOut ? 124 : null,
      summary: chat.summary,
      sessionId: chat.sessionId,
      objective: chatObjective,
      timedOut: chat.timedOut,
      ...(transcriptPath ? { transcriptPath } : {}),
    },
    costUsd: chat.costUsd,
  };
}

function scanChildArgv(options: CampaignOptions): string[] {
  const argv = [
    cliEntrypoint(),
    "scan",
    "web",
    "--target", options.target,
    "--no-guided",
    "--timeout", String(options.runTimeoutMs),
    "--cost-ceiling", options.costCeiling,
    "--depth", "deep",
    "--model", options.model,
    "--rate-limit", options.rateLimit,
    "--format", "md",
    "--db-path", options.dbPath,
  ];
  if (options.identities) argv.push("--identities", options.identities);
  if (options.accessControlFixtures) argv.push("--access-control-fixtures", options.accessControlFixtures);
  if (existsSync(options.scope)) argv.push("--scope", options.scope);
  return argv;
}

function chatChildArgv(options: CampaignOptions, brief: string): string[] {
  return [
    cliEntrypoint(),
    "chat",
    "--target", options.target,
    "--scope", options.scope,
    "--mode", "yolo",
    "--model", options.model,
    "--db-path", options.dbPath,
    "--max-tool-calls", String(options.maxToolCalls),
    "--print", brief,
  ];
}

function loadScopeJson(scopePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(scopePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ── Report rendering ────────────────────────────────────────────────────────

function renderTerminalReport(journal: CampaignJournal, journalPath: string, attached: boolean): string {
  const lines: string[] = [];
  const last = journal.iterations.length > 0 ? journal.iterations[journal.iterations.length - 1]! : null;
  const elapsedMs = last ? Date.parse(last.finishedAt) - Date.parse(journal.startedAt) : 0;
  const dbPath = record(journal.config)?.dbPath;
  const findingsNow = typeof dbPath === "string" ? countFindingsInDb(dbPath) : journal.findingsBaseline;
  lines.push(chalk.bold.green(`Campaign complete — ${journal.iterations.length} iteration(s)${attached ? " (engine-attached, live in console)" : " (headless fallback)"}`));
  lines.push(`Target: ${journal.target}`);
  for (const [index, entry] of journal.iterations.entries()) {
    const label = entry.kind === "scan" ? "scan" : `chat${entry.sessionId ? ` [session ${entry.sessionId}]` : ""}`;
    lines.push(`  ${index + 1}. ${label} — ${entry.summary}`);
  }
  lines.push(`Findings delta: ${journal.findingsBaseline} → ${findingsNow}`);
  lines.push(`Total estimated cost: $${journal.totalCostEstimateUsd.toFixed(4)}`);
  lines.push(`Total wall clock: ${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`);
  lines.push(`Journal: ${journalPath}`);
  return lines.join("\n");
}

// ── Command registration ────────────────────────────────────────────────────

export function registerCampaignCommand(program: Command, deps: CampaignDependencies = {}, name = "campaign"): void {
  program
    .command(name)
    .description("Run a self-directed long-running pentest campaign as console-visible chat sessions")
    .requiredOption("--target <url>", "Target URL or mcp:// endpoint")
    .option("--iterations <n>", "Total objective-driven chat iterations (default 3)", "3")
    .option("--run-timeout-ms <ms>", "Wall-clock cap per iteration (default 3600000)", "3600000")
    .option("--total-timeout-ms <ms>", "Hard cap for the whole campaign (default 14400000 = 4h)", "14400000")
    .option("--cost-ceiling <usd>", "Per-scan-run cost ceiling passed through with --with-scan (default 10)", "10")
    .option("--max-tool-calls <n>", "Tool-call cap for headless fallback chat children (default 150)", "150")
    .option("--model <id>", "Model id for objective generation and chat sessions", DEFAULT_MODEL)
    .option("--identities <file>", "Passed through to --with-scan and referenced by briefs")
    .option("--access-control-fixtures <file>", "Passed through to --with-scan and referenced by briefs")
    .requiredOption("--scope <file>", "REQUIRED: JSON scope policy (chat sessions run in yolo mode)")
    .option("--db-path <path>", "Findings db (default: <target-sanitized>.db in cwd)")
    .option("--journal <path>", "Campaign journal (default: <db-path>.campaign.json)")
    .option("--rate-limit <spec>", "Rate limit passthrough for --with-scan (default 5)", "5")
    .option("--pause-between-ms <ms>", "Cool-off between iterations (default 30000)", "30000")
    .option("--with-scan", "Prepend one classic breadth-scan iteration before the chat loop", false)
    .option("--dry-run", "Print the planned iteration sequence and exit without spawning anything", false)
    .option("--format <format>", "Supervisor output format: terminal|json", "terminal")
    .option("--docs-url <url>", "Fetch this published-docs URL once per campaign for docs-grounded severity triage of new findings")
    .option("--docs-url-2 <url>", "Optional second docs URL for triage context")
    .option("--no-docs-triage", "Disable docs-grounded severity triage (default ON when --docs-url is provided)")
    .action(async (raw: Record<string, unknown>) => {
      const out = deps.out ?? ((text: string) => process.stdout.write(text));
      const err = deps.err ?? ((text: string) => process.stderr.write(text));
      try {
        const target = String(raw.target);
        const dbPath = typeof raw.dbPath === "string" && raw.dbPath ? raw.dbPath : `${sanitizeTarget(target)}.db`;
        const options: CampaignOptions = {
          target,
          iterations: toPositiveInt(raw.iterations as string | undefined, "iterations"),
          runTimeoutMs: toMillis(raw.runTimeoutMs as string | undefined, "run-timeout-ms"),
          totalTimeoutMs: toMillis(raw.totalTimeoutMs as string | undefined, "total-timeout-ms"),
          costCeiling: String(raw.costCeiling ?? "10"),
          maxToolCalls: toPositiveInt(raw.maxToolCalls as string | undefined, "max-tool-calls"),
          model: typeof raw.model === "string" && raw.model ? raw.model : DEFAULT_MODEL,
          identities: typeof raw.identities === "string" ? raw.identities : undefined,
          accessControlFixtures: typeof raw.accessControlFixtures === "string" ? raw.accessControlFixtures : undefined,
          scope: String(raw.scope),
          dbPath,
          journal: typeof raw.journal === "string" && raw.journal ? raw.journal : `${dbPath}.campaign.json`,
          rateLimit: String(raw.rateLimit ?? "5"),
          pauseBetweenMs: toMillis(raw.pauseBetweenMs as string | undefined, "pause-between-ms"),
          withScan: raw.withScan === true,
          dryRun: raw.dryRun === true,
          format: raw.format === "json" ? "json" : "terminal",
          docsUrl: typeof raw.docsUrl === "string" && raw.docsUrl ? raw.docsUrl : undefined,
          docsUrl2: typeof raw.docsUrl2 === "string" && raw.docsUrl2 ? raw.docsUrl2 : undefined,
          // Commander's --no- negation stores this as docsTriage (true by
          // default, false when --no-docs-triage is passed).
          noDocsTriage: raw.docsTriage === false,
        };
        if (!existsSync(options.scope)) {
          err(chalk.red(`--scope '${options.scope}' does not exist — chat sessions run in yolo mode and require a scope policy.\n`));
          process.exitCode = 2;
          return;
        }
        if (options.dryRun) {
          const plan = planIterations({ iterations: options.iterations, withScan: options.withScan });
          out(`Dry run — planned campaign sequence for ${options.target} (no children spawned, no sessions created):\n`);
          for (const planned of plan) {
            out(`  ${planned.index}. ${planned.kind === "scan"
              ? "scan — breadth scan (headless child)"
              : `chat — engine-attached session "${campaignSessionTitle(planned.index, planned.index === 1 ? RECON_OBJECTIVE.objective : "next objective")}"`}\n`);
          }
          out(`Journal would be written to: ${options.journal}\n`);
          return;
        }
        if (!process.env.OPENROUTER_API_KEY) {
          err(chalk.red("OPENROUTER_API_KEY must be set — the campaign uses it for objective generation and forwards it to chat children.\n"));
          process.exitCode = 2;
          return;
        }
        const { journal, attached } = await runCampaign(options, deps);
        if (options.format === "json") {
          out(`${JSON.stringify(journal, null, 2)}\n`);
        } else {
          out(`${renderTerminalReport(journal, options.journal, attached)}\n`);
        }
      } catch (error) {
        err(chalk.red(`campaign failed: ${error instanceof Error ? error.message : String(error)}\n`));
        process.exitCode = 2;
      }
    });
}
