import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process.spawn before importing the module under test so the
// hoisted import inside cli-native.ts picks up the mock.
const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
  CliNativeRuntime,
  buildClaudePromptFromLastUser,
  mapClaudeStopReason,
} from "./cli-native.js";
import type { NativeMessage, NativeToolDef } from "./types.js";

/**
 * Build a fake `claude` subprocess that:
 *   - emits the canned stream-json lines on stdout
 *   - closes with the given exit code
 *
 * Returns a tuple of the fake child and a function to fire the events,
 * so tests can control the timing of the close event.
 */
function makeFakeChild(opts: {
  stdoutLines: string[];
  stderr?: string;
  exitCode?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  // Fire data + close on the next microtask so the runtime has time to
  // attach its listeners.
  Promise.resolve().then(() => {
    for (const line of opts.stdoutLines) {
      child.stdout.emit("data", Buffer.from(line + "\n", "utf-8"));
    }
    if (opts.stderr) {
      child.stderr.emit("data", Buffer.from(opts.stderr, "utf-8"));
    }
    child.emit("close", opts.exitCode ?? 0);
  });

  return child;
}

describe("buildClaudePromptFromLastUser", () => {
  it("returns empty string when no user message exists", () => {
    expect(buildClaudePromptFromLastUser([])).toBe("");
  });

  it("returns plain text when last user message is just text", () => {
    const messages: NativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    expect(buildClaudePromptFromLastUser(messages)).toBe("hello");
  });

  it("serializes tool_results as JSON with a marker", () => {
    const messages: NativeMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "http_request", input: { url: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "200 OK" },
        ],
      },
    ];
    const prompt = buildClaudePromptFromLastUser(messages);
    expect(prompt).toContain("[0:tool_results]");
    expect(prompt).toContain('"tool_use_id": "tu_1"');
    expect(prompt).toContain('"content": "200 OK"');
  });

  it("uses the LAST user message, not the first", () => {
    const messages: NativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ];
    expect(buildClaudePromptFromLastUser(messages)).toBe("second");
  });

  it("merges tool_result + free text in the same user turn", () => {
    const messages: NativeMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_x", content: "ok", is_error: true },
          { type: "text", text: "Now what?" },
        ],
      },
    ];
    const prompt = buildClaudePromptFromLastUser(messages);
    expect(prompt).toContain("[0:tool_results]");
    expect(prompt).toContain('"is_error": true');
    expect(prompt).toContain("Now what?");
  });
});

describe("mapClaudeStopReason", () => {
  it("maps tool_use", () => {
    expect(mapClaudeStopReason("tool_use")).toBe("tool_use");
  });
  it("maps end_turn / success / stop_sequence", () => {
    expect(mapClaudeStopReason("end_turn")).toBe("end_turn");
    expect(mapClaudeStopReason("success")).toBe("end_turn");
    expect(mapClaudeStopReason("stop_sequence")).toBe("end_turn");
  });
  it("maps max_tokens variants", () => {
    expect(mapClaudeStopReason("max_tokens")).toBe("max_tokens");
    expect(mapClaudeStopReason("success_max_turns")).toBe("max_tokens");
  });
  it("maps error variants", () => {
    expect(mapClaudeStopReason("error")).toBe("error");
    expect(mapClaudeStopReason("error_max_turns")).toBe("error");
    expect(mapClaudeStopReason("error_during_execution")).toBe("error");
  });
  it("falls back to end_turn for unknown / undefined", () => {
    expect(mapClaudeStopReason(undefined)).toBe("end_turn");
    expect(mapClaudeStopReason("brand_new_reason")).toBe("end_turn");
  });
});

