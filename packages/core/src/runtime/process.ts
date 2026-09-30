import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import type { Runtime, RuntimeConfig, RuntimeContext, RuntimeResult, RuntimeType } from "./types.js";

// Dim the subprocess output so it's visually distinct from 0's own output
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

function formatToolDetail(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (inp?.file_path) return String(inp.file_path).split("/").slice(-2).join("/");
  if (inp?.command) return String(inp.command).slice(0, 60);
  if (inp?.pattern) return String(inp.pattern).slice(0, 40);
  if (inp?.path) return String(inp.path).slice(0, 60);
  if (inp?.content) return "(writing file)";
  return "";
}

/** Map raw MCP tool names to human-friendly labels. */
function friendlyToolName(name: string): string {
  const stripped = name.replace(/^mcp__\w+__/, "");
  return stripped
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function showToolCall(
  onToolCall: ((name: string, detail: string) => void) | undefined,
  name: string | undefined,
  input: unknown,
): void {
  const rawName = name || "tool";
  // Skip internal/framework tool calls that aren't meaningful to the user
  if (/^(ToolSearch|Read|Glob|Grep|Write|Edit|Bash|LSP|Agent)$/i.test(rawName)) return;
  const toolName = friendlyToolName(rawName);
  const detail = formatToolDetail(input);

  if (onToolCall) {
    onToolCall(toolName, detail);
  }

  // Fallback: write to stderr for raw terminal display (only when no TUI)
  if (process.stderr.isTTY && !onToolCall) {
    process.stderr.write(dim(`    ${toolName}${detail ? ": " + detail : ""}\n`));
  }
}

const RUNTIME_COMMANDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
};

function resolveCliEntrypoint(): string {
  return resolve(process.argv[1] ?? join(process.cwd(), "dist", "index.js"));
}

function buildOsecMcpCommandArgs(context: RuntimeContext): string[] {
  const cliEntrypoint = resolveCliEntrypoint();
  const args = [
    cliEntrypoint,
    "mcp-server",
    "--target",
    context.target ?? "",
    "--scan-id",
    context.scanId ?? "no-scan-id",
  ];

  if (context.mcp?.dbPath) {
    args.push("--db-path", context.mcp.dbPath);
  }
  if (context.mcp?.scopeFile) {
    args.push("--scope", context.mcp.scopeFile);
  }
  if (context.mcp?.rateLimit) {
    args.push("--rate-limit", context.mcp.rateLimit);
  }
  if (context.mcp?.allowScanners) {
    args.push("--allow-scanners");
  }

  return args;
}


function buildClaudeMcpConfig(context: RuntimeContext): string {
  return JSON.stringify({
    mcpServers: {
      "0": {
        command: process.execPath,
        args: buildOsecMcpCommandArgs(context),
      },
    },
  });
}

/**
 * Turn a spawn failure into something a caller can act on.
 *
 * The runtime prompt travels as a single argv entry, so on a large enough
 * target the kernel rejects the exec with E2BIG before the CLI starts — Bun
 * throws that synchronously out of `spawn`, so it escaped the process error
 * handler and surfaced as a raw stack trace (#72).
 */
export function describeSpawnFailure(err: unknown, command: string, argv: readonly string[]): string {
  const code = (err as { code?: string } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "E2BIG" || message.includes("E2BIG")) {
    const bytes = argv.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 1, 0);
    return `${command} could not be started: the prompt is too large for one command line (${bytes} bytes of arguments, over this system's limit). Narrow the run — a smaller --subsystem or scope, or a lower --batch-size — so less content is sent in a single request.`;
  }
  return message;
}

export class ProcessRuntime implements Runtime {
  readonly type: RuntimeType;
  private config: RuntimeConfig;
  private command: string;

  constructor(config: RuntimeConfig) {
    this.type = config.type as RuntimeType;
    this.config = config;
    this.command = RUNTIME_COMMANDS[config.type] ?? config.type;
  }

