import { loadServicePluginConnections } from "../web/service-plugins.js";
import { consoleExecutionProfile } from "../console-execution.js";
import { stdin } from "node:process";

import type { Command } from "commander";
import chalk from "chalk";
import {
  createConsoleRuntime,
  loadScope,
  getScopeEnforcementState,
  parseMcpConfig,
  connectMcpServers, connectServicePlugins,
  DEFAULT_MAX_TOOL_ITERATIONS,
} from "@0/core";
import type {
  ConsoleAutonomyMode,
  ConsoleSession,
  ConsoleTurnOutcome,
  NativeMessage,
  ToolCall,
  ToolResult,
} from "@0/core";
import { DEFAULT_AUTONOMY_MODE } from "@0/shared";
import {
  processPresentationOutput,
  type ProcessPresentationOutput,
} from "../presentation/process-output.js";
import {
  buildFindingChatPrompt,
  loadFindingFocus,
  resolveFindingChatIntent,
} from "../finding-focus.js";

import { createLocalConsoleSession } from "../console-session.js";
interface ConsoleOptions {
  target?: string;
  scope?: string;
  finding?: string;
  findingIntent?: string;
  dbPath?: string;
  model?: string;
  role?: string;
  mode?: string;
  yolo?: boolean;
  autonomy?: string;
  maxToolCalls?: string;
  allowScanners?: boolean;
  /** `--resume [id]`: a session id/prefix to reopen, or `true` for the picker. */
  resume?: string | boolean;
  /** `--continue`: reopen the single most-recent console session, no picker. */
  continue?: boolean;
  /** `-p/--print [prompt]`: one-shot non-interactive prompt (or `true` → stdin). */
  print?: string | boolean;
  prompt?: string;
}

