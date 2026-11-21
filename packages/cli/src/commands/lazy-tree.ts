/**
 * Lazy twin of `registerCommandTree` (tree.ts): the same commands in the same places, but
 * each top-level command imports only the modules it needs, when it is invoked. Startup
 * for `0 --version`, `0 --help` and any one command no longer pays for all ~70 command
 * modules (and the engine they pull in).
 *
 * Each section builds its top-level command on a scratch root, in the registration order
 * tree.ts uses, then hands the finished command to the real program. Moving a command
 * therefore means editing tree.ts and the matching section here; `help-snapshot.test.ts`
 * compares the help of every node of both trees against the recorded fixture, so they cannot drift.
 */
import { Command } from "commander";
import { adoptCommands, applyNewSurface, nest } from "./layout.js";
import { findTopLevel } from "./manifest.js";
import { addCommandStubs } from "../program.js";

type Build = (scratch: Command) => Promise<void>;

const SECTIONS: Readonly<Record<string, Build>> = {
  async scan(root) {
    (await import("./scan.js")).registerScanCommand(root);
  },

  async findings(root) {
    const [reports, findings, exportCommand, keys, importCommand, fix, upload] = await Promise.all([
      import("./reports.js"), import("./findings.js"), import("./findings-export.js"), import("./findings-keys.js"), import("./findings-import.js"), import("./fix.js"), import("./findings-upload.js"),
    ]);
    reports.registerReportsCommand(root);
    findings.registerFindingsCommand(root);
    nest(root, "findings", [exportCommand.registerFindingsExportCommand, keys.registerFindingsKeysCommand, importCommand.registerFindingsImportCommand, (parent) => fix.registerFixCommand(parent), (parent) => upload.registerFindingsUploadCommand(parent)]);
    adoptCommands(root, "findings");
  },

  async automation(root) {
    const [workflow, manage] = await Promise.all([import("./workflow.js"), import("./automation-manage.js")]);
    workflow.registerWorkflowCommand(root); // also registers `threads`; only `automation` is kept
    nest(root, "automation", [(parent) => manage.registerAutomationManageCommands(parent)]);
  },

  async threads(root) {
    const [workflow, missions] = await Promise.all([import("./workflow.js"), import("./missions.js")]);
    workflow.registerWorkflowCommand(root);
    missions.registerMissionsCommand(root);
  },

  async sentinels(root) {
    (await import("./sentinels.js")).registerSentinelsCommand(root);
  },

  async web(root) {
    (await import("./dashboard.js")).registerDashboardCommand(root);
  },

  async api(root) {
    (await import("./api.js")).registerApiCommand(root);
  },

  async computers(root) {
    (await import("./worker.js")).registerWorkerCommand(root);
  },

  async doctor(root) {
    const [upgrade, doctor, workbench] = await Promise.all([import("./upgrade.js"), import("./doctor.js"), import("./workbench.js")]);
    doctor.registerDoctorCommand(root);
    upgrade.registerUpgradeCommand(root);
    workbench.registerWorkbenchCommand(root);
    adoptCommands(root, "doctor");
  },

  async config(root) {
    const [team, db, config, github, auditLog] = await Promise.all([import("./team.js"), import("./db.js"), import("./config.js"), import("./github.js"), import("./audit-log.js")]);
    team.registerTeamCommand(root);
    db.registerDbCommand(root);
    config.registerConfigCommand(root);
    github.registerGithubCommand(root);
    auditLog.registerAuditLogCommand(root);
    adoptCommands(root, "config");
  },

  async models(root) {
    const [connections, models, usage] = await Promise.all([import("./connections.js"), import("./models.js"), import("./usage.js")]);
    connections.registerConnectionsCommand(root);
    models.registerModelsCommand(root);
    usage.registerUsageCommand(root);
    adoptCommands(root, "models");
  },

  async skills(root) {
    (await import("./skills.js")).registerSkillsCommand(root);
  },
};

/** Build one top-level command and attach it to `program`. */
export async function loadTopLevel(program: Command, name: string): Promise<void> {
  const build = SECTIONS[name];
  if (!build) throw new Error(`Command tree: no section for \`${name}\``);
  const scratch = new Command().enablePositionalOptions();
  await build(scratch);
  const built = scratch.commands.find((command) => command.name() === name);
  if (!built) throw new Error(`Command tree: section \`${name}\` did not register itself`);
  applyNewSurface(built);
  program.addCommand(built);
}

/** The top-level command `argv` will run, if any: the first word, or the word after `help`. */
export function targetTopLevel(argv: readonly string[]): string | undefined {
  const words = argv.filter((word) => !word.startsWith("-"));
  const first = words[0] === "help" ? words[1] : words[0];
  return first === undefined ? undefined : findTopLevel(first)?.name;
}

/**
 * Register what `argv` needs: the real command it targets, and stubs for every other
 * top-level name (so root help, suggestions and the known-command check stay complete).
 */
export async function registerLazyCommandTree(program: Command, argv: readonly string[]): Promise<void> {
  const target = targetTopLevel(argv);
  addCommandStubs(program, target ? new Set([target]) : undefined);
  if (target) await loadTopLevel(program, target);
}

/** Every real command, for tests and docs that need the whole tree. */
export async function loadAllTopLevel(program: Command): Promise<void> {
  const { TOP_LEVEL_COMMANDS } = await import("./manifest.js");
  for (const entry of TOP_LEVEL_COMMANDS) await loadTopLevel(program, entry.name);
}
