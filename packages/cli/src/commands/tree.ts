/**
 * The one place that decides where every command lives.
 *
 * A registrar is `(parent, name?) => void`, so moving a command is a one-line change
 * here; command modules never know their own path.
 *
 * `src/index.ts` and `scripts/sync-cli-docs.mjs` both call `registerCommandTree`, so
 * the CLI and its generated reference cannot drift apart.
 */
import type { Command } from "commander";
import { HELP_GROUPS, NEW_HOME, adoptCommands, applyNewSurface, configureGroupedHelp, nest } from "./layout.js";

export { HELP_GROUPS, NEW_HOME, configureGroupedHelp };

import { registerFindingsCommand } from "./findings.js";
import { registerTriageCommand } from "./triage.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerDashboardCommand } from "./dashboard.js";
import { registerTeamCommand } from "./team.js";
import { registerDbCommand } from "./db.js";
import { registerWorkflowCommand } from "./workflow.js";
import { registerApiCommand } from "./api.js";
import { registerReportsCommand } from "./reports.js";
import { registerWorkerCommand } from "./worker.js";
import { registerConfigCommand } from "./config.js";
import { registerUpgradeCommand } from "./upgrade.js";
import { registerWorkbenchCommand } from "./workbench.js";
import { registerMissionsCommand } from "./missions.js";
import { registerFindingsExportCommand } from "./findings-export.js";
import { registerFindingsKeysCommand } from "./findings-keys.js";
import { registerSentinelsCommand } from "./sentinels.js";
import { registerAutomationManageCommands } from "./automation-manage.js";
import { registerSkillsCommand } from "./skills.js";
import { registerMemoryCommand } from "./memory.js";
import { registerConnectionsCommand } from "./connections.js";
import { registerModelsCommand } from "./models.js";
import { registerGithubCommand } from "./github.js";
import { registerUsageCommand } from "./usage.js";
import { registerAuditLogCommand } from "./audit-log.js";

export function registerCommandTree(program: Command): void {
  // Evidence.
  registerReportsCommand(program);
  registerFindingsCommand(program);
  nest(program, "findings", [registerTriageCommand, registerFindingsExportCommand, registerFindingsKeysCommand]);
  registerWorkflowCommand(program); // also registers `chats` and `automation`
  registerMissionsCommand(program);
  nest(program, "automation", [(parent) => registerAutomationManageCommands(parent)]);
  registerSentinelsCommand(program);

  // Surfaces and operations.
  registerDashboardCommand(program);
  registerApiCommand(program);
  registerWorkerCommand(program);
  registerTeamCommand(program);
  registerDoctorCommand(program);
  registerUpgradeCommand(program);
  registerDbCommand(program);
  registerConfigCommand(program);
  registerConnectionsCommand(program);
  registerModelsCommand(program);
  registerGithubCommand(program);
  registerUsageCommand(program);
  registerAuditLogCommand(program);
  registerWorkbenchCommand(program);

  // Skills and Memory are first-class pages in the web UI, so they are first-class groups here.
  registerSkillsCommand(program);
  registerMemoryCommand(program);

  adoptCommands(program);
  for (const command of program.commands) applyNewSurface(command);
}
