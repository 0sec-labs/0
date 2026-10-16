import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import { listProjectReviewChecks, updateProjectReviewChecks } from "@0/core";
import type { ProjectReviewChecks, ReviewCheckMutation } from "@0/core";

type CheckOptions = { project?: string; json?: boolean; yes?: boolean; expectedRevision?: number };

function revision(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new InvalidArgumentError("Revision must be a positive integer.");
  return parsed;
}

function render(value: ProjectReviewChecks): string {
  return [
    `Project: ${value.project}`,
    ...(value.checks.length ? value.checks.flatMap(check => [
      `${check.id}  ${check.enabled ? "enabled" : "draft/disabled"}  revision ${check.revision}  ${check.name}`,
      check.prompt,
      "",
    ]) : ["No local review checks."]),
  ].join("\n");
}

async function action(opts: CheckOptions, mutation?: ReviewCheckMutation): Promise<void> {
  try {
    const project = opts.project ?? process.cwd();
    const result = mutation ? updateProjectReviewChecks(project, mutation) : listProjectReviewChecks(project);
    process.stdout.write((opts.json ? JSON.stringify(result, null, 2) : render(result)) + "\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) process.stdout.write(JSON.stringify({ error: message }) + "\n");
    else process.stderr.write(`Review checks: ${message}\n`);
    process.exitCode = 2;
  }
}

export function registerReviewChecksCommand(program: Command): void {
  const checks = program.command("checks").description("Manage private, project-scoped local review checks. No cloud enrollment or credentials required.");
  const scoped = (command: Command): Command => command
    .option("--project <path>", "Local project directory (defaults to this checkout's root)")
    .option("--json", "Machine-readable result");

  scoped(checks.command("propose").description("Save a literal check draft without enabling it.")
    .requiredOption("--name <name>", "Short check name (1–120 characters)")
    .requiredOption("--prompt <text>", "Literal review criterion (1–2000 characters)"))
    .action((opts: CheckOptions & { name: string; prompt: string }) => action(opts, { action: "propose", name: opts.name, prompt: opts.prompt }));
  scoped(checks.command("add").description("Save and enable a developer-approved literal check.")
    .requiredOption("--name <name>", "Short check name (1–120 characters)")
    .requiredOption("--prompt <text>", "Literal review criterion (1–2000 characters)")
    .requiredOption("--yes", "Approve this prompt for future local reviews"))
    .action((opts: CheckOptions & { name: string; prompt: string }) => action(opts, { action: "add", name: opts.name, prompt: opts.prompt, approved: opts.yes }));
  scoped(checks.command("list").description("Show enabled checks and inactive drafts for this project."))
    .action((opts: CheckOptions) => action(opts));
  scoped(checks.command("enable <id>").description("Approve and enable the current revision of a check.")
    .requiredOption("--yes", "Confirm developer approval")
    .option("--expected-revision <n>", "Refuse if the inspected revision changed", revision))
    .action((id: string, opts: CheckOptions) => action(opts, { action: "enable", id, approved: opts.yes, expectedRevision: opts.expectedRevision }));
  scoped(checks.command("disable <id>").description("Stop running a check, keeping its prompt and revision history."))
    .action((id: string, opts: CheckOptions) => action(opts, { action: "disable", id }));
  scoped(checks.command("set <id>").description("Revise a literal prompt. Updating an enabled check requires --yes.")
    .requiredOption("--prompt <text>", "Replacement literal prompt (1–2000 characters)")
    .option("--yes", "Approve the new revision if the check is enabled")
    .option("--expected-revision <n>", "Refuse if the inspected revision changed", revision))
    .action((id: string, opts: CheckOptions & { prompt: string }) => action(opts, { action: "set", id, prompt: opts.prompt, approved: opts.yes, expectedRevision: opts.expectedRevision }));
  scoped(checks.command("remove <id>").description("Delete a local check and its revisions."))
    .action((id: string, opts: CheckOptions) => action(opts, { action: "remove", id }));
}
