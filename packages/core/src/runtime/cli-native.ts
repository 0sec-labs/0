import { spawn, type ChildProcess } from "node:child_process";
import type {
  NativeRuntime,
  NativeMessage,
  NativeContentBlock,
  NativeToolDef,
  NativeRuntimeResult,
  NativeStreamCallbacks,
  RuntimeConfig,
  RuntimeType,
} from "./types.js";
import type { SubagentModelSelection } from "./types.js";
import { readCacheUsage } from "./prompt-cache.js";
import {
  ClaudeToolBridge,
  CLAUDE_TOOL_BRIDGE_SERVER,
  nativeToolNameFromClaude,
  type ClaudeToolBridgeCall,
  type ClaudeToolBridgeResult,
} from "./claude-tool-bridge.js";

/**
 * Quiet period after the last stdout event or bridge call before a batch of
 * tool calls is handed to the native loop, so parallel tool_use blocks from
 * one assistant message travel together.
 */
const TOOL_BATCH_SETTLE_MS = 150;
/** Grace period for a bridge call's tool_use block to appear on stdout. */
const STDOUT_CATCH_UP_MS = 2_000;

/**
 * CliNativeRuntime — wraps a CLI runtime (`claude`, `codex`, `gemini`) so
 * that it satisfies the {@link NativeRuntime} contract used by
 * `runNativeAgentLoop()`.
 *
 * The motivation is subscription auth: users who pay for Claude Max /
 * ChatGPT / Gemini already have working CLI auth on their machine, but
 * the legacy {@link Runtime} interface only supports a single
 * round-trip per call. The native loop drives a multi-turn conversation
 * through structured `tool_use` / `tool_result` blocks, which until now
 * required a raw API key.
 *
 * ## Strategy: session resume
 *
 * Claude Code emits a `session_id` in its `system` init event and on
 * every subsequent `assistant` event. We capture it on turn 1 and pass
 * `--resume <session_id>` on every later call. Claude Code holds the
 * conversation server-side, so we only need to feed the *latest* user
 * turn (a JSON-encoded array of `tool_result` blocks plus any free
 * text) on each invocation.
 *
 * ## Tools: the native loop's tools, executed by 0
 *
 * When the loop passes tool definitions, Claude Code must call *those* tools
 * and 0 must execute them (scope checks, evidence, finding state). Each turn
 * with tools therefore runs `claude -p` against a loopback MCP server — the
 * {@link ClaudeToolBridge} — that advertises exactly the loop's tools and
 * holds every `tools/call` open until the loop supplies the result.
 * Claude Code's built-in tools and any MCP servers from the user's own
 * configuration are disabled (`--tools ""`, `--strict-mcp-config`), so the
 * model cannot act outside the tool set 0 controls.
 *
 * The process stays alive between loop turns: a turn ends when Claude Code
 * is blocked on bridge calls, the loop executes them, and the next
 * `executeNative` call delivers the results to the waiting calls instead of
 * spawning `--resume`. If the loop answers anything other than the calls it
 * was given, the live process is discarded and the call falls back to the
 * resume strategy above.
 *
 * Codex and Gemini are not currently supported for multi-turn — their
 * resume semantics are either undocumented or differ enough that this
 * PR keeps the surface area small. They fall through with a clear
 * error directing the user to `--runtime claude` or to set an API key.
 *
 * ## Known tradeoffs (called out in the bounty discussion)
 *
 * - **Dual context windows.** Claude Code manages its own context
 *   internally; 0's native loop also manages context (compaction,
 *   message history). Both are running, side-by-side, on the same
 *   conversation. This is acceptable: Claude Code's own compaction
 *   prevents the subprocess from blowing up, and 0's native-loop
 *   features (loop detection, early-stop, playbook injection) still
 *   fire on top of whatever Claude Code returns.
 * - **Token usage opacity.** stream-json reports the same token counts
 *   the Anthropic API returns to Claude Code itself, which is good
 *   enough for soft cost-ceiling enforcement.
 * - **Subprocess fragility.** If the spawn crashes, we surface
 *   `stopReason: "error"`. The native loop's existing retry path
 *   handles that the same way it handles an API 5xx.
 */