describe("CliNativeRuntime — claude subscription mode", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects type=api at construction time", () => {
    expect(
      () =>
        new CliNativeRuntime({
          type: "api" as any,
          timeout: 1000,
        }),
    ).toThrow(/CliNativeRuntime/);
  });

  it("returns a clear error for codex / gemini (no native multi-turn yet)", async () => {
    const rt = new CliNativeRuntime({ type: "codex", timeout: 1000 });
    const result = await rt.executeNative(
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("only supported for the 'claude' CLI runtime");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("turn 1: spawns claude with -p, --output-format stream-json, and --system-prompt", async () => {
    const sessionId = "session-abc-123";
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: sessionId,
          }),
          JSON.stringify({
            type: "assistant",
            session_id: sessionId,
            message: {
              content: [
                { type: "text", text: "I'll probe the target." },
                {
                  type: "tool_use",
                  id: "tu_1",
                  name: "http_request",
                  input: { url: "https://example.com" },
                },
              ],
              usage: { input_tokens: 100, output_tokens: 25 },
            },
          }),
          JSON.stringify({
            type: "result",
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 25 },
          }),
        ],
        exitCode: 0,
      }),
    );

    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const result = await rt.executeNative(
      "you are 0 attack agent",
      [{ role: "user", content: [{ type: "text", text: "scan https://x" }] }],
      [],
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    // Turn 1 must NOT have --resume
    expect(args).not.toContain("--resume");
    // Turn 1 SHOULD pass the system prompt
    const sysIdx = args.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    expect(args[sysIdx + 1]).toBe("you are 0 attack agent");

    // Result blocks
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "text", text: "I'll probe the target." },
      {
        type: "tool_use",
        id: "tu_1",
        name: "http_request",
        input: { url: "https://example.com" },
      },
    ]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 25 });
  });

  it("turn N: spawns claude with --resume <session_id> and JSON-encoded tool_results", async () => {
    const sessionId = "session-xyz-789";

    // Turn 1 — capture session id from system event.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: sessionId,
          }),
          JSON.stringify({
            type: "assistant",
            session_id: sessionId,
            message: {
              content: [
                { type: "tool_use", id: "tu_a", name: "http_request", input: { url: "https://x" } },
              ],
              usage: { input_tokens: 50, output_tokens: 10 },
            },
          }),
          JSON.stringify({ type: "result", stop_reason: "tool_use" }),
        ],
        exitCode: 0,
      }),
    );

    // Turn 2 — should --resume.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: "assistant",
            session_id: sessionId,
            message: {
              content: [{ type: "text", text: "Got the response, finishing up." }],
              usage: { input_tokens: 60, output_tokens: 8 },
            },
          }),
          JSON.stringify({ type: "result", stop_reason: "end_turn" }),
        ],
        exitCode: 0,
      }),
    );

    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });

    // Turn 1
    await rt.executeNative(
      "system prompt",
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      [],
    );

    // Turn 2 — feed back the tool_result for tu_a.
    const result2 = await rt.executeNative(
      "system prompt",
      [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_a", name: "http_request", input: { url: "https://x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_a", content: '{"status":200}' },
          ],
        },
      ],
      [],
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd2, args2] = spawnMock.mock.calls[1]!;
    expect(cmd2).toBe("claude");
    const resumeIdx = args2.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args2[resumeIdx + 1]).toBe(sessionId);
    // System prompt must NOT be re-sent on resume — Claude Code retains it
    // server-side, and re-passing it would re-prepend on every turn.
    expect(args2).not.toContain("--system-prompt");
    // The prompt argument should carry the JSON-encoded tool_result.
    const pIdx = args2.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    const promptArg = args2[pIdx + 1] as string;
    expect(promptArg).toContain("[0:tool_results]");
    expect(promptArg).toContain('"tool_use_id": "tu_a"');
    expect(promptArg).toContain('"content": "{\\"status\\":200}"');

    expect(result2.stopReason).toBe("end_turn");
    expect(result2.content).toEqual([
      { type: "text", text: "Got the response, finishing up." },
    ]);
  });

  it("surfaces a helpful auth hint when claude exits non-zero with login error", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [],
        stderr: "Error: Please run claude login\n",
        exitCode: 1,
      }),
    );

    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const result = await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/claude login/i);
  });

  it("surfaces the auth hint when claude prints a not-logged-in error result on stdout", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: "assistant", error: "authentication_failed", message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } }),
          JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
        ],
        exitCode: 1,
      }),
    );

    const onThinking = vi.fn();
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const result = await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
      { onThinking },
    );
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/not authenticated/i);
    expect(result.content).toEqual([{ type: "text", text: "" }]);
    expect(onThinking).not.toHaveBeenCalled();
  });

  it("reports an error result that follows model text as a failed turn", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Checking the target." }] } }),
          JSON.stringify({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your usage limit" }] } }),
          JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your usage limit" }),
        ],
        exitCode: 1,
      }),
    );

    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const result = await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );
    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("claude CLI exited 1 — You've hit your usage limit");
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  it("names a generic cause when an error result has no text", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [JSON.stringify({ type: "result", subtype: "success", is_error: true })],
        exitCode: 1,
      }),
    );

    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const result = await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );
    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("claude CLI exited 1 — Claude Code returned an error result.");
  });

  it("forwards onThinking and onUsage callbacks", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
          JSON.stringify({
            type: "assistant",
            session_id: "s1",
            message: {
              content: [{ type: "text", text: "thinking..." }],
              usage: { input_tokens: 7, output_tokens: 3 },
            },
          }),
          JSON.stringify({ type: "result", stop_reason: "end_turn" }),
        ],
        exitCode: 0,
      }),
    );

    const onThinking = vi.fn();
    const onUsage = vi.fn();
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      [],
      { onThinking, onUsage },
    );

    expect(onThinking).toHaveBeenCalledWith("thinking...");
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 7, outputTokens: 3 });
  });

  it("auto-clears cached session id when a resume turn exits non-zero (no infinite stale-resume loop)", async () => {
    // Turn 1 — establishes a session id.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "stale-id" }),
          JSON.stringify({
            type: "assistant",
            session_id: "stale-id",
            message: {
              content: [{ type: "tool_use", id: "tu_a", name: "http_request", input: {} }],
            },
          }),
          JSON.stringify({ type: "result", stop_reason: "tool_use" }),
        ],
        exitCode: 0,
      }),
    );
    // Turn 2 — `--resume stale-id` fails because Claude Code lost the
    // session server-side. CliNativeRuntime must drop the cached id.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [],
        stderr: "Error: session not found\n",
        exitCode: 1,
      }),
    );
    // Turn 3 — should NOT re-send `--resume stale-id`; it should start
    // a fresh session with `--system-prompt` instead.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "fresh-id" }),
          JSON.stringify({ type: "result", stop_reason: "end_turn" }),
        ],
        exitCode: 0,
      }),
    );

    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      [],
    );
    const r2 = await rt.executeNative(
      "sys",
      [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_a", name: "http_request", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_a", content: "200" }],
        },
      ],
      [],
    );
    expect(r2.stopReason).toBe("error");

    await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "retry" }] }],
      [],
    );

    expect(spawnMock).toHaveBeenCalledTimes(3);
    const args3 = spawnMock.mock.calls[2]![1] as string[];
    // After the failed resume, the next call must start fresh, not
    // replay `--resume stale-id`.
    expect(args3).not.toContain("--resume");
    expect(args3).toContain("--system-prompt");
  });

  it("resetSession() clears the cached session id so the next turn starts fresh", async () => {
    spawnMock.mockImplementation(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "fresh" }),
          JSON.stringify({ type: "result", stop_reason: "end_turn" }),
        ],
        exitCode: 0,
      }),
    );

    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "first" }] }],
      [],
    );
    rt.resetSession();
    await rt.executeNative(
      "sys",
      [{ role: "user", content: [{ type: "text", text: "second" }] }],
      [],
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    // After reset, the second call should NOT carry --resume.
    const args2 = spawnMock.mock.calls[1]![1] as string[];
    expect(args2).not.toContain("--resume");
  });
});

