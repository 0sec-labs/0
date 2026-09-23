// `0 skills` — manage audit-skills methodology bundles via 0cloud.
//
// Capability catalogue:
//   skills list            — list all audit skills for the authenticated org
//   skills show <id>       — show skill detail with revision history
//   skills new             — create a skill from local Markdown files
//   skills import          — import a skill from a GitHub repository
//   skills edit <id>       — create a new revision from updated local files
//   skills sync <id>       — re-fetch the skill from its original GitHub source
//   skills use <id>        — pin a skill revision to a project
//   skills unuse <id>      — unpin a skill from a project
//   skills project <prj>   — list skills assigned to a project
//   skills archive <id>    — archive a skill (disables future bindings)
//
// Every subcommand requires cloud credentials (ZERO_CLOUD_TOKEN or
// `~/.0/cloud.env`) and uses the CloudClient for bearer-authenticated
// HTTP against the cloud dashboard ingress (/api/audit-skills*).

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import {
  CloudClient,
  CloudUnauthorizedError,
  CloudAuthMissingError,
  CloudForbiddenError,
  loadCloudCredentials,
} from "@0/core";
// Wire DTOs mirroring the frozen /api/audit-skills contract
// (0-audit-skills-v1). The @0/core root barrel is a shared-release
// surface this feature must not extend, so the CLI owns its view of the
// HTTP contract. Field shapes must stay assignable to the CloudClient
// method responses in packages/core/src/cloud/client.ts.
interface AuditSkillSource {
  type: "markdown" | "github";
  repository?: string;
  ref?: string;
  commit?: string;
  path?: string;
}
interface AuditSkillSummary {
  id: string;
  name: string;
  description: string;
  latestRevision: number;
  source: AuditSkillSource;
  createdAt: string;
  updatedAt: string;
  projectCount: number;
}
interface AuditSkillsListResponse {
  skills: AuditSkillSummary[];
  projects: Array<{ id: string; fullName: string }>;
}
interface AuditSkillsByProjectResponse {
  project: { id: string; fullName: string };
  assignments: Array<{ skillId: string; skillName: string; revisionId: string; revision: number }>;
  availableSkills: AuditSkillSummary[];
}
interface AuditSkillFile {
  path: string;
  content: string;
}

// ── Credential and client helpers ──

interface CredLoadResult {
  client: CloudClient;
  host: string;
}

function loadClient(): CredLoadResult {
  const creds = loadCloudCredentials();
  const client = new CloudClient({ host: creds.host, token: creds.token });
  return { client, host: creds.host };
}

// ── Table formatting ──

function formatSkillsTable(
  skills: AuditSkillsListResponse["skills"],
): string {
  if (skills.length === 0) return "No audit skills.";
  const rows = skills.map((s) => {
    const src = s.source.type === "github" ? s.source.repository ?? "github" : "markdown";
    const proj = s.projectCount > 0 ? String(s.projectCount) : "-";
    return `${s.id.slice(0, 8)}  ${s.name.padEnd(28).slice(0, 28)}  v${s.latestRevision}  ${proj.padStart(2)} project(s)  ${src}  ${
      s.source.type === "github" && s.source.ref ? `[${s.source.ref}]` : ""
    }`.trimEnd();
  });
  return `  ID        Name                           Rev  Projects  Source\n  ${"-".repeat(72)}\n${rows.map((r) => `  ${r}`).join("\n")}`;
}

function formatRevisionsTable(
  revisions: Array<{ revision: number; sha256: string; createdAt?: string }>,
): string {
  if (revisions.length === 0) return "  No revisions.";
  const rows = revisions.map((r) => {
    const date = r.createdAt ? r.createdAt.slice(0, 10) : "-";
    return `  v${String(r.revision).padEnd(3)}  ${date}  ${r.sha256.slice(0, 16)}`;
  });
  return `  Rev  Date       SHA256\n  ${"-".repeat(40)}\n${rows.join("\n")}`;
}

// ── Error handling helper ──

interface JsonFlag {
  json?: boolean;
}