/** Read a piped prompt from stdin (for `--print` with no inline argument). */
async function readStdinPrompt(): Promise<string> {
  if (stdin.isTTY) return ""; // no pipe → nothing to read (don't hang on a tty)
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Launch autonomy modes accepted by `--mode` / `--autonomy`. */
export const CONSOLE_AUTONOMY_MODES = ["standard", "recon", "copilot", "yolo"] as const;

function isConsoleAutonomyMode(value: string): value is ConsoleAutonomyMode {
  return (CONSOLE_AUTONOMY_MODES as readonly string[]).includes(value);
}

export type ConsoleAutonomyResolution =
  | { ok: true; mode: ConsoleAutonomyMode }
  | { ok: false; error: string };

/**
 * Resolve the console's launch autonomy mode from the three surfaces that set
 * it, so the founder's discoverability gap ("how do I start in YOLO?") is
 * covered without changing what any mode permits:
 *   --mode <mode>     canonical, discoverable option
 *   --yolo            convenience shortcut, equivalent to --mode yolo
 *   --autonomy <mode> retained alias (documented in docs/commands.md)
 *
 * Precedence: --mode > --yolo > --autonomy > default "yolo". A conflicting
 * `--mode <x> --yolo` (x !== yolo) is a clear error rather than a silent pick.
 * Scope admission is supplied only by the explicitly enabled scope plugin;
 * the interactive Bun console can then request scope while headless cannot.
 */
export function resolveConsoleAutonomyMode(opts: {
  mode?: string;
  yolo?: boolean;
  autonomy?: string;
}): ConsoleAutonomyResolution {
  const choices = CONSOLE_AUTONOMY_MODES.join(", ");

  if (opts.mode !== undefined) {
    if (!isConsoleAutonomyMode(opts.mode)) {
      return { ok: false, error: `Invalid --mode '${opts.mode}': expected one of ${choices}.` };
    }
    if (opts.yolo && opts.mode !== "yolo") {
      return {
        ok: false,
        error: `Conflicting flags: --yolo with --mode ${opts.mode}. Pass only one (use --mode yolo, or drop --yolo).`,
      };
    }
    return { ok: true, mode: opts.mode };
  }

  if (opts.yolo) return { ok: true, mode: "yolo" };

  if (opts.autonomy !== undefined) {
    if (!isConsoleAutonomyMode(opts.autonomy)) {
      return { ok: false, error: `Invalid --autonomy '${opts.autonomy}': expected one of ${choices}.` };
    }
    return { ok: true, mode: opts.autonomy };
  }

  return { ok: true, mode: DEFAULT_AUTONOMY_MODE };
}

/**
 * `0 console` — the unified interactive chat cockpit.
 *
 * A single conversational surface where the operator talks to the engine and it
 * can invoke every 0 tool (recon, web pentest, source/package scan,
 * variant hunt, verify, patch-gen) in one place. Thin REPL over the engine-side
 * driver in `@0/core` (`createConsoleSession`) — the tool registry and LLM
 * runtime are the real ones the autonomous scanner uses; this command only owns
 * terminal I/O and rendering.
 */
export function registerConsoleCommand(program: Command): void {
  program
    .command("console")
    .alias("chat")
    .description(
      "Run a headless chat prompt; interactive conversations use 0 web",
    )
    .option("--target <url>", "Engagement target the tools operate against (optional; can be named in-chat)")
    .option("--scope <file>", "Initial policy for the optional scope plugin; activate with `0 plugin enable scope`")
    .option("--finding <id>", "Focus the chat on one persisted finding")
    .option("--finding-intent <intent>", "Finding workflow: investigate, verify, or draft_fix")
    .option("--db-path <path>", "Persistent findings database (defaults to ZERO_DB_PATH or the local store)")
    .option("-m, --model <id>", "Override the LLM model id (else provider default)")
    .option("--role <role>", "Tool set to expose: audit|review|discovery|attack|verify (default audit = every tool)")
    .option("--mode <mode>", "Approval mode: standard|recon|copilot|yolo (default yolo)")
    .option("--yolo", "Shortcut for --mode yolo (no per-action prompts; independent credential, private-network and sandbox protections remain).")
    .option("--autonomy <mode>", "Alias of --mode (standard|copilot|yolo|recon); --mode/--yolo take precedence.")
    .option("--max-tool-calls <n>", "Safety cap on tool-call rounds per message", String(DEFAULT_MAX_TOOL_ITERATIONS))
    .option("--allow-scanners", "Expose generic-scanner tool wrappers (sqlmap/nikto/…); default off")
    .option("--resume [id]", "With a headless prompt, reopen a saved session by id or unique prefix; use browser history for a picker.")
    .option("--continue", "With a headless prompt, continue the most recent saved console session.")
    .option("-p, --print [prompt]", "Non-interactive: run ONE prompt through the engine, print the result, and exit (no TUI). Reads the prompt from the argument or piped stdin. Combine with --continue/--resume to query a saved session. Also reachable as `0 -p <prompt>`.")
    .option("--prompt <text>", "Run one headless prompt (alias for --print)")
    .action(async (opts: ConsoleOptions) => {
      if (opts.prompt !== undefined) opts.print = opts.prompt;
      if (opts.print === undefined) {
        console.log("Interactive conversations are in the browser. Run 0 web (no account required). For automation use 0 chat --prompt \"your request\" or 0 -p \"your request\".");
        return;
      }
      let maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS;
      if (opts.maxToolCalls !== undefined) {
        const parsed = Number(opts.maxToolCalls);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          console.error(chalk.red(`Invalid --max-tool-calls '${opts.maxToolCalls}': must be a positive number.`));
          process.exitCode = 2;
          return;
        }
        maxToolIterations = parsed;
      }

      const VALID_ROLES = ["discovery", "attack", "verify", "report", "audit", "review"] as const;
      type ConsoleRole = (typeof VALID_ROLES)[number];
      let role: ConsoleRole = "audit";
      if (opts.role !== undefined) {
        if (!VALID_ROLES.includes(opts.role as ConsoleRole)) {
          console.error(chalk.red(`Invalid --role '${opts.role}': expected one of ${VALID_ROLES.join(", ")}.`));
          process.exitCode = 2;
          return;
        }
        role = opts.role as ConsoleRole;
      }

      const autonomyResolution = resolveConsoleAutonomyMode({
        mode: opts.mode,
        yolo: opts.yolo,
        autonomy: opts.autonomy,
      });
      if (!autonomyResolution.ok) {
        console.error(chalk.red(autonomyResolution.error));
        process.exitCode = 2;
        return;
      }
      const autonomyMode: ConsoleAutonomyMode = autonomyResolution.mode;
      const scopeEnforcement = getScopeEnforcementState();
      console.error(chalk.dim(scopeEnforcement.message));

      let scope;
      if (opts.scope) {
        try {
          scope = loadScope(opts.scope);
        } catch (err) {
          console.error(chalk.red(`Failed to load --scope '${opts.scope}': ${err instanceof Error ? err.message : String(err)}`));
          process.exitCode = 2;
          return;
        }
      }

      if (scopeEnforcement.enabled && autonomyMode === "yolo" && !hasConfiguredScope(scope)) {
        console.error(chalk.red("YOLO mode requires --scope <file> with at least one in_scope entry."));
        process.exitCode = 2;
        return;
      }
      let findingPrompt: string | undefined;
      let findingTarget: string | undefined;
      if (opts.finding) {
        try {
          const focus = loadFindingFocus(opts.finding, { dbPath: opts.dbPath });
          findingPrompt = buildFindingChatPrompt(
            focus,
            resolveFindingChatIntent(opts.findingIntent),
          );
          findingTarget = focus.target;
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exitCode = 2;
          return;
        }
      } else if (opts.findingIntent !== undefined) {
        console.error(chalk.red("--finding-intent requires --finding <id>."));
        process.exitCode = 2;
        return;
      }


      // Resolve a saved console session to resume/continue. `--continue` (and
      // the `0 -c` shortcut) → the single most-recent; `--resume <id>` → that id
      // or a unique prefix; bare `--resume` (and `0 -r`) → an interactive picker.
      // A resumed session inherits its stored model/target unless overridden.
      let resumeMessages: readonly unknown[] | undefined;
      let resumedModel: string | undefined;
      let resumedTarget: string | undefined;
      if (opts.continue || opts.resume !== undefined) {
        const { listSessions, loadSession } = await import("../tui/session-store.js");
        const idArg = typeof opts.resume === "string" ? opts.resume.trim() : "";
        if (idArg || opts.continue) {
          let stored = idArg ? loadSession(idArg) : null;
          if (!stored && idArg) {
            const matches = listSessions(undefined, { limit: 500 }).filter((s) => s.id.startsWith(idArg));
            if (matches.length === 1) stored = loadSession(matches[0].id);
            else if (matches.length > 1) {
              console.error(chalk.red(`'${idArg}' matches ${matches.length} sessions — use a longer prefix or the full id.`));
              process.exitCode = 2;
              return;
            }
          } else if (!stored && opts.continue) {
            const recent = listSessions(undefined, { limit: 1 })[0];
            stored = recent ? loadSession(recent.id) : null;
          }
          if (!stored) {
            console.error(chalk.red(idArg ? `No console session matches '${idArg}'.` : "No saved console session to continue."));
            process.exitCode = 1;
            return;
          }
          resumeMessages = stored.messages;
          resumedModel = stored.model;
          resumedTarget = stored.target;
        } else {
          console.error("Choose a saved session id with --resume <id>, or open saved conversations in 0 web.");
          process.exitCode = 2;
          return;
        }
      }

      const focusedTarget = resumedTarget ?? opts.target ?? findingTarget;

      // Non-interactive one-shot: run a single prompt headless and exit. Handled
      // BEFORE the TUI/readline branches — `-p` is a scriptable query, not a
      // session — and reuses the same session build + `runTurn` the readline
      // console uses, so tool traces + the answer stream to stdout identically.
      if (opts.print !== undefined) {
        const promptText =
          typeof opts.print === "string" && opts.print.trim()
            ? opts.print
            : await readStdinPrompt();
        if (!promptText.trim()) {
          console.error(chalk.red('--print needs a prompt: pass `--print "…"` or pipe it on stdin.'));
          process.exitCode = 2;
          return;
        }
        let printSession: ConsoleSession;
        try {
          const runtime = createConsoleRuntime({ model: resumedModel ?? opts.model });
          const resolvedModel = runtime.resolvedModel();
          printSession = createLocalConsoleSession({
            runtime,
            target: focusedTarget,
            costModel: resolvedModel,
            role,
            maxToolIterations,
            allowScanners: opts.allowScanners,
            scope,
            autonomyMode,
            ...(resumeMessages ? { initialMessages: resumeMessages as NativeMessage[] } : {}),
            // Headless: no operator to approve a scope extension or a copilot gate.
            requestScope: async () => null,
            approveTool: autonomyMode === "copilot" ? async () => false : undefined,
          }, opts.dbPath);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          console.error(chalk.dim("The console needs an LLM provider. Set ANTHROPIC_API_KEY (or another supported provider key) and retry."));
          process.exitCode = 2;
          return;
        }
        try {
          const request = findingPrompt
            ? `${findingPrompt}\n\nOperator request:\n${promptText}`
            : promptText;
          const outcome = await runTurn(printSession, request, processPresentationOutput);
          if (outcome.stopReason === "error") process.exitCode = 1;
          process.stdout.write("\n");
        } catch (err) {
          console.error(chalk.red(`\nturn failed: ${err instanceof Error ? err.message : String(err)}`));
          process.exitCode = 1;
        } finally {
          await printSession.cleanup();
        }
        return;
      }

    });
}