export class CliNativeRuntime implements NativeRuntime {
  readonly type: RuntimeType;
  private config: RuntimeConfig;
  private command: string;
  /** Populated from the first turn's stream-json `system` event. */
  private sessionId: string | undefined;
  private observedModel: string | undefined;
  /** Claude Code process blocked on tool-bridge calls between loop turns. */
  private live: BridgedClaudeProcess | undefined;

  constructor(config: RuntimeConfig) {
    if (config.type === "api") {
      throw new Error(
        "CliNativeRuntime does not support type=api. Use LlmApiRuntime instead.",
      );
    }
    this.type = config.type;
    this.config = config;
    this.command = config.type;
  }

  /**
   * Reset the cached session id so the next call starts a brand-new
   * Claude Code session. The native loop uses this between scans.
   */
  resetSession(): void {
    this.sessionId = undefined;
    this.disposeLive();
  }

  private disposeLive(): void {
    this.live?.dispose();
    this.live = undefined;
  }
  resolvedModel(): string { return this.observedModel ?? this.config.model ?? "unknown"; }

  async forkForSubagent(timeout: number, selection?: SubagentModelSelection): Promise<NativeRuntime> {
    const pin = selection?.role && Object.hasOwn(this.config.agentModels ?? {}, selection.role) ? this.config.agentModels?.[selection.role] : undefined;
    const parentModel = this.observedModel ?? this.config.model;
    const model = this.config.singleModel ? parentModel : selection?.model ?? (pin && pin !== "auto" ? pin : parentModel);
    if (model !== parentModel && !Object.values(this.config.agentModels ?? {}).some(approved => approved !== "auto" && approved === model)) {
      throw new Error(`Model '${model}' was not approved for this CLI runtime.`);
    }
    return new CliNativeRuntime({ ...this.config, timeout, model });
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.command, ["--version"], {
        cwd: this.config.cwd ?? process.cwd(),
        env: { ...process.env, ...this.config.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 5_000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  async executeNative(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult> {
    const start = Date.now();
    if (signal?.aborted) return { content: [], stopReason: "error", durationMs: 0, cancelled: true, error: "CLI execution cancelled." };

    if (this.type !== "claude") {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error:
          `Native multi-turn agent loop is only supported for the 'claude' CLI runtime. ` +
          `'${this.type}' does not yet expose a stable session-resume protocol — ` +
          `use --runtime claude (with 'claude login') for subscription auth, ` +
          `or set ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY for --runtime api.`,
      };
    }

    if (tools.length > 0) return this.executeWithToolBridge(system, messages, tools, callbacks, signal);
    // A tool-less call (e.g. a context summary) made while a bridged process
    // is blocked on tool calls runs as an isolated one-off: resuming the same
    // session from a second process would race the live one.
    const isolated = this.live !== undefined && !this.live.exited;
    const clearSession = () => { if (!isolated) this.sessionId = undefined; };

    // The native loop accumulates the entire conversation in `messages`.
    // Claude Code holds it server-side once we have a session id, so we
    // only need to push the latest user turn down the wire.
    const promptText = buildClaudePromptFromLastUser(messages);
    if (!promptText) {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error: "CliNativeRuntime: last message was not a user turn (cannot prompt Claude Code).",
      };
    }

    const args: string[] = ["-p", promptText, "--verbose", "--output-format", "stream-json"];
    if (this.config.model) args.push("--model", this.config.model);
    if (this.sessionId && !isolated) {
      args.push("--resume", this.sessionId);
    } else if (system && system.trim().length > 0) {
      // System prompt is only meaningful on the first turn — once a
      // session exists, Claude Code retains the original system prompt
      // and re-passing it via `--append-system-prompt` would silently
      // double-append on every turn.
      args.push("--system-prompt", system);
    }

    return new Promise((resolve) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let timedOut = false;
      const content: NativeContentBlock[] = [];
      let stopReason: NativeRuntimeResult["stopReason"] = "end_turn";
      let usage: NativeRuntimeResult["usage"];
      let sawAssistantEnd = false;
      let resultError: string | undefined;

      const proc: ChildProcess = spawn(this.command, args, {
        cwd: this.config.cwd ?? process.cwd(),
        env: { ...process.env, ...this.config.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf-8");

        // Newline-delimited JSON. Drain complete lines; leave any
        // trailing partial in the buffer for the next chunk.
        let nl = stdoutBuf.indexOf("\n");
        while (nl >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          nl = stdoutBuf.indexOf("\n");
          if (!line) continue;
          const event = tryParseJson(line);
          if (!event) continue;

          // Capture session id from the first event that carries it —
          // both the `system` init event and every `assistant` event
          // include `session_id` at the top level.
          if (typeof event.session_id === "string" && !this.sessionId && !isolated) {
            this.sessionId = event.session_id;
          }

          // ── Assistant message blocks ──
          // An event with `error` carries Claude Code's own error text, not model output.
          if (
            event.type === "assistant"
            && event.message
            && Array.isArray(event.message.content)
            && !event.error
          ) {
            for (const block of event.message.content) {
              if (block?.type === "text" && typeof block.text === "string") {
                content.push({ type: "text", text: block.text });
                if (block.text.trim()) callbacks?.onThinking?.(block.text);
              } else if (
                block?.type === "tool_use"
                && typeof block.id === "string"
                && typeof block.name === "string"
              ) {
                content.push({
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input:
                    block.input && typeof block.input === "object"
                      ? (block.input as Record<string, unknown>)
                      : {},
                });
              }
            }

            // Surface any per-turn usage Claude Code attaches to
            // assistant events so the cost ceiling has fresher data
            // than waiting for the terminal `result` event.
            const u = event.message?.usage as Record<string, unknown> | undefined;
            if (u) {
              const partial = readUsage(u);
              if (partial) callbacks?.onUsage?.(partial);
            }
          }
          if (typeof event.message?.model === "string") this.observedModel = event.message.model;

          // ── Final result event ──
          if (event.type === "result") {
            sawAssistantEnd = true;
            if (event.is_error) resultError = String(event.result || "Claude Code returned an error result.");
            stopReason = mapClaudeStopReason(event.stop_reason ?? event.subtype);
            const u = event.usage as Record<string, unknown> | undefined;
            if (u) usage = readUsage(u) ?? usage;
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf-8");
      });

      let killTimer: NodeJS.Timeout | undefined;
      const terminate = () => {
        if (proc.pid && process.platform !== "win32") {
          try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
        } else proc.kill("SIGTERM");
        killTimer ??= setTimeout(() => {
          if (proc.pid && process.platform !== "win32") {
            try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
          } else proc.kill("SIGKILL");
        }, 1_000);
      };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, this.config.timeout || 600_000);
      signal?.addEventListener("abort", terminate, { once: true });
      if (signal?.aborted) terminate();

      proc.on("error", (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", terminate);
        // Spawn-level failure also invalidates any cached session id —
        // see the `close` handlers below for the same rationale.
        clearSession();
        resolve({
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          durationMs: Date.now() - start,
          error: `claude CLI spawn failed: ${err.message}`,
        });
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", terminate);
        if (signal?.aborted) {
          clearSession();
          resolve({ content, stopReason: "error", usage, durationMs: Date.now() - start, cancelled: true, error: "CLI execution cancelled." });
          return;
        }

        if (timedOut) {
          // A timed-out resume often means Claude Code lost the session
          // server-side (idle eviction, restart, expiry). Drop the cached
          // id so the next call falls back to a fresh `--system-prompt`
          // invocation instead of looping on `--resume <stale_id>`.
          clearSession();
          resolve({
            content: content.length > 0 ? content : [{ type: "text", text: "" }],
            stopReason: "error",
            usage,
            durationMs: Date.now() - start,
            error: `claude CLI timed out after ${this.config.timeout}ms`,
          });
          return;
        }

        if (code !== 0 && (!sawAssistantEnd || resultError !== undefined)) {
          // Surface any auth / login hint Claude Code dumped to stderr.
          // Common modes: "Please run claude login", "session expired".
          // Claude Code also reports "Not logged in" as an error result on stdout.
          const hint = extractAuthHint(`${stderrBuf}\n${resultError ?? ""}`) ?? resultError;
          // Same rationale as the timeout path: a non-zero exit on a
          // resume usually means the server-side session is gone. Clear
          // the cached id so we don't wedge the native loop replaying
          // `--resume` against an id Claude Code no longer recognises.
          clearSession();
          resolve({
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            usage,
            durationMs: Date.now() - start,
            error:
              `claude CLI exited ${code}` +
              (hint ? ` — ${hint}` : "") +
              (stderrBuf.trim() ? `\nstderr: ${stderrBuf.trim().slice(0, 500)}` : ""),
          });
          return;
        }

        resolve({
          content:
            content.length > 0 ? content : [{ type: "text", text: "" }],
          stopReason,
          usage,
          durationMs: Date.now() - start,
        });
      });
    });
  }

  /**
   * Run one native-loop turn whose tools are executed by 0 through the
   * {@link ClaudeToolBridge}. Continues the live process when the loop
   * answers exactly the calls handed out on the previous turn; otherwise
   * starts a new process (resuming the session when one exists).
   */
  private async executeWithToolBridge(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult> {
    const start = Date.now();
    // The loop can follow its tool results with further user messages (loot
    // re-injection, loop-detection nudges), so read the whole reply.
    const reply = trailingUserTurn(messages);
    const live = this.live;
    if (live && reply && live.canAccept(reply)) {
      live.deliver(reply);
      return this.awaitLiveTurn(live, callbacks, signal);
    }
    this.disposeLive();

    const promptText = buildClaudePromptFromLastUser(reply ? [reply] : messages);
    if (!promptText) {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error: "CliNativeRuntime: last message was not a user turn (cannot prompt Claude Code).",
      };
    }

    let bridge: ClaudeToolBridge;
    try {
      bridge = await ClaudeToolBridge.start(tools);
    } catch (err) {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error: `claude CLI tool bridge failed to start: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (signal?.aborted) {
      await bridge.close();
      return { content: [], stopReason: "error", durationMs: Date.now() - start, cancelled: true, error: "CLI execution cancelled." };
    }

    const args: string[] = ["-p", promptText, "--verbose", "--output-format", "stream-json"];
    if (this.config.model) args.push("--model", this.config.model);
    if (this.sessionId) args.push("--resume", this.sessionId);
    else if (system && system.trim().length > 0) args.push("--system-prompt", system);
    args.push(
      "--mcp-config", bridge.mcpConfig(),
      "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", `mcp__${CLAUDE_TOOL_BRIDGE_SERVER}`,
      "--permission-mode", "default",
    );

    let proc: ChildProcess;
    try {
      proc = spawn(this.command, args, {
        cwd: this.config.cwd ?? process.cwd(),
        env: { ...process.env, ...this.config.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      await bridge.close();
      this.sessionId = undefined;
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error: `claude CLI spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const created = new BridgedClaudeProcess(proc, bridge, {
      timeoutMs: this.config.timeout || 600_000,
      onSessionId: (id) => { if (!this.sessionId) this.sessionId = id; },
      onModel: (model) => { this.observedModel = model; },
      clearSession: () => { this.sessionId = undefined; },
    });
    this.live = created;
    return this.awaitLiveTurn(created, callbacks, signal, start);
  }

  private async awaitLiveTurn(
    live: BridgedClaudeProcess,
    callbacks: NativeStreamCallbacks | undefined,
    signal: AbortSignal | undefined,
    start = Date.now(),
  ): Promise<NativeRuntimeResult> {
    const result = await live.nextTurn(callbacks, signal, start);
    if (live.exited && this.live === live) this.live = undefined;
    return result;
  }
}

type ToolUseBlock = Extract<NativeContentBlock, { type: "tool_use" }>;
type Usage = NonNullable<NativeRuntimeResult["usage"]>;

interface BridgedTurn {
  content: NativeContentBlock[];
  /** Per-API-message usage; Claude Code repeats it on every block event of a message. */
  usageByMessage: Map<string, Usage>;
}

interface TurnWaiter {
  resolve: (result: NativeRuntimeResult) => void;
  start: number;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort: () => void;
  callbacks?: NativeStreamCallbacks;
  timedOut: boolean;
}

/**
 * A `claude -p` process whose tool calls arrive through a
 * {@link ClaudeToolBridge} and stay blocked until the native loop supplies
 * their results. One instance spans as many loop turns as the model needs;
 * it ends when Claude Code emits its final `result` and exits.
 */
class BridgedClaudeProcess {
  exited = false;
  /** tool_use ids handed to the loop whose results have not been delivered yet. */
  private readonly outstanding = new Set<string>();
  /** Bridge calls blocked on a result, by tool_use id. */
  private readonly waiting = new Map<string, (result: ClaudeToolBridgeResult) => void>();
  /** Results delivered before Claude Code issued the matching call (serial tool execution). */
  private readonly early = new Map<string, ClaudeToolBridgeResult>();
  /** Every bridged tool_use block seen on stdout, by id. */
  private readonly seen = new Map<string, ToolUseBlock>();
  private readonly called = new Set<string>();
  private readonly callInfo = new Map<string, ClaudeToolBridgeCall>();
  private turn: BridgedTurn = newBridgedTurn();
  private waiter: TurnWaiter | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private stdoutBuf = "";
  private stderrBuf = "";
  private sawResult = false;
  private resultError: string | undefined;
  private resultStopReason: NativeRuntimeResult["stopReason"] = "end_turn";
  private resultUsage: Usage | undefined;
  private reportedUsage = false;
  private exitCode: number | null = null;
  private spawnError: Error | undefined;
  private syntheticIds = 0;

  constructor(
    private readonly proc: ChildProcess,
    private readonly bridge: ClaudeToolBridge,
    private readonly hooks: {
      timeoutMs: number;
      onSessionId: (id: string) => void;
      onModel: (model: string) => void;
      clearSession: () => void;
    },
  ) {
    proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => { this.stderrBuf += chunk.toString("utf-8"); });
    proc.on("error", (err) => this.onExit(null, err));
    proc.on("close", (code) => this.onExit(typeof code === "number" ? code : null));
    bridge.onCall((call, respond) => this.onCall(call, respond));
    // Claude Code may still be blocked on a call when the host exits (the loop
    // ends on `done` without answering it); never leave it running.
    process.once("exit", this.killOnHostExit);
  }

  private readonly killOnHostExit = (): void => {
    const pid = this.proc.pid;
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else this.proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  };

  /**
   * Keep the host alive only while a turn is being awaited. Between turns the
   * loop is executing tools, and after its last turn nothing will answer the
   * calls Claude Code is blocked on.
   */
  private setHeld(held: boolean): void {
    const handles = [this.proc, this.proc.stdout, this.proc.stderr] as Array<{ ref?: () => void; unref?: () => void } | null | undefined>;
    for (const handle of handles) { if (held) handle?.ref?.(); else handle?.unref?.(); }
    this.bridge.setHeld(held);
  }

  /**
   * True when `reply` continues this process: it answers at least one call
   * handed out on the previous turn. A reply with no such result is a new
   * conversation step (e.g. a fresh task) and must not be fed to the calls.
   */
  canAccept(reply: NativeMessage): boolean {
    if (this.exited || this.outstanding.size === 0) return false;
    return reply.content.some(block => block.type === "tool_result" && this.outstanding.has(block.tool_use_id));
  }

  /**
   * Release every blocked call. Calls the loop answered get its result; a call
   * it did not answer (it skipped or deduplicated it) gets an error result
   * rather than leaving Claude Code waiting. Free text rides on the last result.
   */
  deliver(reply: NativeMessage): void {
    const answered = new Map(reply.content.flatMap(block =>
      block.type === "tool_result" && this.outstanding.has(block.tool_use_id) ? [[block.tool_use_id, block] as const] : []));
    const note = reply.content.flatMap(block => block.type === "text" && block.text.trim() ? [block.text.trim()] : []).join("\n");
    const ids = [...this.outstanding];
    ids.forEach((id, index) => {
      const block = answered.get(id);
      const base = block ? block.content : "The host did not execute this tool call.";
      const content = note && index === ids.length - 1 ? `${base}\n\n${note}` : base;
      const result: ClaudeToolBridgeResult = { content, ...(!block || block.is_error ? { isError: true } : {}) };
      this.outstanding.delete(id);
      const respond = this.waiting.get(id);
      if (respond) {
        this.waiting.delete(id);
        respond(result);
      } else {
        this.early.set(id, result);
      }
    });
  }

  /** Wait until Claude Code is blocked on new tool calls or has finished. */
  nextTurn(callbacks: NativeStreamCallbacks | undefined, signal: AbortSignal | undefined, start: number): Promise<NativeRuntimeResult> {
    if (this.exited) return Promise.resolve(this.finalResult(start, signal, false));
    this.setHeld(true);
    return new Promise((resolve) => {
      const waiter: TurnWaiter = {
        resolve,
        start,
        signal,
        callbacks,
        timedOut: false,
        onAbort: () => this.terminate(),
        timer: setTimeout(() => { waiter.timedOut = true; this.terminate(); }, this.hooks.timeoutMs),
      };
      this.waiter = waiter;
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
      this.maybeFinishBatch();
    });
  }

  dispose(): void {
    if (!this.exited) this.terminate();
    void this.bridge.close();
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf-8");
    let nl = this.stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      nl = this.stdoutBuf.indexOf("\n");
      if (!line) continue;
      const event = tryParseJson(line);
      if (!event) continue;
      if (typeof event.session_id === "string") this.hooks.onSessionId(event.session_id);
      if (event.type === "assistant" && event.message && Array.isArray(event.message.content) && !event.error) {
        for (const block of event.message.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            this.turn.content.push({ type: "text", text: block.text });
            if (block.text.trim()) this.waiter?.callbacks?.onThinking?.(block.text);
          } else if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            // Only bridged tools are the loop's to execute; with built-ins
            // disabled nothing else should appear.
            const name = nativeToolNameFromClaude(block.name);
            if (!name) continue;
            const toolUse: ToolUseBlock = {
              type: "tool_use",
              id: block.id,
              name,
              input: block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {},
            };
            this.seen.set(toolUse.id, toolUse);
            this.turn.content.push(toolUse);
          }
        }
        const u = event.message.usage as Record<string, unknown> | undefined;
        const usage = u ? readUsage(u) : undefined;
        if (usage) {
          const key = typeof event.message.id === "string" ? event.message.id : `message-${this.turn.usageByMessage.size}`;
          this.turn.usageByMessage.set(key, usage);
          const total = sumUsage(this.turn.usageByMessage);
          if (total) this.waiter?.callbacks?.onUsage?.(total);
        }
      }
      if (typeof event.message?.model === "string") this.hooks.onModel(event.message.model);
      if (event.type === "result") {
        this.sawResult = true;
        if (event.is_error) this.resultError = String(event.result || "Claude Code returned an error result.");
        this.resultStopReason = mapClaudeStopReason(event.stop_reason ?? event.subtype);
        const u = event.usage as Record<string, unknown> | undefined;
        if (u) this.resultUsage = readUsage(u) ?? this.resultUsage;
      }
    }
    this.maybeFinishBatch();
  }

