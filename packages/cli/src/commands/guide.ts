// `0sec guide` — the agent-readable product and capability guide.
//
// Other clients and harnesses discover everything 0sec offers from this one
// entry: what the product does, how the architecture works, when to choose
// each feature, valid command examples, output interpretation, and the
// auth/approval/cost boundaries. Output is versioned so agents refresh on
// upgrade, and capability layers are distinguished honestly:
//
//   1. engine     — features in THIS installed CLI version
//   2. service    — reachability only; health does not verify identity or access
//   3. account    — what this account/org may use (entitlements, when known)
//
// Everything below states only shipped, qualified behavior with measured
// evidence. No comparative claims without named current evidence.

import { VERSION } from "@0sec/shared";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import {
  CloudClient,
  CloudAuthMissingError,
  loadCloudCredentials,
} from "@0sec/core";

interface Capability {
  id: string;
  summary: string;
  when: string;
  command?: string;
  layer: "engine" | "service";
  requiresAuth?: boolean;
  limitations?: string;
  next?: string[];
}

type ServiceProbe = "unknown" | "ok" | "unauthenticated" | "unreachable";

interface GuideServiceStates {
  engine: { version: string; capabilities: string[] };
  service: { status: ServiceProbe; note: string };
  account: unknown;
}
const ONBOARDING = {
  summary: "First-run path: authenticate, enroll the repository, review source-backed context, then approve automatic checks or request a one-off scan.",
  steps: [
    "0sec auth login",
    "0sec project enroll <repository> --json",
    "0sec project setup <repository> --json",
    "Review the proposal and per-run credit limit; save with project save. Saving alone leaves recurring checks paused.",
    "For approved daily or weekly checks, use project save --enable-schedule. Read automation.nextRunAt for the next check.",
    "For an approved one-off run, use project start --revision <revision> --idempotency-key <uuid>.",
    "Follow the returned scan with service status <scan-id> or service wait <scan-id>.",
  ],
};

