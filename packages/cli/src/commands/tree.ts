/**
 * The one place that decides where every command lives.
 *
 * Top-level commands are the workflows people reach for first. Everything else is
 * nested under a noun group (`research`, `runs`, `findings`, `plugin`, `improve`).
 * A registrar is `(parent, name?) => void`, so moving a command is a one-line change
 * here; command modules never know their own path.
 *
 * `src/index.ts` and `scripts/sync-cli-docs.mjs` both call `registerCommandTree`, so
 * the CLI and its generated reference cannot drift apart.
 */
import type { Command, Help } from "commander";

import { registerScanCommand } from "./scan.js";
import { registerFindingsCommand } from "./findings.js";
import { registerTriageCommand } from "./triage.js";
import { registerSecureCommand } from "./secure.js";
import { registerReviewCommand } from "./review.js";
import { registerFixCommand } from "./fix.js";
import { registerAuditCommand } from "./audit.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerDashboardCommand } from "./dashboard.js";
import { registerTeamCommand } from "./team.js";
import { registerOrchestrateCommand } from "./orchestrate.js";
import { registerDbCommand } from "./db.js";
import { registerMcpServerCommand } from "./mcp-server.js";
import { registerWorkflowCommand } from "./workflow.js";
import { registerHistoryCommand } from "./history.js";
import { registerReplayCommand } from "./replay.js";
import { registerResumeCommand } from "./resume.js";
import { registerTimelineCommand } from "./timeline.js";
import { registerApiCommand } from "./api.js";
import { registerReportsCommand } from "./reports.js";
import { registerEvalCommand } from "./eval.js";
import { registerBenchCommand } from "./bench.js";
import { registerRoutingCommand } from "./routing.js";
import { registerEvolveCommand } from "./evolve.js";
import { registerLearningCommand } from "./learning.js";
import { registerIngestCommand } from "./ingest.js";
import { registerKernelCommand } from "./kernel.js";
import { registerDiscloseCommand } from "./disclose.js";
import { registerVerifyCommand } from "./verify.js";
import { registerExploitCommand } from "./exploit.js";
import { registerDeepReviewCommand } from "./deep-review.js";
import { registerCveCommand } from "./cve.js";
import { registerUpgradeCommand } from "./upgrade.js";
import { registerDepsCommand } from "./deps.js";
import { registerH1Command } from "./h1.js";
import { registerIntelCommand } from "./intel.js";
import { registerReconCommand } from "./recon.js";
import { registerConsoleCommand } from "./console.js";
import { registerIdentityCommand } from "./identity.js";
import { registerAdGraphCommand } from "./adgraph.js";
import { registerEntraGraphCommand } from "./entragraph.js";
import { registerCloudCommand } from "./cloud.js";
import { registerResearchCommand } from "./research.js";
import { registerHuntCommand } from "./hunt.js";
import { registerRecencyHuntCommand } from "./recency-hunt.js";
import { registerAssumptionHuntCommand } from "./assumption-hunt.js";
import { registerMemsafetyCommand } from "./memsafety.js";
import { registerLensSynthCommand } from "./lens-synth.js";
import { registerSpecdriftCommand } from "./specdrift.js";
import { registerProtocolCheckCommand } from "./protocol-check.js";
import { registerNpmDiscoveryCommand } from "./npm-discovery.js";
import { registerJsReconCommand } from "./js-recon.js";
import { registerXnuFuzzCommand } from "./xnu-fuzz.js";
import { registerWorkerCommand } from "./worker.js";
import { registerAgentAssureCommand } from "./agent-assure.js";
import { registerBinaryCommand } from "./binary.js";
import { registerPluginCommand } from "./plugin.js";
import { registerPluginAuthorCommands } from "./plugin-author.js";
import { registerConfigCommand } from "./config.js";
import { registerWorkbenchCommand } from "./workbench.js";
import { registerReviewChecksCommand } from "./checks.js";
import { registerCampaignCommand } from "./campaign.js";
import { registerMissionsCommand } from "./missions.js";
import { registerFindingsExportCommand } from "./findings-export.js";
import { registerFindingsKeysCommand } from "./findings-keys.js";
import { registerSentinelsCommand } from "./sentinels.js";
import { registerAutomationManageCommands } from "./automation-manage.js";
import { registerSkillsCommand } from "./skills.js";
import { registerMemoryCommand } from "./memory.js";
import { registerPluginConnectCommands } from "./plugin-connect.js";
import { registerConnectionsCommand } from "./connections.js";
import { registerModelsCommand } from "./models.js";
import { registerGithubCommand } from "./github.js";
import { registerUsageCommand } from "./usage.js";
import { registerAuditLogCommand } from "./audit-log.js";

type Registrar = (parent: Command) => void;

function child(parent: Command, name: string): Command {
  const found = parent.commands.find((command) => command.name() === name);
  if (!found) throw new Error(`Command tree: \`${name}\` must be registered before its children`);
  return found;
}

function nest(parent: Command, group: string, registrars: readonly Registrar[]): void {
  const target = child(parent, group);
  for (const register of registrars) register(target);
}

/** Commands that moved under another group. The old top-level name keeps working through `command-aliases.ts`. */
export const NEW_HOME: Readonly<Record<string, string>> = {
  fix: "scan", verify: "scan", deps: "scan", eval: "scan", "agent-assure": "scan", disclose: "scan",
  reports: "findings",
  connections: "models", usage: "models",
  "audit-log": "config", team: "config", db: "config", github: "config",
  upgrade: "doctor", workbench: "doctor", checks: "doctor",
  research: "lab", improve: "lab", console: "lab", "mcp-server": "lab", runs: "lab",
};