  private onCall(call: ClaudeToolBridgeCall, respond: (result: ClaudeToolBridgeResult) => void): void {
    const id = call.toolUseId ?? this.matchCall(call);
    this.called.add(id);
    this.callInfo.set(id, call);
    const early = this.early.get(id);
    if (early) {
      this.early.delete(id);
      respond(early);
      return;
    }
    this.waiting.set(id, respond);
    this.maybeFinishBatch();
  }

  /** Pair a call without `_meta` tool_use id with an uncalled stdout block of the same tool. */
  private matchCall(call: ClaudeToolBridgeCall): string {
    const candidates = [...this.seen.values()].filter(block => block.name === call.name && !this.called.has(block.id));
    const input = JSON.stringify(call.input);
    const match = candidates.find(block => JSON.stringify(block.input) === input) ?? candidates[0];
    if (match) return match.id;
    const toolUse: ToolUseBlock = { type: "tool_use", id: `bridge_call_${++this.syntheticIds}`, name: call.name, input: call.input };
    this.seen.set(toolUse.id, toolUse);
    this.turn.content.push(toolUse);
    return toolUse.id;
  }

  /** Hand a batch to the loop once new calls are blocked and stdout has caught up with them. */
  private maybeFinishBatch(): void {
    if (!this.waiter || this.exited) return;
    const fresh = [...this.waiting.keys()].filter(id => !this.outstanding.has(id));
    if (fresh.length === 0) return;
    clearTimeout(this.settleTimer);
    if (fresh.every(id => this.seen.has(id))) {
      this.settleTimer = setTimeout(() => this.finishBatch(), TOOL_BATCH_SETTLE_MS);
      return;
    }
    // A call whose tool_use block never shows up on stdout must not stall the
    // turn: after a grace period, describe it from the call itself.
    this.settleTimer = setTimeout(() => {
      for (const id of fresh) {
        const call = this.callInfo.get(id);
        if (this.seen.has(id) || !call) continue;
        const toolUse: ToolUseBlock = { type: "tool_use", id, name: call.name, input: call.input };
        this.seen.set(id, toolUse);
        this.turn.content.push(toolUse);
      }
      this.finishBatch();
    }, STDOUT_CATCH_UP_MS);
  }

