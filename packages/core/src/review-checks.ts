import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homeStateDir } from "@0/shared";
import type { ReviewCheckResult } from "@0/shared";
import { z } from "zod";
import { splitProjectObservationSummary } from "./secure/project-context.js";
import type { ProposedProjectObservation } from "./secure/project-context.js";

export const MAX_ENABLED_REVIEW_CHECKS = 8;
const MAX_STORE_BYTES = 1024 * 1024;
const promptSchema = z.string().min(1).max(2000).refine(value => value.trim().length > 0);
const revisionSchema = z.object({ revision: z.number().int().positive(), prompt: promptSchema }).strict();
const checkSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(120),
  revisions: z.array(revisionSchema).min(1),
  approvedRevision: z.number().int().positive().nullable(),
}).strict().refine(check => check.revisions.every((revision, i) => revision.revision === i + 1)
  && (check.approvedRevision === null || check.approvedRevision === check.revisions.length));
const storeSchema = z.object({ schema: z.literal("0-review-checks-v1"), project: z.string(), checks: z.array(checkSchema) }).strict()
  .refine(store => new Set(store.checks.map(check => check.id)).size === store.checks.length
    && store.checks.filter(check => check.approvedRevision !== null).length <= MAX_ENABLED_REVIEW_CHECKS);
type CheckStore = z.infer<typeof storeSchema>;
export interface ReviewCheck { readonly id: string; readonly name: string; readonly prompt: string; readonly revision: number }
export interface ProjectReviewCheck extends ReviewCheck { readonly enabled: boolean; readonly approvedRevision: number | null }
export interface ProjectReviewChecks { readonly project: string; readonly checks: ProjectReviewCheck[] }

/** Like plugin approval, checks are private, local operator state keyed by real project path. */
export function reviewChecksProject(projectPath: string): string {
  let project = realpathSync(resolve(projectPath));
  if (!statSync(project).isDirectory()) throw new Error("Review checks require a local project directory.");
  try {
    project = realpathSync(execFileSync("git", ["-C", project, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch { /* Non-Git local projects use their exact directory. */ }
  return project;
}

function storeFile(project: string, homeDir?: string): string {
  return join(homeStateDir(homeDir), "review-checks", `${createHash("sha256").update(project).digest("hex")}.json`);
}

export function reviewChecksFilePath(projectPath: string, homeDir?: string): string {
  return storeFile(reviewChecksProject(projectPath), homeDir);
}

function readStore(project: string, file: string): CheckStore {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: "0-review-checks-v1", project, checks: [] };
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) throw new Error("Local review check store exceeds its size limit.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Local review check store is not valid JSON."); }
  const result = storeSchema.safeParse(parsed);
  if (!result.success || result.data.project !== project) throw new Error("Local review check store is malformed or belongs to another project.");
  return result.data;
}

function view(store: CheckStore): ProjectReviewChecks {
  return { project: store.project, checks: store.checks.map(check => {
    const latest = check.revisions[check.revisions.length - 1]!;
    return { id: check.id, name: check.name, prompt: latest.prompt, revision: latest.revision,
      enabled: check.approvedRevision !== null, approvedRevision: check.approvedRevision };
  }) };
}

export function listProjectReviewChecks(projectPath: string, homeDir?: string): ProjectReviewChecks {
  const project = reviewChecksProject(projectPath);
  return view(readStore(project, storeFile(project, homeDir)));
}

/** Snapshot once per review. Prompts are literal data; no Markdown or YAML loader participates. */
export function snapshotProjectReviewChecks(projectPath: string, homeDir?: string): ReviewCheck[] {
  const project = reviewChecksProject(projectPath);
  const store = readStore(project, storeFile(project, homeDir));
  const checks: ReviewCheck[] = [];
  for (const check of store.checks) {
    if (check.approvedRevision === null) continue;
    const approved = check.revisions[check.approvedRevision - 1]!;
    checks.push({ id: check.id, name: check.name, prompt: approved.prompt, revision: approved.revision });
  }
  return checks;
}

export type ReviewCheckMutation =
  | { action: "propose" | "add"; name: string; prompt: string; approved?: boolean }
  | { action: "enable" | "disable" | "remove"; id: string; approved?: boolean; expectedRevision?: number }
  | { action: "set"; id: string; prompt: string; approved?: boolean; expectedRevision?: number };

/** Serialized read/modify/atomic-rename; failed approval/CAS leaves the previous file untouched. */
export function updateProjectReviewChecks(projectPath: string, mutation: ReviewCheckMutation, homeDir?: string): ProjectReviewChecks {
  const project = reviewChecksProject(projectPath);
  const file = storeFile(project, homeDir);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lock = `${file}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Review checks are being updated. If no update is running, remove the stale lock ${lock}.`);
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const store = readStore(project, file);
    if (mutation.action === "add" || mutation.action === "propose") {
      const name = z.string().trim().min(1).max(120).parse(mutation.name);
      const prompt = promptSchema.parse(mutation.prompt);
      if (mutation.action === "add" && !mutation.approved) throw new Error("Enabling a review check requires explicit developer approval (--yes).");
      store.checks.push({ id: randomUUID(), name, revisions: [{ revision: 1, prompt }],
        approvedRevision: mutation.action === "add" ? 1 : null });
    } else {
      const check = store.checks.find(check => check.id === mutation.id);
      if (!check) throw new Error("Review check does not exist in this local project.");
      const revision = check.revisions.length;
      if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== revision) throw new Error(`Review check changed: expected revision ${mutation.expectedRevision}, current revision ${revision}.`);
      if (mutation.action === "enable") {
        if (!mutation.approved) throw new Error("Enabling a review check requires explicit developer approval (--yes).");
        check.approvedRevision = revision;
      } else if (mutation.action === "disable") check.approvedRevision = null;
      else if (mutation.action === "remove") store.checks.splice(store.checks.indexOf(check), 1);
      else {
        const prompt = promptSchema.parse(mutation.prompt);
        if (prompt !== check.revisions[revision - 1]!.prompt) {
          if (check.approvedRevision !== null && !mutation.approved) throw new Error("Updating an enabled check requires explicit developer approval (--yes), or disable it first.");
          check.revisions.push({ revision: revision + 1, prompt });
          if (check.approvedRevision !== null) check.approvedRevision = revision + 1;
        }
      }
    }
    if (store.checks.filter(check => check.approvedRevision !== null).length > MAX_ENABLED_REVIEW_CHECKS) throw new Error(`This project already has ${MAX_ENABLED_REVIEW_CHECKS} enabled review checks.`);
    const text = JSON.stringify(store, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) throw new Error("Local review check store exceeds its size limit.");
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    return view(store);
  } finally {
    try {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } finally { rmdirSync(lock); }
  }
}