const CAPABILITIES: Capability[] = [
  {
    id: "project-setup",
    summary: "Enroll a repository, then read and edit its context, operating plan and revisions through the same API as the dashboard.",
    when: "An agent needs to connect a GitHub repository, propose configuration for review, save an approved revision, or explicitly request its execution.",
    command: "0sec project enroll https://github.com/org/repo --json",
    layer: "service",
    requiresAuth: true,
    limitations: "Enrollment checks the connected GitHub App and adds the repository to the current workspace; it does not save configuration or start a scan. After enrollment, use project setup --json. Starting requires an approved revision, an idempotency key and server-authorized credit funding. Observations are suggestions, not automatically accepted instructions.",
    next: ["Run project setup --json to review the source-backed proposal.", "Save only an approved plan; saving never starts an immediate scan.", "Use project save --enable-schedule only after approval for recurring checks. Plain save leaves recurring checks paused."],
  },
  {
    id: "audit-skills",
    summary: "Manage versioned audit-methodology bundles and pin their revisions to codebases.",
    when: "You want the CLI and dashboard to share editable review methodology.",
    command: "0sec skills list --json",
    layer: "service",
    requiresAuth: true,
    limitations: "Requires matching deployed audit-skills APIs; mutations need owner or administrator authority. Runs capture immutable bundles, and workers must use an engine with the manifest consumer. Methodology does not authorize additional scope, spending or publication.",
  },
  {
    id: "hosted-inference",
    summary: "Use 0cloud model access while the harness and its tools execute locally. Provider credentials remain on the service.",
    when: "You want hosted models without setting up a supplier account, rather than moving tool execution into a managed run.",
    command: "0sec models --json",
    layer: "service",
    requiresAuth: true,
    limitations: "Model availability, account entitlement and funding are checked separately. Model allowance does not grant managed execution, review credits or repair publication. Use 0sec balance --json for account allowance; health alone proves none of these.",
  },
  {
    id: "secure-lifecycle",
    summary: "Investigate a repository, behaviorally reproduce each finding with a frozen probe, repair across multiple files, run your regression command, and independently verify the fix in a fresh checkout.",
    when: "You want to run the repair workflow with your own execution resources. Use connect for qualified managed execution.",
    command: "0sec secure <repo> --test-command \"npm test\"",
    layer: "engine",
    limitations: "Model quality varies; every acceptance gate is executable evidence, not model opinion. Investigation is not signal-cancellable mid-flight (workflow deadline applies).",
  },
  {
    id: "connect",
    summary: "Verify repository access without creating work; explicitly opt into a managed scan or recurrence.",
    when: "Check access before requesting execution with --run or --schedule.",
    command: "0sec connect https://github.com/org/repo --setup-only",
    layer: "service",
    requiresAuth: true,
    limitations: "Unavailable enrollment APIs block dispatch. GitHub App approval is an action-required browser handoff, not a polling session. Neither --yes nor a readiness success starts work without --run or --schedule. JSON dispatch also requires --yes. A created scan with failed recurrence returns action-required with its scan id.",
  },
  {
    id: "service-start",
    summary: "Enqueue a managed security scan on a repository through 0cloud. Requires cloud credentials and an already-connected repository.",
    when: "You want to trigger a single managed scan run on a repository without a recurring schedule, or for a repository connected without a schedule.",
    command: "0sec service start --repo https://github.com/org/repo --test-command \"npm test\"",
    layer: "service",
    requiresAuth: true,
    limitations: "Requires cloud credentials. The repository must be accessible by the 0cloud GitHub App. The --setup-command, --model, and --cost-ceiling options are forwarded as secure_config to the orchestrator but are not independently validated before dispatch.",
  },
  {
    id: "service-status",
    summary: "Poll the current state of a managed scan by id. Returns the full scan row including status, cost, token counts, and timestamps.",
    when: "Checking whether a managed scan is still running or has completed.",
    command: "0sec service status <scan-id>",
    layer: "service",
    requiresAuth: true,
    limitations: "Builds and costs are populated only after the scan reaches a relevant phase. The scan id is a server-assigned row id, not a user-familiar name.",
  },
  {
    id: "service-wait",
    summary: "Block until a managed scan reaches a terminal state (complete, failed, cancelled, or cost_exceeded). Polls at a configurable interval.",
    when: "An agent or script needs to wait deterministically for a scan result before proceeding.",
    command: "0sec service wait <scan-id>",
    layer: "service",
    requiresAuth: true,
    limitations: "Runtime is bounded by the scan duration. Token is checked at each poll interval; an expired token terminates the wait with an error. The --interval flag controls polling frequency.",
  },
  {
    id: "service-cancel",
    summary: "Request cancellation of a pending or running managed scan.",
    when: "A scan is no longer needed or has exceeded its expected run time.",
    command: "0sec service cancel <scan-id>",
    layer: "service",
    requiresAuth: true,
    limitations: "Cancellation is best-effort; the scan transitions to cancelled after the running phase ends. A scan in a terminal state ignores the request.",
  },
  {
    id: "service-disconnect",
    summary: "Remove all scan schedules for a repository. Lists existing schedules, requires confirmation (or --yes to skip), and deletes each schedule. Idempotent: no-op when no schedule exists.",
    when: "Stopping recurring managed scans for a repository.",
    command: "0sec service disconnect https://github.com/org/repo",
    layer: "service",
    requiresAuth: true,
    limitations: "Only deletes schedules for the specified repository. Does not cancel in-flight scans. Partial failures (one schedule failing to delete) do not roll back others.",
  },
  {
    id: "review",
    summary: "Source-code security review of a repo, package, or diff.",
    when: "You need findings on a specific change or tree, without repair.",
    command: "0sec review ./my-app --diff-base origin/main --changed-only",
    layer: "engine",
  },
  {
    id: "scan",
    summary: "Live-target assessment of a running application (web, LLM endpoints, APIs) within an explicit scope.",
    when: "You have an authorized running target, not just source.",
    command: "0sec scan --target https://staging.example.com --scope ./scope.json",
    layer: "engine",
  },
  {
    id: "verify",
    summary: "Replay a finding's executable proof in an isolated runner.",
    when: "Checking whether a finding is real or still present.",
    command: "0sec verify --finding ./finding.json",
    layer: "engine",
  },
  {
    id: "fix",
    summary: "Generate and validate a scoped single-file fix for one already-reproduced finding.",
    when: "You have a reproduced finding and a regression command. Prefer 0sec secure for the full loop.",
    command: "0sec fix ./my-app --finding ./finding.json --test-command \"npm test\"",
    layer: "engine",
  },
  {
    id: "learning",
    summary: "Repair outcomes, developer choices (accepted/rejected PRs), reviewer comments, and per-repo rules flow into future repairs as untrusted guidance.",
    when: "Automatic on every secure run; value accumulates over time. Local runs persist per-repo state; cloud runs add tenant-level outcome and comment learning.",
    layer: "engine",
    limitations: "Guidance is advisory context for the model; acceptance gates are unchanged executable checks.",
  },
  {
    id: "rules",
    summary: "Plain-English team standards rendered into repair prompts (\"minimal diffs; no new dependencies\").",
    when: "Your team has house rules repairs must follow.",
    command: "0sec secure <repo> --test-command \"npm test\" --rules \"minimal diffs; no new dependencies\"",
    layer: "engine",
  },
];

