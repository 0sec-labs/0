import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { z } from "zod";
import { CloudClient, loadCloudCredentials } from "@0sec/core";
import { defaultOpenBrowser } from "./auth.js";

const endpoint = "/api/project-setup";
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.coerce.number().int().nonnegative();
const recordSchema = z.object({ repository: z.object({ id: z.string().uuid(), fullName: z.string(), sourceRevision: z.string() }),
  revision, plan: z.record(z.unknown()).nullable(), canEdit: z.boolean() }).passthrough();
const discoverySchema = z.object({ sourceRevision: commit, context: z.object({ summary: z.string(), instructions: z.string(), observations: z.array(z.unknown()) }),
  suggestedTestCommand: z.string().nullable(), unavailablePaths: z.array(z.string()) }).passthrough();
const enrollmentSchema = z.object({ repo_accessible: z.boolean(), repository_id: z.string().uuid().nullable(), installation: z.object({ installed: z.boolean(), install_url: z.string().url().optional() }).optional() }).passthrough();
type OutputOptions = { json?: boolean; open?: boolean };

function client() { const credentials = loadCloudCredentials(); return new CloudClient({ host: credentials.host, token: credentials.token }); }
function output(value: unknown, options: OutputOptions) { process.stdout.write(JSON.stringify(value, null, options.json ? undefined : 2) + "\n"); }
function withNext<T>(value: T, next: string[]): T {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>), next } as T : value;
}
function repositoryInput(value?: string): string {
  return !value || value === "." ? execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim() : value;
}
function repositoryUrl(value?: string): string {
  const raw = repositoryInput(value);
  const normalized = raw.replace(/^git@github\.com:/, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  if (z.string().uuid().safeParse(raw).success) throw new Error("Enrollment requires a GitHub repository URL, not a project UUID.");
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) throw new Error("Use a GitHub repository URL.");
  return url.toString().replace(/\/$/, "");
}
function target(value?: string): string {
  const raw = repositoryInput(value);
  if (z.string().uuid().safeParse(raw).success) return `repository_id=${encodeURIComponent(raw)}`;
  const normalized = raw.replace(/^git@github\.com:/, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) throw new Error("Use a project UUID or GitHub repository URL.");
  return `target=${encodeURIComponent(url.toString().replace(/\/$/, ""))}`;
}
async function project(api: CloudClient, value?: string) { return recordSchema.parse(await api.getJson<unknown>(`${endpoint}?${target(value)}`)); }
async function planFile(path: string): Promise<unknown> {
  if ((await stat(path)).size > 65_536) throw new Error("Project configuration exceeds 64 KiB.");
  return JSON.parse(await readFile(path, "utf8"));
}
function run(action: () => Promise<void>, options: OutputOptions): Promise<void> {
  return action().catch(error => { const message = error instanceof Error ? error.message : "Project operation failed.";
    if (options.json) output({ error: message }, options); else process.stderr.write(message + "\n");
    process.exitCode = 1;
  });
}
async function enroll(value: string | undefined, options: OutputOptions) {
  const api = client();
  const repo = repositoryUrl(value);
  const status = enrollmentSchema.parse(await api.getJson<unknown>(`/api/enrollment/status?target=${encodeURIComponent(repo)}`));
  if (!status.repo_accessible) {
    const installUrl = status.installation?.install_url;
    if (options.open && installUrl) await defaultOpenBrowser(installUrl).catch(() => {});
    throw new Error(`0security cannot access this repository through the connected GitHub App. Install or update the App, then retry${installUrl ? `: ${installUrl}` : "."}`);
  }
  output(withNext(await api.postJson<unknown>(endpoint, { action: "enroll", repositoryId: status.repository_id }), ["Run project setup <repository> --json to review the source-backed proposal."]), options);
}
async function setup(value: string | undefined, options: OutputOptions) {
  const api = client();
  const saved = await project(api, value);
  const discovery = discoverySchema.parse(await api.postJson<unknown>(endpoint, { action: "discover", repositoryId: saved.repository.id }));
  const savedContext = saved.plan?.context;
  const context = savedContext && typeof savedContext === "object" && !Array.isArray(savedContext) ? savedContext : discovery.context;
  const proposal: Record<string, unknown> = { testCommand: saved.plan?.testCommand ?? discovery.suggestedTestCommand,
    setupCommand: saved.plan?.setupCommand ?? "", creditCeiling: saved.plan?.creditCeiling ?? null,
    cadence: saved.plan?.cadence ?? "manual", publicationPolicy: saved.plan?.publicationPolicy ?? "manual", context };
  if (options.json || !process.stdin.isTTY) {
    output({ repositoryId: saved.repository.id, expectedRevision: saved.revision, sourceRevision: discovery.sourceRevision, proposal,
      unavailablePaths: discovery.unavailablePaths, next: ["Set the maximum credits one managed run may use.", "Use project save with the expected revision and source SHA. Saving does not start a scan.", "For approved daily or weekly checks, save with --enable-schedule. Plain save leaves recurring checks paused.", "Use project start only for an approved one-off run. Use project history to resume."] }, options);
    return;
  }
  const questions = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`Configure Zero for ${saved.repository.fullName}\n${discovery.context.summary}\n`);
    const ask = async (label: string, current: unknown) => (await questions.question(`${label}${current === null || current === undefined ? "" : ` [${String(current)}]`}: `)).trim() || current;
    proposal.testCommand = z.string().trim().min(1).max(1000).parse(await ask("Test command", proposal.testCommand));
    proposal.setupCommand = z.string().max(1000).parse(await ask("Setup command", proposal.setupCommand));
    proposal.creditCeiling = z.coerce.number().int().positive().max(1_000_000).parse(await ask("Per-run credit limit", proposal.creditCeiling));
    const parsedContext = discoverySchema.shape.context.parse(context);
    proposal.context = { ...parsedContext, summary: String(await ask("Project summary", parsedContext.summary)), instructions: String(await ask("Instructions for Zero", parsedContext.instructions)) };
    proposal.publicationPolicy = z.enum(["off", "manual", "auto"]).parse(await ask("Fix PR policy (off/manual/auto)", proposal.publicationPolicy));
    output({ sourceRevision: discovery.sourceRevision, plan: proposal }, options);
    if (!/^y(?:es)?$/i.test(await questions.question("Save this configuration? [y/N] "))) return;
    const updated = recordSchema.parse(await api.postJson<unknown>(endpoint, { action: "save", repositoryId: saved.repository.id,
      expectedRevision: saved.revision, sourceRevision: discovery.sourceRevision, plan: proposal, enableSchedule: false }));
    output(updated, options);
    if (!/^y(?:es)?$/i.test(await questions.question("Start a scan using the workspace's credits and approved budget? [y/N] "))) return;
    const idempotencyKey = randomUUID();
    process.stderr.write(`Scan request key: ${idempotencyKey}\n`);
    output(await api.postJson<unknown>(endpoint, { action: "start", repositoryId: saved.repository.id, expectedRevision: updated.revision, idempotencyKey }), options);
  } finally { questions.close(); }
}