  private finishBatch(): void {
    const waiter = this.waiter;
    if (!waiter || this.exited) return;
    const content = this.turn.content;
    const handed = new Set(content.flatMap(block => block.type === "tool_use" ? [block.id] : []));
    for (const id of this.waiting.keys()) {
      if (!this.outstanding.has(id) && !handed.has(id)) {
        const block = this.seen.get(id);
        if (block) { content.push(block); handed.add(id); }
      }
    }
    if (handed.size === 0) return;
    for (const id of handed) this.outstanding.add(id);
    const usage = sumUsage(this.turn.usageByMessage);
    if (usage) this.reportedUsage = true;
    this.turn = newBridgedTurn();
    this.settle(waiter, { content, stopReason: "tool_use", ...(usage ? { usage } : {}), durationMs: Date.now() - waiter.start });
  }

  private settle(waiter: TurnWaiter, result: NativeRuntimeResult): void {
    if (this.waiter !== waiter) return;
    this.waiter = undefined;
    clearTimeout(waiter.timer);
    clearTimeout(this.settleTimer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    // Handing a batch to the loop: Claude Code now waits on the bridge, and
    // must not pin the host if the loop never comes back (e.g. after `done`).
    if (!this.exited) this.setHeld(false);
    waiter.resolve(result);
  }

  private terminate(): void {
    const proc = this.proc;
    if (proc.pid && process.platform !== "win32") {
      try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
    } else proc.kill("SIGTERM");
    this.killTimer ??= setTimeout(() => {
      if (proc.pid && process.platform !== "win32") {
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      } else proc.kill("SIGKILL");
    }, 1_000);
  }

  private onExit(code: number | null, err?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.spawnError = err;
    clearTimeout(this.killTimer);
    clearTimeout(this.settleTimer);
    process.off("exit", this.killOnHostExit);
    void this.bridge.close();
    const waiter = this.waiter;
    if (waiter) this.settle(waiter, this.finalResult(waiter.start, waiter.signal, waiter.timedOut));
  }

  /** Mirrors the single-shot path's exit handling for the turn that saw the process end. */
  private finalResult(start: number, signal: AbortSignal | undefined, timedOut: boolean): NativeRuntimeResult {
    const durationMs = Date.now() - start;
    const content = this.turn.content;
    const turnUsage = sumUsage(this.turn.usageByMessage);
    const usage = turnUsage ?? (this.reportedUsage ? undefined : this.resultUsage);
    if (this.spawnError) {
      this.hooks.clearSession();
      return { content: [{ type: "text", text: "" }], stopReason: "error", durationMs, error: `claude CLI spawn failed: ${this.spawnError.message}` };
    }
    if (signal?.aborted) {
      this.hooks.clearSession();
      return { content, stopReason: "error", usage, durationMs, cancelled: true, error: "CLI execution cancelled." };
    }
    if (timedOut) {
      this.hooks.clearSession();
      return {
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
        stopReason: "error",
        usage,
        durationMs,
        error: `claude CLI timed out after ${this.hooks.timeoutMs}ms`,
      };
    }
    if ((this.exitCode !== 0 && (!this.sawResult || this.resultError !== undefined)) || (this.exitCode === 0 && !this.sawResult && this.outstanding.size > 0)) {
      const hint = extractAuthHint(`${this.stderrBuf}\n${this.resultError ?? ""}`) ?? this.resultError;
      this.hooks.clearSession();
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        usage,
        durationMs,
        error:
          `claude CLI exited ${this.exitCode}` +
          (hint ? ` — ${hint}` : "") +
          (this.stderrBuf.trim() ? `\nstderr: ${this.stderrBuf.trim().slice(0, 500)}` : ""),
      };
    }
    return {
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      stopReason: this.resultStopReason === "tool_use" ? "end_turn" : this.resultStopReason,
      usage,
      durationMs,
    };
  }
}