  async execute(prompt: string, context?: RuntimeContext): Promise<RuntimeResult> {
    const start = Date.now();
    const args = this.buildArgs(prompt, context);
    const env = this.buildEnv(context);

    const onToolCall = this.config.onToolCall;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let resultText = "";
      let timedOut = false;
      const isJsonStream = args.includes("stream-json") || args.includes("--json");

      let proc: ChildProcessByStdio<null, Readable, Readable>;
      try {
        proc = spawn(this.command, args, {
          cwd: this.config.cwd ?? process.cwd(),
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        // E2BIG and friends throw synchronously, so they never reach the
        // "error" listener below.
        resolve({
          output: "",
          exitCode: 1,
          timedOut: false,
          durationMs: Date.now() - start,
          error: describeSpawnFailure(err, this.command, args),
        });
        return;
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        if (isJsonStream) {
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);

              // Claude stream-json format
              if (event.type === "assistant" && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === "text") {
                    resultText += block.text;
                    this.config.onThinking?.(block.text);
                  } else if (block.type === "tool_use") {
                    showToolCall(onToolCall, block.name, block.input);
                  }
                }
              } else if (event.type === "result") {
                resultText = event.result || resultText;
              }

              // Codex JSONL format
              if (event.type === "item.started" && event.item?.type === "command_execution") {
                showToolCall(onToolCall, "shell", { command: event.item.command });
              }
              if (event.type === "item.completed" && event.item) {
                if (event.item.type === "agent_message" && event.item.text) {
                  resultText += event.item.text;
                  this.config.onThinking?.(event.item.text);
                } else if (event.item.type === "command_execution" && event.item.command) {
                  // Already shown on item.started
                }
              }

            } catch {
              // Not valid JSON line, skip
            }
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;

        // Detect MCP permission loop: if the subprocess keeps asking for
        // tool approval, kill it with a helpful error instead of looping
        if (/permission|approve|allow.*tool/i.test(stderr) && stderr.length > 500) {
          proc.kill("SIGTERM");
          stderr += "\n[0] Subprocess killed: MCP tools require interactive approval. Use --runtime api instead.";
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5_000);
      }, this.config.timeout);

      proc.on("close", (code) => {
        clearTimeout(timer);
        // For stream-json, use the parsed result text; otherwise raw stdout
        const output = isJsonStream ? (resultText || stdout).trim() : stdout.trim();
        resolve({
          output,
          exitCode: code,
          timedOut,
          durationMs: Date.now() - start,
          error: code !== 0 ? stderr.trim() || undefined : undefined,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          output: "",
          exitCode: 1,
          timedOut: false,
          durationMs: Date.now() - start,
          error: describeSpawnFailure(err, this.command, args),
        });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    // Probe `<runtime> --version` with a single retry to absorb cold-start
    // variance. The fast happy path is unchanged (~ms on a warm host) but
    // the previous 5s single-shot deadline failed false-negative on
    // E2B-style ephemeral sandboxes: a freshly-booted container has cold
    // OS page-cache on /usr/local/bin/<runtime>, so the first exec pays
    // for the binary load + dynamic linker + the runtime's own startup,
    // which can exceed 5s for an ~80 MB Rust binary. Empirically observed
    // (2026-05-13 0-cloud rollout): same lodash audit dispatched
    // back-to-back where one sandbox succeeded and the next failed with
    // "Runtime 'codex' not available. Is codex installed?", correlating
    // with sandbox cold/warm state, not codex install state. After this
    // change the failure window is gone — total cap is ~20s, well under
    // any reasonable orchestrator-level dispatch timeout.
    const attempt = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        const proc = spawn(this.command, ["--version"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        proc.on("close", (code) => finish(code === 0));
        proc.on("error", () => finish(false));
        setTimeout(() => {
          proc.kill();
          finish(false);
        }, timeoutMs).unref?.();
      });
    // First attempt: warm-path budget. If a runtime is installed and the
    // file cache is hot this returns true in well under a second.
    if (await attempt(5_000)) return true;
    // Retry with a generous deadline before declaring unavailable.
    // Catches cold-disk first-exec cost.
    return attempt(15_000);
  }

  private buildArgs(prompt: string, context?: RuntimeContext): string[] {
    switch (this.type) {
      case "claude": {
        const args = ["-p", prompt, "--verbose", "--output-format", "stream-json"];
        if (context?.mcp?.enableTargetTools && context.target && context.scanId) {
          // --dangerously-skip-permissions auto-approves MCP tool calls
          // without this, the subprocess hangs waiting for interactive approval
          args.push("--mcp-config", buildClaudeMcpConfig(context), "--dangerously-skip-permissions");
        }
        if (context?.systemPrompt) {
          args.push("--system-prompt", context.systemPrompt);
        }
        // Structured output schema for findings
        if (this.config.outputSchema) {
          args.push("--json-schema", JSON.stringify(this.config.outputSchema));
        }
        return args;
      }
      case "codex": {
        const args = [
          "exec",
          "--skip-git-repo-check",
          "--json",
        ];
        if (this.config.model) {
          args.push("--model", this.config.model);
        }
        if (context?.mcp?.enableTargetTools && context.target && context.scanId) {
          throw new Error(
            "Codex CLI MCP target tools are not supported. Use the direct ChatGPT Codex provider for live target scans.",
          );
        }
        if (this.config.outputSchema) {
          // Codex needs schema as a file — write to temp
          const schemaPath = join(tmpdir(), `0-schema-${Date.now()}.json`);
          writeFileSync(schemaPath, JSON.stringify(this.config.outputSchema));
          args.push("--output-schema", schemaPath);
        }
        args.push(prompt);
        return args;
      }
      case "gemini": {
        const args = ["-p", prompt, "--output-format", "stream-json"];
        return args;
      }
      default:
        return ["-p", prompt];
    }
  }

  private buildEnv(context?: RuntimeContext): Record<string, string> {
    const env: Record<string, string> = {
      ...this.config.env,
    };

    if (context?.target) {
      env["ZERO_TARGET"] = context.target;
    }
    if (context?.findings) {
      env["ZERO_FINDINGS"] = context.findings;
    }
    if (context?.templateId) {
      env["ZERO_TEMPLATE_ID"] = context.templateId;
    }
    if (context?.mcp?.auth) {
      env["ZERO_MCP_AUTH_JSON"] = JSON.stringify(context.mcp.auth);
    }
    if (context?.mcp?.attributionHeaders) {
      env["ZERO_MCP_ATTRIBUTION_HEADERS_JSON"] = JSON.stringify(context.mcp.attributionHeaders);
    }
    if (context?.mcp?.attributionUaToken) {
      env["ZERO_MCP_ATTRIBUTION_UA_TOKEN"] = context.mcp.attributionUaToken;
    }

    return env;
  }
}
