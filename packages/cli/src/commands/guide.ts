// `0sec guide` — the agent-readable product and capability guide.
//
// Other clients and harnesses discover everything 0sec offers from this one
// entry: what the product does, how the architecture works, when to choose
// each feature, valid command examples, output interpretation, and the
// auth/approval/cost boundaries. Output is versioned so agents refresh on
// upgrade, and capability layers are distinguished honestly:
//
//   1. engine     — features in THIS installed CLI version (works offline)
//   2. service    — what the configured cloud answers right now (live probe)
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
}

type ServiceProbe = "unknown" | "ok" | "unauthenticated" | "unreachable";

interface GuideServiceStates {
  engine: { version: string; capabilities: string[] };
  service: { status: ServiceProbe; note: string };
  account: unknown;
}

const CAPABILITIES: Capability[] = [
  {
    id: "secure-lifecycle",
    summary: "Investigate a repository, behaviorally reproduce each finding with a frozen probe, repair across multiple files, run your regression command, and independently verify the fix in a fresh checkout.",
    when: "You want verified repairs, not a report. This is the primary workflow.",
    command: "0sec secure <repo> --test-command \"npm test\"",
    layer: "engine",
    limitations: "Model quality varies; every acceptance gate is executable evidence, not model opinion. Investigation is not signal-cancellable mid-flight (workflow deadline applies).",
  },
  {
    id: "connect",
    summary: "One-command cloud onboarding: verify auth, auto-detect the test command, start the first secure run immediately, install a recurring schedule.",
    when: "Point 0cloud by 0security at a repository and let it work continuously.",
    command: "0sec connect https://github.com/org/repo",
    layer: "service",
    requiresAuth: true,
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
  summary: "0security is the open engine and CLI (this binary). 0cloud by 0security is the hosted platform that runs the same engine in managed sandboxes on a schedule and on repository events.",
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
    auth: "Cloud actions need `0sec auth login` (browser, scoped token). Engine runs offline with your own provider keys.",
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
        ? "0cloud by 0security is reachable with your credentials."
        : serviceProbe === "unauthenticated"
          ? "Run 0sec auth login to enable service capabilities."
          : serviceProbe === "unreachable"
            ? "Cloud unreachable from here; engine capabilities keep working offline."
            : "Service state not probed (no credentials configured).",
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

function printHuman(topic: string | undefined, service: GuideServiceStates): void {
  const out: string[] = [];
  out.push(`0security guide (installed ${VERSION})`);
  out.push("");
  out.push("0security is the open engine and CLI that secures software: it finds vulnerabilities, proves them, repairs the cause, and verifies the repair. 0cloud by 0security is the hosted platform running the same engine continuously.");
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
    out.push("Topics: 0sec guide <capability-id> | 0sec guide architecture | 0sec guide limits | 0sec guide --json");
    out.push("Refresh after upgrade; this guide is versioned with the CLI.");
  } else if (topic === "architecture") {
    out.push(`Lifecycle: ${ARCHITECTURE.lifecycle.join(" → ")}`);
    out.push("");
    out.push(`Evidence: ${ARCHITECTURE.evidence}`);
  } else if (topic === "limits") {
    for (const l of ARCHITECTURE.limitations) out.push(`  - ${l}`);
    for (const c of CAPABILITIES.filter((x) => x.limitations)) out.push(`  - [${c.id}] ${c.limitations}`);
  } else {
    const cap = CAPABILITIES.find((c) => c.id === topic);
    if (!cap) throw new InvalidArgumentError(`Unknown topic '${topic}'. Run 0sec guide for the list.`);
    out.push(`${cap.id} [${cap.layer}]`);
    out.push(cap.summary);
    out.push("");
    out.push(`When: ${cap.when}`);
    if (cap.command) out.push(`Run: ${cap.command}`);
    if (cap.requiresAuth) out.push("Requires: 0sec auth login");
    if (cap.limitations) out.push(`Limitations: ${cap.limitations}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description("Agent-readable product and capability guide (versioned; use --json for machines)")
    .argument("[topic]", "capability id, 'architecture', or 'limits'")
    .option("--format <format>", "Output format: human or json", "human")
    .option("--json", "Shorthand for --format json", false)
    .action(async (topic: string | undefined, opts: { format: string; json: boolean }) => {
      const format = opts.json ? "json" : opts.format;
      if (format !== "human" && format !== "json") {
        throw new InvalidArgumentError("--format must be human or json.");
      }
      const service = states(await probeService(), {
        note: "Entitlements are resolved by the service at dispatch; this CLI does not cache plan state.",
      });
      if (format === "json") {
        process.stdout.write(
          JSON.stringify(
            {
              version: VERSION,
              product: "0security (open engine + CLI); 0cloud by 0security (hosted platform)",
              capabilities: CAPABILITIES,
              architecture: ARCHITECTURE,
              states: service,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }
      printHuman(topic, service);
    });
}