function newBridgedTurn(): BridgedTurn {
  return { content: [], usageByMessage: new Map() };
}

function sumUsage(byMessage: Map<string, Usage>): Usage | undefined {
  if (byMessage.size === 0) return undefined;
  const total: Usage = { inputTokens: 0, outputTokens: 0 };
  for (const usage of byMessage.values()) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    if (usage.cachedInputTokens !== undefined) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    if (usage.cacheWriteTokens !== undefined) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
  }
  return total;
}

/**
 * Merge the user messages that follow the last assistant message into one
 * turn. The native loop appends tool results and then, separately, notes such
 * as re-injected loot or loop-detection nudges; all of them answer the same
 * assistant turn.
 */
function trailingUserTurn(messages: NativeMessage[]): NativeMessage | undefined {
  const content: NativeContentBlock[] = [];
  let i = messages.length - 1;
  while (i >= 0 && messages[i]!.role === "user") i--;
  for (const message of messages.slice(i + 1)) content.push(...message.content);
  return content.length > 0 ? { role: "user", content } : undefined;
}

/**
 * Build the prompt string for a single `claude -p ...` invocation from
 * the last user turn in the native-loop conversation.
 *
 * Claude Code expects a flat string. `tool_result` blocks are
 * serialized as a JSON array prefixed with a marker so Claude Code
 * recognises them as previous-turn outputs. Any free-form text in the
 * same user turn is appended verbatim.
 *
 * Exported for unit testing.
 */