/** Move already-registered top-level commands under their new parent, keeping each command object (and handler) as is. */
function adoptCommands(program: Command): void {
  for (const [name, group] of Object.entries(NEW_HOME)) {
    const index = program.commands.findIndex((command) => command.name() === name);
    if (index < 0) throw new Error(`Command tree: \`${name}\` is not registered`);
    const [moved] = (program.commands as Command[]).splice(index, 1);
    child(program, group).addCommand(moved!);
  }
}

export const HELP_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["Work", ["scan", "findings", "threads", "agents", "automation"]],
  ["Setup", ["models", "computers", "skills", "plugin", "memory", "config"]],
  ["Run", ["web", "doctor", "api"]],
];

export function registerCommandTree(program: Command): void {
  registerReportsCommand(program);
  // `scan` is one entry point with modules. `0 scan <target>` picks the module from the
  // target (see rewriteScanArgs in routing.ts); `0 scan <module> ...` forces one.
  program.command("scan").description("Assess a target: live web/MCP, source repository, package, deep review, or repair loop");
  nest(program, "scan", [
    (parent) => registerScanCommand(parent, "web"),
    (parent) => registerReviewCommand(parent, "source"),
    (parent) => registerAuditCommand(parent, "package"),
    (parent) => registerDeepReviewCommand(parent, "deep"),
    (parent) => registerSecureCommand(parent, "repair"),
    (parent) => registerCampaignCommand(parent, {}, "campaign"),
  ]);

  // The pipeline after a scan: reproduce, then fix.
  registerFixCommand(program);
  registerVerifyCommand(program);
  registerDepsCommand(program);
  registerAgentAssureCommand(program);
  registerEvalCommand(program);
  registerDiscloseCommand(program);

  // Evidence and history.
  registerFindingsCommand(program);
  nest(program, "findings", [registerTriageCommand, registerFindingsExportCommand, registerFindingsKeysCommand]);
  registerWorkflowCommand(program); // also registers `chats`, `automation` and `runs`
  registerMissionsCommand(program);
  nest(program, "automation", [(parent) => registerAutomationManageCommands(parent)]);
  registerSentinelsCommand(program);
  nest(program, "runs", [
    registerHistoryCommand, registerReplayCommand,
    (parent) => registerResumeCommand(parent, "relaunch"),
    registerTimelineCommand, registerOrchestrateCommand,
  ]);

  // Specialist research: one noun group instead of two dozen top-level verbs.
  registerResearchCommand(program);
  nest(program, "research", [
    registerHuntCommand, registerRecencyHuntCommand, registerAssumptionHuntCommand,
    registerMemsafetyCommand, registerLensSynthCommand, registerSpecdriftCommand,
    registerProtocolCheckCommand, registerNpmDiscoveryCommand, registerJsReconCommand,
    registerXnuFuzzCommand, registerKernelCommand, registerCveCommand, registerIntelCommand,
    registerReconCommand, registerBinaryCommand, registerIngestCommand,
    registerExploitCommand, registerIdentityCommand, registerAdGraphCommand,
    registerEntraGraphCommand, registerCloudCommand, registerH1Command,
  ]);

  // Improving 0 itself. `lab` is hidden from the default help: rare developer commands live there.
  program.command("lab", { hidden: true }).description("Developer commands: research, improve, console, mcp-server, runs");
  // Improving 0 itself.
  program.command("improve").description("Benchmark, evolve and qualify 0's own detection and routing");
  nest(program, "improve", [registerBenchCommand, registerRoutingCommand, registerEvolveCommand, registerLearningCommand]);

  // Surfaces and operations.
  registerDashboardCommand(program);
  registerConsoleCommand(program);
  registerApiCommand(program);
  registerMcpServerCommand(program);
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
  registerReviewChecksCommand(program);

  // Plugins: install/run and author live together under `plugin`.
  registerPluginCommand(program);
  nest(program, "plugin", [registerPluginAuthorCommands, registerPluginConnectCommands]);

  // Skills and Memory are first-class pages in the web UI, so they are first-class groups here.
  registerSkillsCommand(program);
  registerMemoryCommand(program);

  adoptCommands(program);
}

/** Root `--help`: the visible commands grouped by purpose instead of one flat list. */
export function configureGroupedHelp(program: Command): void {
  program.configureHelp({
    formatHelp(cmd: Command, helper: Help): string {
      const width = helper.padWidth(cmd, helper);
      const columns = helper.helpWidth ?? 80;
      const item = (term: string, description: string): string => {
        const fullText = `${term.padEnd(width)}  ${description}`;
        return "  " + (description ? helper.wrap(fullText, columns - 2, width + 4) : term);
      };
      const out = [`Usage: ${helper.commandUsage(cmd)}`, "", helper.commandDescription(cmd), ""];
      out.push("Options:", ...helper.visibleOptions(cmd).map((option) => item(helper.optionTerm(option), helper.optionDescription(option))), "");
      const visible = new Map(helper.visibleCommands(cmd).map((command) => [command.name(), command]));
      for (const [title, names] of HELP_GROUPS) {
        out.push(`${title}:`);
        for (const name of names) {
          const command = visible.get(name);
          if (command) out.push(item(helper.subcommandTerm(command), helper.subcommandDescription(command)));
        }
        out.push("");
      }
      return out.join("\n").replace(/\n+$/, "\n");
    },
  });
}
