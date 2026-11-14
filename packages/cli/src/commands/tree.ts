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
import type { Command } from "commander";

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
import { registerRadarCommand } from "./radar.js";
import { registerWorkerCommand } from "./worker.js";
import { registerAgentAssureCommand } from "./agent-assure.js";
import { registerBinaryCommand } from "./binary.js";
import { registerPluginCommand } from "./plugin.js";
import { registerHackstoreCommand } from "./hackstore.js";
import { registerConfigCommand } from "./config.js";
import { registerWorkbenchCommand } from "./workbench.js";
import { registerReviewChecksCommand } from "./checks.js";
import { registerCampaignCommand } from "./campaign.js";

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
  nest(program, "findings", [registerTriageCommand]);
  registerWorkflowCommand(program); // also registers `sessions` and `runs`
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
    registerRadarCommand, registerReconCommand, registerBinaryCommand, registerIngestCommand,
    registerExploitCommand, registerIdentityCommand, registerAdGraphCommand,
    registerEntraGraphCommand, registerCloudCommand, registerH1Command,
  ]);

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
  registerWorkbenchCommand(program);
  registerReviewChecksCommand(program);

  // Extensions: install/run and author live together.
  registerPluginCommand(program);
  nest(program, "plugin", [(parent) => registerHackstoreCommand(parent, "author")]);
}