const ARCHITECTURE = {
  summary: "0.security is the open engine and CLI brand; the executable remains 0sec. 0cloud by 0.security offers two paths: hosted inference with local tools, or managed security execution using the same engine. These paths have separate access and funding.",
  lifecycle: [
    "prepare — pin a clean managed checkout of your repository",
    "investigate — source review with tool-using agents under budgets",
    "reproduce — a frozen behavioral probe proves the finding on the baseline (vulnerable + legitimate controls pass)",
    "repair — multi-file patch candidates; broken candidates are rejected and iterated",
    "test — your regression command must pass on baseline and candidate",
    "verify — fresh patched checkout, frozen probe must report safe with controls passing",
    "deliver — verified patch + evidence retained; PR publication is gated, never automatic-merge",
  ],
  evidence:
    "Measured on this engine (2026-09-16, DeepSeek V4 Flash): a complete find→reproduce→repair→verify cycle finished in ~84s at ~$0.02–0.03 model cost, repairing a two-file authorization defect on the first attempt. Cost per repair is tracked from real provider usage, never estimated.",
  boundaries: {
    auth: "Cloud actions need `0sec auth login` and the relevant service entitlement. Local/BYOK runs need no cloud account; provider requests can still use the network. A health response does not verify account identity or product access.",
    approval: "Verified patches are retained as artifacts by default. Publishing a PR is a separate gated action; nothing merges or deploys itself.",
    cost: "Per-run cost ceilings (0SEC_COST_CEILING_USD / --cost-ceiling) bound model spend; the cloud adds account budgets. A run that exhausts budget stops and reports blocked, never fake-clean.",
    scope: "Live-target work requires an explicit scope file. Only test systems you own or are authorized to assess.",
  },
  limitations: [
    "Coverage and verification depth vary by workflow; review the evidence before treating an issue as confirmed.",
    "Generated fixes are candidates until your review; the gates prove behavior, not intent.",
    "The investigation pipeline is not signal-cancellable mid-flight; the whole-workflow deadline applies.",
    "Model routing is a backend cost decision; repair acceptance is decided by executable gates, not by which model proposed the patch.",
  ],
};

function states(serviceProbe: ServiceProbe, account: unknown): GuideServiceStates {
  return {
    engine: {
      version: VERSION,
      capabilities: CAPABILITIES.filter((c) => c.layer === "engine").map((c) => c.id),
    },
    service: {
      status: serviceProbe,
      note: serviceProbe === "ok"
        ? "0cloud health is reachable. Account identity, repository access, entitlements and funding are not verified by this probe."
        : serviceProbe === "unauthenticated"
          ? "The health probe rejected the credentials. Run 0sec auth login; product access still needs its own checks."
          : serviceProbe === "unreachable"
            ? "Cloud health is unreachable from here. Local workflows retain their own provider and network requirements."
            : "Service state not probed (no credentials configured); account access is unknown.",
    },
    account,
  };
}

async function probeService(): Promise<ServiceProbe> {
  try {
    const creds = loadCloudCredentials({ warn: () => {} });
    const client = new CloudClient({ host: creds.host, token: creds.token });
    await client.pingHealth();
    return "ok";
  } catch (error) {
    if (error instanceof CloudAuthMissingError) return "unknown";
    if ((error as Error).name === "CloudUnauthorizedError") return "unauthenticated";
    return "unreachable";
  }
}

// Use the same registered Commander tree that drives help and sync-cli-docs.mjs.
function commandPath(command: Command): string {
  return command.parent ? `${commandPath(command.parent)} ${command.name()}` : command.name();
}

function collectCommands(command: Command): Command[] {
  const visible = new Set(command.createHelp().visibleCommands(command));
  return command.commands.filter((child) => visible.has(child))
    .flatMap((child) => [child, ...collectCommands(child)]);
}

function commandMetadata(command: Command) {
  return {
    name: commandPath(command).replace(/^0sec /, ""),
    description: command.description(),
    usage: `${commandPath(command)} ${command.usage()}`,
    aliases: command.aliases(),
    arguments: command.registeredArguments.map((arg) => ({
      name: arg.name(), description: arg.description, required: arg.required, variadic: arg.variadic,
    })),
    options: command.createHelp().visibleOptions(command).map((option) => ({
      flags: option.flags, description: option.description, mandatory: option.mandatory,
      choices: option.argChoices,
    })),
  };
}