async function runTurn(
  session: ConsoleSession,
  text: string,
  output: ProcessPresentationOutput,
): Promise<ConsoleTurnOutcome> {
  let streamedAny = false;
  output.stdout("\n" + chalk.bold.green("engine › "), "console.assistant.prefix");

  const outcome = await session.send(text, {
    onAssistantDelta: (chunk) => {
      streamedAny = true;
      output.stdout(chunk, "console.assistant.delta");
    },
    onToolStart: (call: ToolCall) => {
      output.stdout(
        "\n" + chalk.yellow(`  ⚙ ${call.name}`) + chalk.dim(` ${previewArgs(call.arguments)}`),
        "console.tool.started",
      );
    },
    onToolResult: (_call: ToolCall, result: ToolResult) => {
      const mark = result.success ? chalk.green("✓") : chalk.red("✗");
      output.stdout(chalk.dim(` → ${mark} ${previewResult(result)}`), "console.tool.completed");
    },
    onNotice: (msg) => {
      output.stdout("\n" + chalk.dim(`  (${msg})`), "console.notice");
    },
  });

  // If nothing streamed token-by-token (provider without delta support), print
  // the collected assistant text now.
  if (!streamedAny && outcome.assistantText) {
    output.stdout("\n" + outcome.assistantText, "console.assistant.complete");
  }

  const usage = outcome.usage;
  const footer = `${outcome.toolCalls.length} tool call${outcome.toolCalls.length === 1 ? "" : "s"} · ${usage.inputTokens}→${usage.outputTokens} tok`;
  output.stdout("\n" + chalk.dim(`  [${footer}]`) + "\n", "console.turn.completed");

  if (outcome.stopReason === "error") {
    output.stderr(chalk.red(`\nengine error: ${outcome.error ?? "unknown"}\n`), "console.turn.error");
    if (/ChatGPT.*model.*not supported/i.test(outcome.error ?? "")) {
      output.stderr(chalk.dim("Choose an available account/provider model with --model; the interactive /model picker lists the current account catalog. Alternatively configure a provider that supports the requested model. No replacement model was selected.\n"), "console.turn.model_unavailable");
    }
  }
  return outcome;
}

function previewArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > 120 ? json.slice(0, 117) + "…" : json;
}

function previewResult(result: ToolResult): string {
  const raw = result.success
    ? typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output)
    : result.error ?? "failed";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? flat.slice(0, 97) + "…" : flat;
}

function hasConfiguredScope(scope: ConsoleSession["scope"]): boolean {
  return (scope?.raw.in_scope?.length ?? 0) > 0;
}