// ── Native tools through the Claude tool bridge ─────────────────────────


const bridgedTools: NativeToolDef[] = [
  {
    name: "http_request",
    description: "Send an HTTP request to the target.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "save_finding",
    description: "Persist a confirmed finding.",
    input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
];

/** A fake `claude` process the test drives event by event. */
function makeLiveChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    line: (event: Record<string, unknown>) => void;
    exit: (code?: number) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let closed = false;
  child.exit = (code = 0) => { if (!closed) { closed = true; child.emit("close", code); } };
  child.kill = vi.fn(() => { queueMicrotask(() => child.exit(143)); });
  (child as any).ref = vi.fn();
  (child as any).unref = vi.fn();
  child.line = (event) => child.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n", "utf-8"));
  return child;
}

function bridgeEndpoint(args: string[]): { url: string; headers: Record<string, string> } {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
  return config.mcpServers.zero;
}

/** Act as Claude Code's MCP client: issue one tools/call and wait for its result. */
async function bridgeCall(
  endpoint: { url: string; headers: Record<string, string> },
  name: string,
  input: Record<string, unknown>,
  toolUseId?: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...endpoint.headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: input, ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}) },
    }),
  });
  const text = await response.text();
  const data = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice("data: ".length))).find(message => message.id === 1);
  return data.result;
}