export function registerProjectSetupCommand(program: Command): void {
  const root = program.command("project").description("Configure Zero, repository context and operating plans through the same API as the dashboard.");
  root.command("list").option("--json", "Emit machine-readable JSON").action((options: OutputOptions) => run(async () => output(await client().getJson<unknown>(endpoint), options), options));
  root.command("show [project]").description("Read an enrolled project UUID, GitHub URL, or the current checkout.").option("--json", "Emit machine-readable JSON")
    .action((value: string | undefined, options: OutputOptions) => run(async () => output(await project(client(), value), options), options));
  root.command("setup [project]").description("Review source-backed context, approve configuration, then optionally start a scan. JSON mode is read-only.").option("--json", "Return an editable proposal without saving or starting")
    .action((value: string | undefined, options: OutputOptions) => run(() => setup(value, options), options));
  root.command("enroll [repository]").description("Enroll a GitHub repository so Zero can configure and scan it. Does not start a scan.").option("--open", "Open the GitHub App installation link when access is missing").option("--json", "Emit machine-readable JSON")
    .action((value: string | undefined, options: OutputOptions) => run(() => enroll(value, options), options));
  root.command("discover [project]").description("Read repository metadata at a pinned commit; never executes repository code.").option("--json", "Emit machine-readable JSON")
    .action((value: string | undefined, options: OutputOptions) => run(async () => { const api = client(); const saved = await project(api, value); output(await api.postJson<unknown>(endpoint, { action: "discover", repositoryId: saved.repository.id }), options); }, options));
  root.command("save <project>").description("Save an edited operating-plan JSON file. Does not start a scan.").requiredOption("--file <path>", "Operating-plan JSON file")
    .requiredOption("--revision <number>", "Expected current revision, including 0 for first save").requiredOption("--source <sha>", "Reviewed immutable source commit").option("--json", "Emit machine-readable JSON")
    .option("--enable-schedule", "Explicitly approve recurring checks at the saved daily/weekly cadence and per-run credit limit")
    .action((value: string, options: OutputOptions & { file: string; revision: string; source: string; enableSchedule?: boolean }) => run(async () => { const api = client(); const saved = await project(api, value);
      output(withNext(await api.postJson<unknown>(endpoint, { action: "save", repositoryId: saved.repository.id, expectedRevision: revision.parse(options.revision), sourceRevision: commit.parse(options.source), plan: await planFile(options.file), enableSchedule: options.enableSchedule === true }), options.enableSchedule
        ? ["Recurring checks are approved. Read automation.nextRunAt for the next check; no scan started during this save.", "Use project start only when an additional one-off run is wanted."]
        : ["Recurring checks are paused. For approved daily or weekly checks, save the current revision with --enable-schedule.", "Use project start <project> --revision <revision> --idempotency-key <uuid> only when a one-off run is approved."]), options); }, options));
  root.command("history <project> [revision]").option("--json", "Emit machine-readable JSON")
    .action((value: string, requested: string | undefined, options: OutputOptions) => run(async () => { const api = client(); const saved = await project(api, value);
      output(await api.getJson<unknown>(`${endpoint}?repository_id=${saved.repository.id}&view=history${requested === undefined ? "" : `&revision=${z.coerce.number().int().positive().parse(requested)}`}`), options); }, options));
  root.command("suggestions <project>").description("Review source-backed observations from a completed scan without changing saved instructions.").option("--json", "Emit machine-readable JSON")
    .action((value: string, options: OutputOptions) => run(async () => { const api = client(); const saved = await project(api, value);
      output(await api.getJson<unknown>(`${endpoint}?repository_id=${saved.repository.id}&view=suggestions`), options); }, options));
  root.command("restore <project> <revision>").requiredOption("--expected-revision <number>", "Current revision to replace").option("--json", "Emit machine-readable JSON")
    .action((value: string, previous: string, options: OutputOptions & { expectedRevision: string }) => run(async () => { const api = client(); const saved = await project(api, value);
      output(withNext(await api.postJson<unknown>(endpoint, { action: "restore", repositoryId: saved.repository.id, expectedRevision: revision.parse(options.expectedRevision), revision: z.coerce.number().int().positive().parse(previous) }), ["Review the restored revision, then run project start <project> --revision <revision> --idempotency-key <uuid> when execution is approved."]), options); }, options));
  root.command("start <project>").description("Explicitly request credit-funded execution of an approved saved revision.").requiredOption("--revision <number>", "Approved configuration revision")
    .requiredOption("--idempotency-key <uuid>", "Reuse this key when recovering a lost response").option("--json", "Emit machine-readable JSON")
    .action((value: string, options: OutputOptions & { revision: string; idempotencyKey: string }) => run(async () => { const api = client(); const saved = await project(api, value);
      output(withNext(await api.postJson<unknown>(endpoint, { action: "start", repositoryId: saved.repository.id, expectedRevision: z.coerce.number().int().positive().parse(options.revision), idempotencyKey: z.string().uuid().parse(options.idempotencyKey) }), ["Follow the returned scan with service status <scan-id> or service wait <scan-id>."]), options); }, options));
  const slack = root.command("slack").description("Inspect or change optional workspace notifications.");
  slack.command("channels").option("--json", "Emit machine-readable JSON").action((options: OutputOptions) => run(async () => output(await client().getJson<unknown>(`${endpoint}?view=slack-channels`), options), options));
  slack.command("channel <channel-id>").option("--json", "Emit machine-readable JSON").action((channelId: string, options: OutputOptions) => run(async () => output(await client().postJson<unknown>(endpoint, { action: "slack-channel", channelId }), options), options));
  slack.command("clear").description("Stop workspace-channel notifications without disconnecting Slack.").option("--json", "Emit machine-readable JSON").action((options: OutputOptions) => run(async () => output(await client().postJson<unknown>(endpoint, { action: "slack-channel", channelId: null }), options), options));
}