export function buildClaudePromptFromLastUser(messages: NativeMessage[]): string {
  // Walk backwards to find the most recent user message.
  let last: NativeMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      last = messages[i];
      break;
    }
  }
  if (!last) return "";

  const toolResults: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }> = [];
  const textParts: string[] = [];

  for (const block of last.content) {
    if (block.type === "tool_result") {
      toolResults.push({
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      });
    } else if (block.type === "text") {
      textParts.push(block.text);
    }
  }

  const parts: string[] = [];
  if (toolResults.length > 0) {
    parts.push(
      `[0:tool_results]\n${JSON.stringify(toolResults, null, 2)}`,
    );
  }
  if (textParts.length > 0) {
    parts.push(textParts.join("\n").trim());
  }
  return parts.filter((p) => p.length > 0).join("\n\n").trim();
}

/**
 * Map Claude Code's stop-reason vocabulary to the native runtime's
 * normalized set. Both the Anthropic Messages API and Claude Code
 * stream-json use the same string constants for the common cases, but
 * the `result` event sometimes only sets `subtype` (e.g.
 * "success_max_turns") so we accept either.
 *
 * Exported for unit testing.
 */
export function mapClaudeStopReason(
  raw: string | undefined,
): NativeRuntimeResult["stopReason"] {
  if (!raw) return "end_turn";
  switch (raw) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "success_max_turns":
      return "max_tokens";
    case "end_turn":
    case "success":
    case "stop_sequence":
      return "end_turn";
    case "error":
    case "error_max_turns":
    case "error_during_execution":
      return "error";
    default:
      return "end_turn";
  }
}

function tryParseJson(line: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, any>;
    }
  } catch {
    // not all stdout lines are stream-json events (e.g. log lines from
    // npm wrappers); ignore and move on.
  }
  return null;
}

function readUsage(
  u: Record<string, unknown>,
): NativeRuntimeResult["usage"] {
  const input = num(u.input_tokens) ?? num(u.prompt_tokens);
  const output = num(u.output_tokens) ?? num(u.completion_tokens);
  if (input === undefined && output === undefined && num(u.cache_read_input_tokens) === undefined && num(u.cache_creation_input_tokens) === undefined) return undefined;
  if (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
    return readCacheUsage({ ...u, input_tokens: input ?? 0, output_tokens: output ?? 0 });
  }
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function extractAuthHint(stderr: string): string | undefined {
  if (!stderr) return undefined;
  if (/please\s+run\s+claude\s+login/i.test(stderr)) {
    return "run `claude login` to authenticate the CLI with your subscription";
  }
  if (/not\s+(?:logged|authenticated)/i.test(stderr)) {
    return "Claude Code reports the user is not authenticated — run `claude login`";
  }
  if (/session\s+expired/i.test(stderr)) {
    return "Claude Code session expired — run `claude login` again";
  }
  return undefined;
}
