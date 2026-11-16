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

const SCAN_DESCRIPTION = "Assess a target: live web/MCP, source repository, package, deep review, or repair loop";

const SECTIONS: Readonly<Record<string, Build>> = {
  async scan(root) {
    const [scan, review, audit, deepReview, secure, campaign, fix, verify, deps, agentAssure, evalCommand, disclose] = await Promise.all([
      import("./scan.js"), import("./review.js"), import("./audit.js"), import("./deep-review.js"), import("./secure.js"), import("./campaign.js"),
      import("./fix.js"), import("./verify.js"), import("./deps.js"), import("./agent-assure.js"), import("./eval.js"), import("./disclose.js"),
    ]);
    root.command("scan").description(SCAN_DESCRIPTION);
    nest(root, "scan", [
      (parent) => scan.registerScanCommand(parent, "web"),
      (parent) => review.registerReviewCommand(parent, "source"),
      (parent) => audit.registerAuditCommand(parent, "package"),
      (parent) => deepReview.registerDeepReviewCommand(parent, "deep"),
      (parent) => secure.registerSecureCommand(parent, "repair"),
      (parent) => campaign.registerCampaignCommand(parent, {}, "campaign"),
    ]);
    fix.registerFixCommand(root);
    verify.registerVerifyCommand(root);
    deps.registerDepsCommand(root);
    agentAssure.registerAgentAssureCommand(root);
    evalCommand.registerEvalCommand(root);
    disclose.registerDiscloseCommand(root);
    adoptCommands(root, "scan");
  },

  async findings(root) {
    const [reports, findings, triage, exportCommand, keys] = await Promise.all([
      import("./reports.js"), import("./findings.js"), import("./triage.js"), import("./findings-export.js"), import("./findings-keys.js"),
    ]);
    reports.registerReportsCommand(root);
    findings.registerFindingsCommand(root);
    nest(root, "findings", [triage.registerTriageCommand, exportCommand.registerFindingsExportCommand, keys.registerFindingsKeysCommand]);
    adoptCommands(root, "findings");
  },

  async automation(root) {
    const [workflow, manage] = await Promise.all([import("./workflow.js"), import("./automation-manage.js")]);
    workflow.registerWorkflowCommand(root); // also registers `threads` and `runs`; only `automation` is kept
    nest(root, "automation", [(parent) => manage.registerAutomationManageCommands(parent)]);
  },

  async threads(root) {
    const [workflow, missions] = await Promise.all([import("./workflow.js"), import("./missions.js")]);
    workflow.registerWorkflowCommand(root);
    missions.registerMissionsCommand(root);
  },

  async agents(root) {
    (await import("./sentinels.js")).registerSentinelsCommand(root);
  },

  async lab(root) {
    const [research, hunt, recencyHunt, assumptionHunt, memsafety, lensSynth, specdrift, protocolCheck, npmDiscovery, jsRecon, xnuFuzz, kernel, cve, intel, recon, binary, ingest, exploit, identity, adgraph, entragraph, cloud, h1, bench, routing, evolve, learning, consoleCommand, mcpServer, workflow, history, replay, resume, timeline, orchestrate] = await Promise.all([
      import("./research.js"),
      import("./hunt.js"), import("./recency-hunt.js"), import("./assumption-hunt.js"), import("./memsafety.js"), import("./lens-synth.js"), import("./specdrift.js"),
      import("./protocol-check.js"), import("./npm-discovery.js"), import("./js-recon.js"), import("./xnu-fuzz.js"), import("./kernel.js"), import("./cve.js"), import("./intel.js"),
      import("./recon.js"), import("./binary.js"), import("./ingest.js"), import("./exploit.js"), import("./identity.js"), import("./adgraph.js"), import("./entragraph.js"),
      import("./cloud.js"), import("./h1.js"), import("./bench.js"), import("./routing.js"), import("./evolve.js"), import("./learning.js"),
      import("./console.js"), import("./mcp-server.js"), import("./workflow.js"), import("./history.js"), import("./replay.js"), import("./resume.js"), import("./timeline.js"), import("./orchestrate.js"),
    ]);
    research.registerResearchCommand(root);
    nest(root, "research", [
      hunt.registerHuntCommand, recencyHunt.registerRecencyHuntCommand, assumptionHunt.registerAssumptionHuntCommand,
      memsafety.registerMemsafetyCommand, lensSynth.registerLensSynthCommand, specdrift.registerSpecdriftCommand,
      protocolCheck.registerProtocolCheckCommand, npmDiscovery.registerNpmDiscoveryCommand, jsRecon.registerJsReconCommand,
      xnuFuzz.registerXnuFuzzCommand, kernel.registerKernelCommand, cve.registerCveCommand, intel.registerIntelCommand,
      recon.registerReconCommand, binary.registerBinaryCommand, ingest.registerIngestCommand,
      exploit.registerExploitCommand, identity.registerIdentityCommand, adgraph.registerAdGraphCommand,
      entragraph.registerEntraGraphCommand, cloud.registerCloudCommand, h1.registerH1Command,
    ]);
    root.command("lab", { hidden: true }).description("Developer commands: research, improve, console, mcp-server, runs");
    root.command("improve").description("Benchmark, evolve and qualify 0's own detection and routing");
    nest(root, "improve", [bench.registerBenchCommand, routing.registerRoutingCommand, evolve.registerEvolveCommand, learning.registerLearningCommand]);
    consoleCommand.registerConsoleCommand(root);
    mcpServer.registerMcpServerCommand(root);
    workflow.registerWorkflowCommand(root); // also registers `automation` and `threads`; only `runs` is adopted
    nest(root, "runs", [
      history.registerHistoryCommand, replay.registerReplayCommand,
      (parent) => resume.registerResumeCommand(parent, "relaunch"),
      timeline.registerTimelineCommand, orchestrate.registerOrchestrateCommand,
    ]);
    adoptCommands(root, "lab");
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
    const [upgrade, doctor, workbench, checks] = await Promise.all([import("./upgrade.js"), import("./doctor.js"), import("./workbench.js"), import("./checks.js")]);
    doctor.registerDoctorCommand(root);
    upgrade.registerUpgradeCommand(root);
    workbench.registerWorkbenchCommand(root);
    checks.registerReviewChecksCommand(root);
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

  async plugin(root) {
    (await import("./plugin-moved.js")).registerPluginMovedCommand(root);
  },

  async skills(root) {
    (await import("./skills.js")).registerSkillsCommand(root);
  },

  async memory(root) {
    (await import("./memory.js")).registerMemoryCommand(root);
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
