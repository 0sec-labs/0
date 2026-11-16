import "./apply-env-aliases.js";
// Last-resort crash capture (consent-gated; see crash-capture.ts). Must stay right after env aliases.
import "./crash-capture-install.js";
import { Command } from "commander";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { VERSION } from "@0/engine/shared";
import {
  analyticsPipeline,
  analyticsOptedOut,
  TOOL_DEFINITIONS,
  createHerdrEventSink,
  configureRunContributionsFromEnvironment,
  eventBus,
  maybeSubscribeOperationalEventSink,
  presentationEventSink,
} from "@0/engine";
import { getSettings } from "./state/settings-store.js";
import { maybeLoadCodexAuth } from "./codex-auth.js";
import { presentationEventBus } from "./presentation/event-bus.js";
import {
  installConsolePresentationBridge,
  installProcessPresentationStreamBridge,
} from "./presentation/process-output.js";
import { launchConfiguredWorkbench } from "./workbench.js";
import { remoteBackendClientId } from "./backend-client-mode.js";
import { savedConnectionEnvPatch } from "./connection-env.js";
import { commandPathsOf, setCrashCommandPaths } from "./crash-capture.js";
import { surfaceFromArgv } from "./surface.js";
import { createRootProgram } from "./program.js";
import { registerLazyCommandTree } from "./commands/lazy-tree.js";
import { TOP_LEVEL_COMMANDS } from "./commands/manifest.js";
import { getReleaseChannel } from "./state/runtime.js";
import { maybePrintTelemetryNotice } from "./telemetry-notice.js";

// Private session workers must not rediscover host accounts or execution profiles.
if (process.argv.includes("--host-console-worker")) {
  await (await import("./host-console-worker.js")).runHostConsoleWorker();
  process.exit(0);
}