function assistant(messageId: string, content: unknown[], usage = { input_tokens: 10, output_tokens: 2 }) {
  return { type: "assistant", session_id: "s-live", message: { id: messageId, model: "claude-test", content, usage } };
}

describe("CliNativeRuntime — native tools through the Claude tool bridge", () => {
  beforeEach(() => { spawnMock.mockReset(); });

  it("exposes only the loop's tools and returns a blocked call as a tool_use turn", async () => {
    const child = makeLiveChild();
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });

    const turn1 = rt.executeNative("you are 0", [{ role: "user", content: [{ type: "text", text: "scan" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__zero");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("you are 0");
    expect(args).not.toContain("--resume");

    const endpoint = bridgeEndpoint(args);
    const listed = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...endpoint.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }).then(r => r.json());
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["http_request", "save_finding"]);

    child.line({ type: "system", subtype: "init", session_id: "s-live" });
    child.line(assistant("m1", [
      { type: "text", text: "Probing the parameter." },
      { type: "tool_use", id: "toolu_1", name: "mcp__zero__http_request", input: { url: "https://t.test/?q=1" } },
    ], { input_tokens: 100, output_tokens: 20 }));
    const call = bridgeCall(endpoint, "http_request", { url: "https://t.test/?q=1" }, "toolu_1");

    const result1 = await turn1;
    expect(result1.stopReason).toBe("tool_use");
    expect(result1.content).toEqual([
      { type: "text", text: "Probing the parameter." },
      { type: "tool_use", id: "toolu_1", name: "http_request", input: { url: "https://t.test/?q=1" } },
    ]);
    expect(result1.usage).toEqual({ inputTokens: 100, outputTokens: 20 });

    // Turn 2: the loop executed the tool; its result must reach the waiting call
    // in the SAME process — no --resume spawn.
    const turn2 = rt.executeNative("you are 0", [
      { role: "user", content: [{ type: "text", text: "scan" }] },
      { role: "assistant", content: result1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: '{"status":200}' },
        { type: "text", text: "3 turns left." },
      ] },
    ], bridgedTools);
    const delivered = await call;
    expect(delivered).toEqual({ content: [{ type: "text", text: '{"status":200}\n\n3 turns left.' }] });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    child.line(assistant("m2", [{ type: "text", text: "Done." }], { input_tokens: 130, output_tokens: 4 }));
    child.line({ type: "result", subtype: "success", stop_reason: "end_turn", usage: { input_tokens: 230, output_tokens: 24 } });
    child.exit(0);

    const result2 = await turn2;
    expect(result2.stopReason).toBe("end_turn");
    expect(result2.content).toEqual([{ type: "text", text: "Done." }]);
    // Only this turn's API message — never Claude Code's cumulative total, which would double count.
    expect(result2.usage).toEqual({ inputTokens: 130, outputTokens: 4 });
  });

  it("hands parallel tool_use blocks over together and releases serial calls from early results", async () => {
    const child = makeLiveChild();
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });

    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);

    child.line(assistant("m1", [
      { type: "tool_use", id: "toolu_a", name: "mcp__zero__http_request", input: { url: "https://a" } },
      { type: "tool_use", id: "toolu_b", name: "mcp__zero__save_finding", input: { title: "XSS" } },
    ]));
    // Claude Code runs non-read-only MCP tools one at a time: only the first call arrives.
    const callA = bridgeCall(endpoint, "http_request", { url: "https://a" }, "toolu_a");

    const result1 = await turn1;
    expect(result1.content.filter(block => block.type === "tool_use").map(block => (block as { id: string }).id)).toEqual(["toolu_a", "toolu_b"]);

    const turn2 = rt.executeNative("sys", [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "A" },
        { type: "tool_result", tool_use_id: "toolu_b", content: "saved", is_error: false },
      ] },
    ], bridgedTools);
    expect((await callA).content[0]!.text).toBe("A");
    // The second call is answered immediately from the loop's earlier result.
    expect((await bridgeCall(endpoint, "save_finding", { title: "XSS" }, "toolu_b")).content[0]!.text).toBe("saved");

    child.line(assistant("m2", [{ type: "text", text: "Finished." }]));
    child.line({ type: "result", subtype: "success" });
    child.exit(0);
    const result2 = await turn2;
    expect(result2.stopReason).toBe("end_turn");
    expect(result2.content).toEqual([{ type: "text", text: "Finished." }]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("matches a call without a tool_use id to its stdout block by name and input", async () => {
    const child = makeLiveChild();
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);

    child.line(assistant("m1", [{ type: "tool_use", id: "toolu_x", name: "mcp__zero__http_request", input: { url: "https://x" } }]));
    const call = bridgeCall(endpoint, "http_request", { url: "https://x" });
    const result1 = await turn1;
    expect(result1.content).toEqual([{ type: "tool_use", id: "toolu_x", name: "http_request", input: { url: "https://x" } }]);

    const turn2 = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }] }], bridgedTools);
    expect((await call).content[0]!.text).toBe("ok");
    child.line({ type: "result", subtype: "success" });
    child.exit(0);
    await turn2;
  });

  it("discards the live process and resumes when the loop does not answer the handed-out calls", async () => {
    const live = makeLiveChild();
    const resumed = makeLiveChild();
    spawnMock.mockImplementationOnce(() => live).mockImplementationOnce(() => resumed);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });

    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    live.line({ type: "system", subtype: "init", session_id: "s-live" });
    live.line(assistant("m1", [{ type: "tool_use", id: "toolu_1", name: "mcp__zero__http_request", input: { url: "https://x" } }]));
    void bridgeCall(endpoint, "http_request", { url: "https://x" }, "toolu_1").catch(() => undefined);
    await turn1;

    const turn2 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "Stop and summarise." }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    expect(live.kill).toHaveBeenCalled();
    const args2 = spawnMock.mock.calls[1]![1] as string[];
    expect(args2[args2.indexOf("--resume") + 1]).toBe("s-live");
    expect(args2).not.toContain("--system-prompt");
    resumed.line(assistant("m9", [{ type: "text", text: "Summary." }]));
    resumed.line({ type: "result", subtype: "success" });
    resumed.exit(0);
    expect((await turn2).content).toEqual([{ type: "text", text: "Summary." }]);
  });

  it("runs a tool-less call as an isolated one-off while a bridged process is waiting", async () => {
    const live = makeLiveChild();
    spawnMock.mockImplementationOnce(() => live).mockImplementationOnce(() =>
      makeFakeChild({ stdoutLines: [JSON.stringify({ type: "result", result: "summary", stop_reason: "end_turn" })], exitCode: 0 }),
    );
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    live.line({ type: "system", subtype: "init", session_id: "s-live" });
    live.line(assistant("m1", [{ type: "tool_use", id: "toolu_1", name: "mcp__zero__http_request", input: { url: "https://x" } }]));
    const call = bridgeCall(endpoint, "http_request", { url: "https://x" }, "toolu_1");
    await turn1;

    await rt.executeNative("summarise", [{ role: "user", content: [{ type: "text", text: "summarise" }] }], []);
    const summaryArgs = spawnMock.mock.calls[1]![1] as string[];
    expect(summaryArgs).not.toContain("--resume");
    expect(live.kill).not.toHaveBeenCalled();

    // The live process still accepts the pending result afterwards.
    const turn2 = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }], bridgedTools);
    expect((await call).content[0]!.text).toBe("ok");
    live.line({ type: "result", subtype: "success" });
    live.exit(0);
    await turn2;
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the process when the loop follows its tool results with a separate note message", async () => {
    const child = makeLiveChild();
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("m1", [{ type: "tool_use", id: "toolu_1", name: "mcp__zero__http_request", input: { url: "https://x" } }]));
    const call = bridgeCall(endpoint, "http_request", { url: "https://x" }, "toolu_1");
    const result1 = await turn1;

    // native-loop pushes re-injected loot (and nudges) as their own user message.
    const turn2 = rt.executeNative("sys", [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: result1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "R1" }] },
      { role: "user", content: [{ type: "text", text: "Known footholds: none" }] },
    ], bridgedTools);
    expect(await call).toEqual({ content: [{ type: "text", text: "R1\n\nKnown footholds: none" }] });
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.line({ type: "result", subtype: "success" });
    child.exit(0);
    await turn2;
  });

  it("answers a call the loop did not execute with an error instead of killing the process", async () => {
    const child = makeLiveChild();
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("m1", [
      { type: "tool_use", id: "toolu_a", name: "mcp__zero__http_request", input: { url: "https://a" } },
      { type: "tool_use", id: "toolu_b", name: "mcp__zero__http_request", input: { url: "https://a" } },
    ]));
    const callA = bridgeCall(endpoint, "http_request", { url: "https://a" }, "toolu_a");
    await turn1;

    const turn2 = rt.executeNative("sys", [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "A" }] },
      { role: "user", content: [{ type: "text", text: "Repeated call skipped." }] },
    ], bridgedTools);
    expect((await callA).content[0]!.text).toBe("A");
    const callB = await bridgeCall(endpoint, "http_request", { url: "https://a" }, "toolu_b");
    expect(callB).toEqual({
      content: [{ type: "text", text: "The host did not execute this tool call.\n\nRepeated call skipped." }],
      isError: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
    child.line({ type: "result", subtype: "success" });
    child.exit(0);
    await turn2;
  });

  it("only holds the host process open while a turn is being awaited", async () => {
    const child = makeLiveChild() as ReturnType<typeof makeLiveChild> & { ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    expect(child.ref).toHaveBeenCalled();
    child.line(assistant("m1", [{ type: "tool_use", id: "toolu_1", name: "mcp__zero__save_finding", input: { title: "x" } }]));
    const call = bridgeCall(endpoint, "save_finding", { title: "x" }, "toolu_1");
    await turn1;
    // The loop now owns the turn; if it never returns (e.g. it ended on `done`),
    // the blocked Claude Code process must not keep the host alive.
    expect(child.unref).toHaveBeenCalledTimes(1);

    const refsBefore = child.ref.mock.calls.length;
    const turn2 = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "saved" }] }], bridgedTools);
    expect(child.ref.mock.calls.length).toBeGreaterThan(refsBefore);
    await call;
    child.line({ type: "result", subtype: "success" });
    child.exit(0);
    await turn2;
  });

  it("resetSession() terminates a live bridged process", async () => {
    const child = makeLiveChild();
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const turn1 = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("m1", [{ type: "tool_use", id: "toolu_1", name: "mcp__zero__http_request", input: { url: "https://x" } }]));
    void bridgeCall(endpoint, "http_request", { url: "https://x" }, "toolu_1").catch(() => undefined);
    await turn1;
    rt.resetSession();
    expect(child.kill).toHaveBeenCalled();
  });

  it("reports cancellation and stops the process when the signal aborts mid-turn", async () => {
    const child = makeLiveChild();
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const controller = new AbortController();
    const turn = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools, undefined, controller.signal);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await turn;
    expect(child.kill).toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(result.stopReason).toBe("error");
  });
  it("regression: refreshes tools supplied on a continuing live turn", async () => {
    const child = makeLiveChild(); spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const first = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("m1", [{ type: "tool_use", id: "one", name: "mcp__zero__http_request", input: {} }]));
    const call = bridgeCall(endpoint, "http_request", {}, "one"); await first;
    const second = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "ok" }] }], [...bridgedTools, { name: "new_tool", description: "new", input_schema: { type: "object", properties: {} } }]);
    await call;
    const response = await fetch(endpoint.url, { method: "POST", headers: { ...endpoint.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    const catalog = (await response.json() as any).result.tools.map((tool: any) => tool.name);
    expect(catalog).toContain("new_tool");
    child.line(assistant("m2", [{ type: "tool_use", id: "new-call", name: "mcp__zero__new_tool", input: {} }]));
    const fresh = bridgeCall(endpoint, "new_tool", {}, "new-call");
    expect((await second).content).toContainEqual({ type: "tool_use", id: "new-call", name: "new_tool", input: {} });
    const third = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "new-call", content: "fresh result" }] }], [...bridgedTools, { name: "new_tool", description: "new", input_schema: { type: "object", properties: {} } }]);
    expect((await fresh).content[0]!.text).toBe("fresh result");
    child.line({ type: "result", subtype: "success" }); child.exit(); await third;
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
  it("regression: does not count one assistant API message twice across host tool batches", async () => {
    const child = makeLiveChild(); spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const first = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("same-message", [{ type: "tool_use", id: "one", name: "mcp__zero__http_request", input: { url: "a" } }]));
    const a = bridgeCall(endpoint, "http_request", { url: "a" }, "one"); const result1 = await first;
    const second = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "ok" }] }], bridgedTools); await a;
    child.line(assistant("same-message", [{ type: "tool_use", id: "two", name: "mcp__zero__http_request", input: { url: "b" } }], { input_tokens: 10, output_tokens: 5 }));
    const b = bridgeCall(endpoint, "http_request", { url: "b" }, "two"); const result2 = await second;
    rt.resetSession(); await b;
    expect((result1.usage?.inputTokens ?? 0) + (result2.usage?.inputTokens ?? 0)).toBe(10);
    expect((result1.usage?.outputTokens ?? 0) + (result2.usage?.outputTokens ?? 0)).toBe(5);
  });

  it("regression: closes owned bridge/process when native loop completes on done", async () => {
    const { runNativeAgentLoop } = await import("../agent/native-loop.js");
    const { TOOL_DEFINITIONS } = await import("../agent/tools.js");
    vi.stubEnv("ZERO_FEATURE_HUNT_MEMORY", "0"); vi.stubEnv("ZERO_NO_TELEMETRY", "1");
    const child = makeLiveChild(); spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const statePromise = runNativeAgentLoop({ runtime: rt, config: { role: "attack", systemPrompt: "fixture", tools: [TOOL_DEFINITIONS.done!], target: "https://fixture.test", scanId: "review-cleanup-fixture", maxTurns: 1 } });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("done-message", [{ type: "tool_use", id: "done-one", name: "mcp__zero__done", input: { summary: "Finished" } }]));
    const held = bridgeCall(endpoint, "done", { summary: "Finished" }, "done-one");
    const state = await statePromise;
    const leaked = !child.kill.mock.calls.length;
    rt.resetSession(); await held;
    expect(state.done).toBe(true);
    expect(leaked).toBe(false);
  });

  it("awaits observed subprocess exit rather than treating a kill request as cleanup", async () => {
    const child = makeLiveChild(); child.kill.mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const first = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("m1", [{ type: "tool_use", id: "one", name: "mcp__zero__http_request", input: {} }]));
    const pendingCall = bridgeCall(endpoint, "http_request", {}, "one"); await first;
    let cleaned = false;
    const cleanup = rt.finishInvocation().then(() => { cleaned = true; });
    expect(child.kill).toHaveBeenCalled(); await Promise.resolve();
    expect(cleaned).toBe(false);
    child.exit(143); await cleanup; await pendingCall;
    expect(cleaned).toBe(true);
  });

  it("does not treat an operational child error as observed process exit", async () => {
    const child = makeLiveChild(); child.kill.mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const first = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("m1", [{ type: "tool_use", id: "one", name: "mcp__zero__http_request", input: {} }]));
    const pendingCall = bridgeCall(endpoint, "http_request", {}, "one"); await first;
    child.emit("error", Object.assign(new Error("kill denied"), { code: "EPERM", syscall: "kill" }));
    let cleaned = false; const cleanup = rt.finishInvocation().then(() => { cleaned = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cleaned).toBe(false);
    child.exit(143); await cleanup; await pendingCall;
    expect(cleaned).toBe(true);
  });

  it("retains an explicit terminal CLI error even when the process exits zero", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild({ stdoutLines: [JSON.stringify({ type: "result", is_error: true, result: "Explicit provider failure" })], exitCode: 0 }));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const result = await rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("Explicit provider failure");
  });

  it("waits for stdout before exposing an early metadata-less request, exactly once", async () => {
    const child = makeLiveChild(); spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    let handed = false;
    const first = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools).then(result => { handed = true; return result; });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    const call = bridgeCall(endpoint, "http_request", { url: "a" });
    await new Promise(resolve => setTimeout(resolve, 40)); expect(handed).toBe(false);
    const message = assistant("m1", [{ type: "tool_use", id: "actual-one", name: "mcp__zero__http_request", input: { url: "a" } }]);
    child.line(message); child.line(message);
    expect((await first).content.filter(block => block.type === "tool_use")).toEqual([{ type: "tool_use", id: "actual-one", name: "http_request", input: { url: "a" } }]);
    const second = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "actual-one", content: "executed once" }] }], bridgedTools);
    expect((await call).content[0]!.text).toBe("executed once");
    // A retransmission has no new authoritative stdout call and must not execute again.
    const retransmitted = bridgeCall(endpoint, "http_request", { url: "a" });
    const result = await second;
    expect(result.stopReason).toBe("error");
    expect(result.content.some(block => block.type === "tool_use")).toBe(false);
    expect((await retransmitted).isError).toBe(true);
  });
  it("fails closed on absent or ambiguous metadata-less correlation", async () => {
    for (const ambiguous of [false, true]) {
      const child = makeLiveChild(); spawnMock.mockImplementationOnce(() => child);
      const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
      const index = spawnMock.mock.calls.length;
      const first = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(index + 1));
      const endpoint = bridgeEndpoint(spawnMock.mock.calls[index]![1] as string[]);
      if (ambiguous) child.line(assistant("m1", [{ type: "tool_use", id: "a", name: "mcp__zero__http_request", input: {} }, { type: "tool_use", id: "b", name: "mcp__zero__http_request", input: {} }]));
      const call = bridgeCall(endpoint, "http_request", {});
      const result = await first;
      expect(result.stopReason).toBe("error");
      expect(result.content.some(block => block.type === "tool_use")).toBe(false);
      expect((await call).isError).toBe(true);
      await rt.finishInvocation();
    }
  });
  it("reconciles terminal cumulative usage when final assistant usage is missing", async () => {
    const child = makeLiveChild(); spawnMock.mockImplementationOnce(() => child);
    const rt = new CliNativeRuntime({ type: "claude", timeout: 5000 });
    const first = rt.executeNative("sys", [{ role: "user", content: [{ type: "text", text: "go" }] }], bridgedTools);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const endpoint = bridgeEndpoint(spawnMock.mock.calls[0]![1] as string[]);
    child.line(assistant("m1", [{ type: "tool_use", id: "one", name: "mcp__zero__http_request", input: {} }]));
    const call = bridgeCall(endpoint, "http_request", {}, "one"); const initial = await first;
    const second = rt.executeNative("sys", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "ok" }] }], bridgedTools); await call;
    child.line({ type: "result", subtype: "success", usage: { input_tokens: 30, output_tokens: 5 } }); child.exit();
    const final = await second;
    expect((initial.usage?.inputTokens ?? 0) + (final.usage?.inputTokens ?? 0)).toBe(30);
    expect((initial.usage?.outputTokens ?? 0) + (final.usage?.outputTokens ?? 0)).toBe(5);
  });

});