function printHuman(topic: string | undefined, service: GuideServiceStates, commands: Command[]): void {
  const out: string[] = [];
  out.push(`0.security guide (installed ${VERSION})`);
  out.push("");
    out.push(`Onboarding: ${ONBOARDING.summary}`);
    for (const [index, step] of ONBOARDING.steps.entries()) out.push(`  ${index + 1}. ${step}`);
    out.push("");
  out.push("");
  if (!topic) {
    out.push("Capabilities:");
    for (const c of CAPABILITIES) {
      out.push(`  ${c.id.padEnd(18)} ${c.summary}`);
      if (c.command) out.push(`${"".padEnd(20)}e.g. ${c.command}`);
    }
    out.push("");
    out.push(`Lifecycle: ${ARCHITECTURE.lifecycle.join(" → ")}`);
    out.push("");
    out.push(`Evidence: ${ARCHITECTURE.evidence}`);
    out.push("");
    out.push("Boundaries:");
    out.push(`  auth:     ${ARCHITECTURE.boundaries.auth}`);
    out.push(`  approval: ${ARCHITECTURE.boundaries.approval}`);
    out.push(`  cost:     ${ARCHITECTURE.boundaries.cost}`);
    out.push(`  scope:    ${ARCHITECTURE.boundaries.scope}`);
    out.push("");
    out.push("Service: " + service.service.note);
    out.push("");
    out.push("Topics: 0sec guide <capability-id> | 0sec guide commands | 0sec guide \"auth login\" | 0sec guide architecture | 0sec guide limits | 0sec guide --json");
    out.push("Refresh after upgrade; this guide is versioned with the CLI.");
  } else if (topic === "architecture") {
    out.push(`Lifecycle: ${ARCHITECTURE.lifecycle.join(" → ")}`);
    out.push("");
    out.push(`Evidence: ${ARCHITECTURE.evidence}`);
  } else if (topic === "limits") {
    for (const l of ARCHITECTURE.limitations) out.push(`  - ${l}`);
    for (const c of CAPABILITIES.filter((x) => x.limitations)) out.push(`  - [${c.id}] ${c.limitations}`);
  } else if (topic === "commands") {
    for (const command of commands) out.push(`${commandPath(command)} — ${command.description()}`);
    out.push("Use 0sec guide \"<command path>\" for its registered arguments and options.");
  } else {
    const cap = CAPABILITIES.find((c) => c.id === topic);
    const command = commands.find((c) => commandPath(c).replace(/^0sec /, "") === topic);
    if (cap) {
      out.push(`${cap.id} [${cap.layer}]`);
      out.push(cap.summary);
      out.push("");
      out.push(`When: ${cap.when}`);
      if (cap.command) out.push(`Run: ${cap.command}`);
      if (cap.requiresAuth) out.push("Requires: 0sec auth login and the relevant service access");
      if (cap.limitations) out.push(`Limitations: ${cap.limitations}`);
      if (cap.next?.length) {
        out.push("Next:");
        for (const step of cap.next) out.push(`  - ${step}`);
      }
    }
    if (command) out.push(command.helpInformation());
  }
  process.stdout.write(out.join("\n") + "\n");
}

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description("Agent-readable product and capability guide (versioned; use --json for machines)")
    .argument("[topic]", "capability id, command path, 'commands', 'architecture', or 'limits'")
    .option("--format <format>", "Output format: human or json", "human")
    .option("--json", "Shorthand for --format json", false)
    .action(async (topic: string | undefined, opts: { format: string; json: boolean }) => {
      const format = opts.json ? "json" : opts.format;
      if (format !== "human" && format !== "json") {
        throw new InvalidArgumentError("--format must be human or json.");
      }
      const commands = collectCommands(program);
      const capability = CAPABILITIES.find((c) => c.id === topic);
      const command = commands.find((c) => commandPath(c).replace(/^0sec /, "") === topic);
      if (topic && !capability && !command && !["commands", "architecture", "limits"].includes(topic)) {
        throw new InvalidArgumentError(`Unknown topic '${topic}'. Run 0sec guide for the list.`);
      }
      const service = states(await probeService(), {
        status: "unknown",
      });
      if (format === "json") {
        process.stdout.write(
          JSON.stringify(
            {
              version: VERSION,
              product: "0.security (open engine + CLI); 0cloud by 0.security (hosted platform)",
              onboarding: ONBOARDING,
              capabilities: topic ? (capability ? [capability] : []) : CAPABILITIES,
              commands: (topic && topic !== "commands" ? (command ? [command] : []) : commands).map(commandMetadata),
              architecture: !topic || topic === "architecture" ? ARCHITECTURE : undefined,
              limitations: topic === "limits" ? ARCHITECTURE.limitations : undefined,
              states: service,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }
      printHuman(topic, service, commands);
    });
}