// Cross the execution boundary before reading host login state, applying updates
// or starting the console. The guest receives the original argv and terminal.
try {
  const workbenchExitCode = await launchConfiguredWorkbench(process.argv.slice(2));
  if (workbenchExitCode !== undefined) process.exit(workbenchExitCode);
} catch (error) {
  process.stderr.write(`[0] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(125);
}
const isRemoteBackendClient = process.argv[2] === "api" || Boolean(remoteBackendClientId(process.argv.slice(2)));
const isWorkbenchManagement = ["workbench", "config", "reports", "connections", "models", "github", "usage", "audit-log"].includes(process.argv[2] ?? "")
  || (process.argv[2] === "findings" && process.argv[3] === "reports") || (process.argv[2] === "doctor" && process.argv[3] === "workbench");


// Legacy command modules still use console methods. Bridge those bytes into
// the canonical stream at the process boundary without changing their output.
installConsolePresentationBridge();
installProcessPresentationStreamBridge();
// Local-dev convenience: if `codex login` has run (~/.codex/auth.json) and no
// ZERO_CHATGPT_* token is in the env, plumb the codex tokens in so the engine
// resolves to the chatgpt-codex provider (highest priority) instead of falling
// through to stale AZURE_OPENAI_API_KEY / OPENAI_API_KEY. No-op in the cloud
// worker (it sets the tokens itself) and when a token is already present.
if (!isWorkbenchManagement && !isRemoteBackendClient) maybeLoadCodexAuth();


// The settings store initializes the pipeline and preserves explicit environment
// restrictions. Do not overwrite the tier env or reinitialize from env alone.
try {
  // Usage events carry the same surface label as crash reports (one shared function).
  analyticsPipeline.configure({
    surface: surfaceFromArgv(process.argv),
    releaseChannel: getReleaseChannel(),
    knownToolNames: Object.values(TOOL_DEFINITIONS).map((tool) => tool.name),
  });
  const settings = getSettings();
  // Telemetry is automatic by default: say so once, on stderr, for interactive runs only.
  maybePrintTelemetryNotice({
    args: process.argv.slice(2),
    telemetryActive: !analyticsOptedOut() && (settings.analyticsLevel !== "off" || settings.diagnosticReporting === "automatic"),
  });
} catch {
  analyticsPipeline.setLevel("off");
}
// Independent, purpose-specific enrollment. Missing configuration does not enroll.
try { configureRunContributionsFromEnvironment(); }
catch { process.stderr.write("[0] Run contribution unavailable: invalid private enrollment configuration.\n"); }

// Operational NDJSON stderr sink (ZERO_LOG_FORMAT=json). Opt-in metadata-
// only logging — writes one NDJSON line per allowlisted lifecycle / cost
// event to stderr. Strips all sensitive fields (prompts, responses,
// reasoning, tool args, finding evidence, token deltas, auth material,
// raw error text). No effect unless the env var is set.
maybeSubscribeOperationalEventSink();

// Every core event also enters the process-local canonical presentation stream.
// Legacy cloud/stdout and Herdr projections remain independent adapters.
eventBus.subscribe(presentationEventSink(presentationEventBus));

// Report coarse agent state to herdr when 0 is running inside one of its
// panes, so the pane shows working/idle instead of "unknown" and
// `herdr agent wait` becomes usable against a scan. The factory returns null
// off-herdr, every write is fail-soft, and the payload carries only counters
// and a fixed phase enum — never a target, finding, path or tool name, since
// that socket is readable by any process running as this user.
const herdrSink = createHerdrEventSink();
if (herdrSink) eventBus.subscribe(herdrSink);
import { detectAndRoute, rewriteScanArgs } from "./routing.js";
import { shouldPrintMovedNotice } from "./command-aliases.js";
import { formatMovedNotice, resolveInvocation } from "./command-compat.js";
import { runStartupUpdate } from "./utils/update-check.js";
import { enforceSourceDistFreshness } from "./source-freshness.js";

// The bundle entry is the thin `index.ts` (bundled as dist/0.js); this module is a chunk behind it.
enforceSourceDistFreshness({ entryUrl: process.argv[1] ? pathToFileURL(process.argv[1]).href : import.meta.url });


// Explicit automatic updates finish before command parsing or browser startup.
// Notification-only checks stay in the background; unset settings remain opt-in.
if (!isWorkbenchManagement && !isRemoteBackendClient) await runStartupUpdate(VERSION);

// Command implementations load lazily: only the top-level command being run (see lazy-tree.ts).
async function buildProgram(args: readonly string[]): Promise<Command> {
  const program = createRootProgram();
  program.hook("preAction", (_command, action) => {
    if (!isWorkbenchManagement && !isRemoteBackendClient && ["web", "source", "package", "deep", "repair", "campaign"].includes(action.name()) && action.parent?.name() === "scan") {
      Object.assign(process.env, savedConnectionEnvPatch(process.env));
    }
  });
  await registerLazyCommandTree(program, args);
  setCrashCommandPaths(commandPathsOf(program));
  return program;
}


// Default to the account-free browser console under both Node and Bun.
async function showWebConsole(): Promise<void> {
  const { registerDashboardCommand } = await import("./commands/dashboard.js");
  const program = new Command();
  registerDashboardCommand(program);
  await program.parseAsync(["web"], { from: "user" });
}

// Debounce timers are unreferenced; flush the final batch of a short-lived
// command before natural process exit. Hard termination remains best-effort.
process.once("beforeExit", () => {
  void analyticsPipeline.flushNow().catch(() => {});
});

// A rejected command action prints its message and exits 2, not a Node stack trace.
// The stack prints only with ZERO_DEBUG, for debugging.
// Exit at once: a failed action can leave a server or database handle open.
function exitWithCommandError(err: unknown): never {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  if (process.env["ZERO_DEBUG"] && err instanceof Error) console.error(err.stack);
  process.exit(2);
}

// ── Entry point ──
// `0 ... | head` closes the pipe while we still write: leave quietly like other Unix tools, not with a stack trace.
for (const stream of [process.stdout, process.stderr]) stream.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") process.exit(0); throw error; });
let userArgs = process.argv.slice(2);
// Hidden A/B switch for the model-visible tool list: `--toolset core|full` (same as ZERO_TOOLSET).
{
  const at = userArgs.indexOf("--toolset");
  const value = at >= 0 ? userArgs[at + 1] : undefined;
  if (value === "core" || value === "full") {
    process.env["ZERO_TOOLSET"] = value;
    userArgs.splice(at, 2);
    process.argv = [process.argv[0], process.argv[1], ...userArgs];
  }
}
// The alias layer: old-old names and the new grammar become the implementation commands, and an old
// invocation that still works gets one dim `moved:` line (see command-compat.ts).
{
  const resolved = resolveInvocation(userArgs);
  if (resolved.notice && shouldPrintMovedNotice(userArgs, process.stdout.isTTY)) process.stderr.write(formatMovedNotice(resolved.notice, process.stderr.isTTY === true));
  userArgs = resolved.args;
  // A valid `--module` was rewritten to its implementation command above; one that is still here has no module to run.
  if (userArgs[0] === "scan" && userArgs.some(arg => arg === "--module" || arg.startsWith("--module="))) {
    console.error("Unknown or missing --module value. Use deep, repair, campaign, deps or deps-fix.");
    process.exit(2);
  }
}
process.argv = [process.argv[0], process.argv[1], ...userArgs];
const scanRoute = rewriteScanArgs(userArgs);
if (scanRoute) {
  userArgs = scanRoute;
  process.argv = [process.argv[0], process.argv[1], ...userArgs];
}

const knownCommands = new Set(["help", ...TOP_LEVEL_COMMANDS.flatMap(command => [command.name, ...command.aliases])]);

/** Run the program for `args`, which become the process arguments commander parses. */
async function runProgram(args: string[]): Promise<void> {
  process.argv = [process.argv[0], process.argv[1], ...args];
  const program = await buildProgram(args);
  program.parseAsync().catch(exitWithCommandError);
}

if (userArgs.length === 0) {
  // Default browser path avoids loading any other command.
  showWebConsole().catch(exitWithCommandError);
} else if (userArgs[0] === "-r" || userArgs[0] === "--resume") {
  // `0 -r [id]` is the top-level shortcut for `console --resume [id]`: resume a
  // saved chat session by id/prefix when a headless prompt is supplied. commander's
  // root can't take a bare `-r`, so rewrite argv onto the `console` subcommand.
  await runProgram(["lab", "console", "--resume", ...userArgs.slice(1)]);
} else if (userArgs[0] === "-c" || userArgs[0] === "--continue") {
  // `0 -c` → `console --continue`: reopen the most recent chat session.
  await runProgram(["lab", "console", "--continue", ...userArgs.slice(1)]);
} else if (userArgs[0] === "-p" || userArgs[0] === "--print") {
  // `0 -p "<prompt>"` → `console --print "<prompt>"`: one-shot non-interactive
  // query (or read the prompt from piped stdin when no argument is given).
  await runProgram(["lab", "console", "--print", ...userArgs.slice(1)]);
} else if (!knownCommands.has(userArgs[0]) && !userArgs[0].startsWith("-")) {
  const route = detectAndRoute(userArgs[0]);
  if (route) {
    await runProgram([...route, ...userArgs.slice(1)]);
  } else {
    console.error("Ambiguous target. Use the control plane (`0`) or an explicit URL, path, source:, npm:, pypi:, cargo:, or oci: target.");
    process.exitCode = 2;
  }
} else {
  await runProgram(userArgs);
}