function handleCloudError(error: unknown, isJson: boolean): never {
  if (error instanceof CloudUnauthorizedError) {
    if (isJson) {
      process.stdout.write(
        JSON.stringify({ error: "token-rejected", message: "Cloud token rejected." }) + "\n",
      );
    } else {
      process.stderr.write(chalk.red("Cloud token rejected.\n"));
    }
    process.exitCode = 2;
    return undefined as never;
  }
  if (error instanceof CloudAuthMissingError) {
    if (isJson) {
      process.stdout.write(
        JSON.stringify({ error: "no-credentials", message: "Run `0 auth login` first." }) + "\n",
      );
    } else {
      process.stderr.write(chalk.red("Run `0 auth login` first.\n"));
    }
    process.exitCode = 1;
    return undefined as never;
  }
  if (error instanceof CloudForbiddenError) {
    if (isJson) {
      process.stdout.write(
        JSON.stringify({ error: "forbidden", message: "Access denied." }) + "\n",
      );
    } else {
      process.stderr.write(chalk.red("Access denied.\n"));
    }
    process.exitCode = 3;
    return undefined as never;
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (isJson) {
    process.stdout.write(JSON.stringify({ error: "request-failed", message: msg }) + "\n");
  } else {
    process.stderr.write(chalk.red(`Failed: ${msg}\n`));
  }
  process.exitCode = 1;
  return undefined as never;
}

// ── Read skill files from disk ──

function readSkillFiles(filePaths: string[], cwd?: string): { path: string; content: string }[] {
  return filePaths.map((fp) => {
    const abs = cwd ? resolve(cwd, fp) : resolve(fp);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${fp}`);
    if (st.size > 131_072) throw new Error(`File too large (>128 KiB): ${fp}`);
    return { path: fp, content: readFileSync(abs, "utf-8") };
  });
}

// ── Subcommand actions ──

async function actionList(opts: JsonFlag): Promise<void> {
  const { client } = loadClient();
  let data: AuditSkillsListResponse;
  try {
    data = await client.listAuditSkills();
  } catch (error) {
    handleCloudError(error, !!opts.json);
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    process.stdout.write(formatSkillsTable(data.skills) + "\n");
  }
}

async function actionShow(skillId: string, opts: JsonFlag): Promise<void> {
  const { client } = loadClient();
  let data;
  try {
    data = await client.getAuditSkill(skillId);
  } catch (error) {
    handleCloudError(error, !!opts.json);
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    const { skill, revisions, assignments } = data;
    process.stdout.write(
      `  ID:           ${skill.id}\n` +
        `  Name:         ${skill.name}\n` +
        `  Description:  ${skill.description || "(none)"}\n` +
        `  Latest rev:   ${skill.latestRevision}\n` +
        `  Source:       ${skill.source.type === "github" ? skill.source.repository ?? "github" : "markdown"}\n` +
        `  Created:      ${skill.createdAt}\n` +
        `  Updated:      ${skill.updatedAt}\n` +
        `  Projects:     ${skill.projectCount}\n\n` +
        (revisions.length > 0
          ? `Revisions:\n${formatRevisionsTable(revisions)}\n\n`
          : "") +
        (assignments.length > 0
          ? `Assignments:\n${assignments.map((a) => `  project=${a.projectId}  revision=${a.revisionId}`).join("\n")}\n`
          : ""),
    );
  }
}

interface NewOptions extends JsonFlag {
  name: string;
  file: string[];
  description?: string;
}

async function actionNew(opts: NewOptions): Promise<void> {
  const { client } = loadClient();
  const files: AuditSkillFile[] = readSkillFiles(opts.file);

  try {
    const result = await client.createAuditSkill({
      name: opts.name,
      description: opts.description,
      files,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(
        `  Created skill: ${result.skill.id}\n` +
          `  Revision:      v${result.revision.revision} (${result.revision.revisionId})\n`,
      );
    }
  } catch (error) {
    handleCloudError(error, !!opts.json);
  }
}

interface ImportOptions extends JsonFlag {
  ref?: string;
  path?: string;
  name?: string;
}

async function actionImport(repo: string, opts: ImportOptions): Promise<void> {
  const { client } = loadClient();
  try {
    const result = await client.importAuditSkillFromGithub({
      repository: repo,
      ref: opts.ref,
      path: opts.path,
      name: opts.name,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(
        `  Imported skill: ${result.skill.id}\n` +
          `  Name:           ${result.skill.name}\n` +
          `  Revision:       v${result.revision.revision} (${result.revision.revisionId})\n`,
      );
    }
  } catch (error) {
    handleCloudError(error, !!opts.json);
  }
}

interface EditOptions extends JsonFlag {
  file: string[];
  expectedRevision?: number;
  name?: string;
  description?: string;
}

async function actionEdit(skillId: string, opts: EditOptions): Promise<void> {
  const { client } = loadClient();
  const files: AuditSkillFile[] = readSkillFiles(opts.file);

  try {
    const result = await client.createAuditSkillRevision(skillId, {
      expectedRevision: opts.expectedRevision ?? 0,
      files,
      name: opts.name,
      description: opts.description,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(
        `  Saved revision: v${result.revision.revision} (${result.revision.revisionId})\n`,
      );
    }
  } catch (error) {
    handleCloudError(error, !!opts.json);
  }
}

interface SyncOptions extends JsonFlag {
  expectedRevision: number;
}

async function actionSync(skillId: string, opts: SyncOptions): Promise<void> {
  const { client } = loadClient();
  try {
    const result = await client.syncAuditSkill(skillId, opts.expectedRevision);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(
        `  Synced: v${result.revision.revision} (${result.revision.revisionId})\n`,
      );
    }
  } catch (error) {
    handleCloudError(error, !!opts.json);
  }
}

interface UseOptions extends JsonFlag {
  project: string;
  revision?: string;
}

async function actionUse(skillId: string, opts: UseOptions): Promise<void> {
  const { client } = loadClient();
  let revisionId = opts.revision;

  // If no revision specified, resolve to latest
  if (!revisionId) {
    try {
      const detail = await client.getAuditSkill(skillId);
      const latest = detail.revisions.reduce(
        (best, r) => (r.revision > best.revision ? r : best),
        detail.revisions[0],
      );
      if (!latest) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ error: "no-revisions", message: "Skill has no revisions." }) + "\n");
        } else {
          process.stderr.write(chalk.red("Skill has no revisions.\n"));
        }
        process.exitCode = 1;
        return;
      }
      revisionId = latest.revisionId;
    } catch (error) {
      handleCloudError(error, !!opts.json);
      return;
    }
  }

  // Resolve project <owner/repo> to projectId via list response
  let projectId = opts.project;
  if (!projectId.includes("/")) {
    // Already a UUID — use directly
  } else {
    // FullName style — look up from server
    try {
      const list = await client.listAuditSkills();
      const found = list.projects.find((p) => p.fullName === opts.project);
      if (!found) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ error: "project-not-found", message: `No project matching "${opts.project}" in this org.` }) + "\n");
        } else {
          process.stderr.write(chalk.red(`No project matching "${opts.project}" in this org.\n`));
        }
        process.exitCode = 1;
        return;
      }
      projectId = found.id;
    } catch (error) {
      handleCloudError(error, !!opts.json);
      return;
    }
  }

  try {
    const result = await client.assignAuditSkill(skillId, projectId, revisionId);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(
        `  Assigned skill to project ${opts.project} (revision ${revisionId})\n`,
      );
    }
  } catch (error) {
    handleCloudError(error, !!opts.json);
  }
}

interface UnuseOptions extends JsonFlag {
  project: string;
}

async function actionUnuse(skillId: string, opts: UnuseOptions): Promise<void> {
  const { client } = loadClient();

  // Resolve project <owner/repo> to projectId
  let projectId = opts.project;
  if (projectId.includes("/")) {
    try {
      const list = await client.listAuditSkills();
      const found = list.projects.find((p) => p.fullName === opts.project);
      if (!found) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ error: "project-not-found", message: `No project matching "${opts.project}" in this org.` }) + "\n");
        } else {
          process.stderr.write(chalk.red(`No project matching "${opts.project}" in this org.\n`));
        }
        process.exitCode = 1;
        return;
      }
      projectId = found.id;
    } catch (error) {
      handleCloudError(error, !!opts.json);
      return;
    }
  }

  try {
    const result = await client.unassignAuditSkill(skillId, projectId);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(`  Unassigned skill from project ${opts.project}\n`);
    }
  } catch (error) {
    handleCloudError(error, !!opts.json);
  }
}

interface ProjectOptions extends JsonFlag {
  json?: boolean;
}

async function actionProject(projectArg: string, opts: ProjectOptions): Promise<void> {
  const { client } = loadClient();

  let projectId = projectArg;
  if (projectArg.includes("/")) {
    try {
      const list = await client.listAuditSkills();
      const found = list.projects.find((p) => p.fullName === projectArg);
      if (!found) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ error: "project-not-found", message: `No project matching "${projectArg}" in this org.` }) + "\n");
        } else {
          process.stderr.write(chalk.red(`No project matching "${projectArg}" in this org.\n`));
        }
        process.exitCode = 1;
        return;
      }
      projectId = found.id;
    } catch (error) {
      handleCloudError(error, !!opts.json);
      return;
    }
  }

  let data: AuditSkillsByProjectResponse;
  try {
    data = await client.listAuditSkillsByProject(projectId);
  } catch (error) {
    handleCloudError(error, !!opts.json);
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    process.stdout.write(`  Project: ${data.project.fullName} (${data.project.id})\n\n`);
    if (data.assignments.length > 0) {
      process.stdout.write("  Assigned skills:\n");
      for (const a of data.assignments) {
        process.stdout.write(`    ${a.skillName} (v${a.revision}) — ${a.skillId}\n`);
      }
      process.stdout.write("\n");
    }
    if (data.availableSkills.length > 0) {
      process.stdout.write("  Available skills:\n");
      process.stdout.write(formatSkillsTable(data.availableSkills) + "\n");
    } else {
      process.stdout.write("  No other skills available.\n");
    }
  }
}

async function actionArchive(skillId: string, opts: JsonFlag): Promise<void> {
  const { client } = loadClient();
  try {
    await client.archiveAuditSkill(skillId);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ success: true, id: skillId }) + "\n");
    } else {
      process.stdout.write(`  Archived: ${skillId}\n`);
    }
  } catch (error) {
    handleCloudError(error, !!opts.json);
  }
}

// ── Commander registration ──

export function registerAuditSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage audit-skills methodology bundles (cloud). Requires cloud credentials (`0 auth login`).");

  skills
    .command("list")
    .description("List all audit skills for the authenticated organization.")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionList);

  skills
    .command("show <id>")
    .description("Show detail, revision history, and project assignments for a skill.")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionShow);

  skills
    .command("new")
    .description("Create a new markdown-based audit skill from local files.")
    .requiredOption("--name <name>", "Skill name")
    .option("--description <desc>", "Optional description")
    .requiredOption("--file <paths...>", "Markdown file(s) to include (SKILL.md must be first)")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionNew);

  skills
    .command("import <owner/repo>")
    .description("Import an audit skill from a GitHub repository folder or .md file.")
    .option("--ref <ref>", "Branch, tag, or commit SHA (default: HEAD)")
    .option("--path <path>", "Path within the repo to the bundle folder or .md file")
    .option("--name <name>", "Override skill name")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionImport);

  skills
    .command("edit <id>")
    .description("Create a new revision from updated local files (CAS — specify --expected-revision to avoid overwrites).")
    .requiredOption("--file <paths...>", "Markdown file(s) to include")
    .option("--expected-revision <n>", "Expected current revision number (prevents stale overwrite)", parseInt)
    .option("--name <name>", "Update skill name")
    .option("--description <desc>", "Update description")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionEdit);

  skills
    .command("sync <id>")
    .description("Re-fetch a GitHub-imported skill from its original source.")
    .requiredOption("--expected-revision <n>", "Expected current revision number (CAS — 409 on mismatch)", parseInt)
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionSync);

  skills
    .command("use <id>")
    .description("Pin a skill revision to a project. Resolves owner/repo to a project ID.")
    .requiredOption("--project <owner/repo>", "Project to assign the skill to (owner/name or UUID)")
    .option("--revision <id>", "Revision UUID to pin (default: latest)")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionUse);

  skills
    .command("unuse <id>")
    .description("Unpin a skill from a project.")
    .requiredOption("--project <owner/repo>", "Project to remove the skill from (owner/name or UUID)")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionUnuse);

  skills
    .command("project <owner/repo>")
    .description("Show skills assigned to or available for a project.")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionProject);

  skills
    .command("archive <id>")
    .description("Archive a skill (disables future project bindings, preserves history).")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionArchive);
}

// A review check is one prompt stored as an assigned audit skill. The marker
// separates always-run checks from optional methodology skills in the same
// existing versioned, repository-scoped storage.
const REVIEW_CHECK_DESCRIPTION_PREFIX = "review-check:v1:";

function checkoutRepository(): string {
  const raw = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const match = raw.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error("Use --project owner/repo or run from its Git checkout.");
  return match[1]!;
}

async function checkProject(api: CloudClient, value?: string): Promise<string> {
  const selected = value || checkoutRepository();
  if (/^[0-9a-f-]{36}$/i.test(selected)) return selected;
  const projects = (await api.listAuditSkills()).projects;
  const found = projects.find(p => p.fullName.toLowerCase() === selected.toLowerCase());
  if (!found) throw new Error(`Codebase ${selected} is not enrolled. Run 0 connect first.`);
  return found.id;
}

async function checkDetail(api: CloudClient, projectId: string, id: string) {
  const assigned = await api.listAuditSkillsByProject(projectId);
  const detail = await api.getAuditSkill(id);
  if (detail.skill.description !== `${REVIEW_CHECK_DESCRIPTION_PREFIX}${projectId}`) {
    throw new Error("This review check does not belong to this codebase.");
  }
  return { detail, binding: assigned.assignments.find(a => a.skillId === id) };
}

type CheckOptions = { project?: string; json?: boolean };

async function checkAction(action: () => Promise<unknown>, json: boolean): Promise<void> {
  try {
    const value = await action();
    process.stdout.write(JSON.stringify(value, null, json ? undefined : 2) + "\n");
  } catch (error) {
    handleCloudError(error, json);
  }
}

async function createCheck(api: CloudClient, projectId: string, name: string, rawPrompt: string, enabled: boolean) {
  const prompt = rawPrompt.trim();
  if (!prompt || prompt.length > 2000 || !name.trim() || name.length > 120) {
    throw new Error("Name and prompt are required (120/2000 character limits).");
  }
  if (enabled) {
    const assigned = await api.listAuditSkillsByProject(projectId);
    if (assigned.assignments.length >= 8) throw new Error("This codebase already has 8 assigned audit skills/checks.");
  }
  const created = await api.createAuditSkill({ name: name.trim(),
    description: `${REVIEW_CHECK_DESCRIPTION_PREFIX}${projectId}`, files: [{ path: "SKILL.md", content: prompt }] });
  if (enabled) await api.assignAuditSkill(created.skill.id, projectId, created.revision.revisionId);
  return { id: created.skill.id, name: created.skill.name, prompt, projectId, enabled };
}

export function registerReviewChecksCommand(program: Command): void {
  const checks = program.command("checks").description("Manage one-prompt review checks for an enrolled codebase.");
  checks.command("propose")
    .description("Save a check draft for developer review. Does not enable it.")
    .requiredOption("--name <name>", "Short check name")
    .requiredOption("--prompt <text>", "Behavior or code pattern to review")
    .option("--project <owner/repo>", "Codebase (defaults to the current Git checkout)")
    .option("--json", "Machine-readable result")
    .action((opts: CheckOptions & { name: string; prompt: string }) => checkAction(async () => {
      const api = loadClient().client;
      return createCheck(api, await checkProject(api, opts.project), opts.name, opts.prompt, false);
    }, !!opts.json));
  checks.command("add")
    .description("Save and enable one developer-approved check.")
    .requiredOption("--name <name>", "Short check name")
    .requiredOption("--prompt <text>", "Behavior or code pattern to review on each change")
    .option("--project <owner/repo>", "Codebase (defaults to the current Git checkout)")
    .requiredOption("--yes", "Confirm that this prompt should run on future configured reviews")
    .option("--json", "Machine-readable result")
    .action((opts: CheckOptions & { name: string; prompt: string; yes: boolean }) => checkAction(async () => {
      const api = loadClient().client;
      return createCheck(api, await checkProject(api, opts.project), opts.name, opts.prompt, true);
    }, !!opts.json));
  checks.command("list")
    .description("Show active checks and drafts for this codebase.")
    .option("--project <owner/repo>", "Codebase (defaults to the current Git checkout)")
    .option("--json", "Machine-readable result")
    .action((opts: CheckOptions) => checkAction(async () => {
      const api = loadClient().client;
      const projectId = await checkProject(api, opts.project);
      const assigned = await api.listAuditSkillsByProject(projectId);
      const summaries = (await api.listAuditSkills()).skills
        .filter(s => s.description === `${REVIEW_CHECK_DESCRIPTION_PREFIX}${projectId}`);
      const entries = await Promise.all(summaries.map(async skill => {
        const detail = await api.getAuditSkill(skill.id);
        const binding = assigned.assignments.find(a => a.skillId === skill.id);
        const revision = binding
          ? detail.revisions.find(r => r.revisionId === binding.revisionId)
          : detail.revisions.find(r => r.revision === skill.latestRevision);
        return revision ? { id: skill.id, name: skill.name,
          prompt: revision.files.find(f => f.path === "SKILL.md")?.content ?? "",
          revision: revision.revision, enabled: !!binding } : null;
      }));
      return { projectId, checks: entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null) };
    }, !!opts.json));
  checks.command("enable <id>")
    .description("Enable a reviewed draft for future configured reviews.")
    .option("--project <owner/repo>", "Codebase (defaults to the current Git checkout)")
    .requiredOption("--yes", "Confirm developer approval")
    .option("--json", "Machine-readable result")
    .action((id: string, opts: CheckOptions & { yes: boolean }) => checkAction(async () => {
      const api = loadClient().client;
      const projectId = await checkProject(api, opts.project);
      const { detail, binding } = await checkDetail(api, projectId, id);
      if (!binding) {
        const assigned = await api.listAuditSkillsByProject(projectId);
        if (assigned.assignments.length >= 8) throw new Error("This codebase already has 8 assigned audit skills/checks.");
        const latest = detail.revisions.find(r => r.revision === detail.skill.latestRevision);
        if (!latest) throw new Error("Review check revision is unavailable.");
        await api.assignAuditSkill(id, projectId, latest.revisionId);
      }
      return { id, projectId, enabled: true };
    }, !!opts.json));
  checks.command("set <id>")
    .description("Update a draft or active check. Active changes apply to future reviews.")
    .requiredOption("--prompt <text>", "Replacement prompt for this check")
    .option("--project <owner/repo>", "Codebase (defaults to the current Git checkout)")
    .option("--json", "Machine-readable result")
    .action((id: string, opts: CheckOptions & { prompt: string }) => checkAction(async () => {
      const api = loadClient().client;
      const projectId = await checkProject(api, opts.project);
      const { detail, binding } = await checkDetail(api, projectId, id);
      const prompt = opts.prompt.trim();
      if (!prompt || prompt.length > 2000) throw new Error("Prompt must be 1–2000 characters.");
      const revised = await api.createAuditSkillRevision(id, { expectedRevision: detail.skill.latestRevision,
        files: [{ path: "SKILL.md", content: prompt }] });
      if (binding) await api.assignAuditSkill(id, projectId, revised.revision.revisionId);
      return { id, prompt, projectId, revision: revised.revision.revision, enabled: !!binding };
    }, !!opts.json));
  checks.command("remove <id>")
    .description("Stop applying an active check or discard an unapproved draft.")
    .option("--project <owner/repo>", "Codebase (defaults to the current Git checkout)")
    .option("--json", "Machine-readable result")
    .action((id: string, opts: CheckOptions) => checkAction(async () => {
      const api = loadClient().client;
      const projectId = await checkProject(api, opts.project);
      const { binding } = await checkDetail(api, projectId, id);
      if (binding) await api.unassignAuditSkill(id, projectId);
      await api.archiveAuditSkill(id);
      return { id, projectId, enabled: false };
    }, !!opts.json));
}