/** Strict result envelope, with only the separately validated observation sidecar permitted. */
export function parseReviewCheckResults(summary: string | undefined, checks: readonly ReviewCheck[], allowProjectObservations = false): { checks: ReviewCheckResult[]; projectObservations: ProposedProjectObservation[] } {
  if (!summary) throw new Error("Review checks did not return a result.");
  if (Buffer.byteLength(summary, "utf8") > 32_768) throw new Error("Review check results exceed their size limit.");
  let parsed: unknown;
  let projectObservations: ProposedProjectObservation[] = [];
  try { parsed = JSON.parse(summary); } catch {
    if (!allowProjectObservations) throw new Error("Review check results were not valid JSON.");
    const split = splitProjectObservationSummary(summary);
    projectObservations = split.observations;
    try { parsed = JSON.parse(split.summary); } catch { throw new Error("Review check results were not valid JSON."); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1
    || !("checks" in parsed) || !Array.isArray(parsed.checks) || parsed.checks.length !== checks.length) throw new Error("Review check results were incomplete.");
  const expected = new Map(checks.map(check => [check.id, check.name]));
  const rows = new Map<string, ReviewCheckResult>();
  for (const row of parsed.checks as unknown[]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Malformed review check result.");
    const item = row as Record<string, unknown>;
    if (Object.keys(item).length !== 4 || typeof item.id !== "string" || !expected.has(item.id) || rows.has(item.id)
      || (item.status !== "pass" && item.status !== "issue" && item.status !== "unknown")
      || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 500
      || typeof item.fix !== "string" || item.fix.length > 1000
      || (item.status === "issue" && !item.fix.trim())) throw new Error("Malformed review check result.");
    rows.set(item.id, { id: item.id, name: expected.get(item.id)!, status: item.status, reason: item.reason, fix: item.fix });
  }
  return { checks: checks.map(check => rows.get(check.id)!), projectObservations };
}
