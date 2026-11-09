import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { saveSession, loadSession, sessionsDir, type StoredSession } from "./session-store.js";
import { ConsoleGateway } from "../web/console-gateway.js";

const homes: string[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), "0-quarantine-bounds-")); homes.push(path); return path; };
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });
const quarantine = { reason: "Owned resource termination unconfirmed", recordedAt: "2026-11-09T20:00:00.000Z" };
const queuedMessages = [{ id: "paused-user-message", text: "Retain this paused operator request", createdAt: "2026-11-09T20:00:00.000Z" }];
const stagedPrompt = "Retain this staged finding context";
const configuration = { target: "/fixture", role: "audit", runtime: { providerId: "openai", model: "gpt-fixture", connectionIdentity: "a".repeat(64), cyberAccessProgram: "daybreak_blue" } };
function session(compaction: unknown): StoredSession {
  return { id: "console-quarantine-bounds", savedAt: 1, cwd: "/fixture", messageCount: 1, preview: "Retain evidence", messages: [{ role: "user", content: [{ type: "text", text: "Faithful native evidence" }] }],
    consoleState: { version: 1, configuration, title: "Original", objective: "", usage: { inputTokens: 7, outputTokens: 3 }, lastOutcome: null, todos: null, workers: [], queuedMessages, stagedPrompt, compaction, executionQuarantine: { ...quarantine } } } as StoredSession;
}
function display(kind: string): unknown {
  if (kind === "bytes") return Array(6).fill("x".repeat(800_000));
  if (kind === "nodes") return Array(100_001).fill(0);
  let value: unknown = 0; for (let i = 0; i < 30; i++) value = { nested: value }; return value;
}
function writeRaw(input: StoredSession, directory: string): void {
  mkdirSync(sessionsDir(directory), { recursive: true });
  writeFileSync(join(sessionsDir(directory), `${input.id}.json`), JSON.stringify(input));
}
it.each(["depth", "bytes", "nodes"])("retains protected state on load AND save despite %s display limits", kind => {
  const directory = home(), input = session(display(kind)); writeRaw(input, directory);
  const loaded = loadSession(input.id, directory)!;
  expect(loaded.messages).toEqual(input.messages);
  expect(loaded.consoleState).toMatchObject({ executionQuarantine: quarantine, configuration, queuedMessages, stagedPrompt });
  expect(saveSession(input, directory)).toBe(true);
  expect(loadSession(input.id, directory)).toMatchObject({ messages: input.messages, consoleState: { executionQuarantine: quarantine, configuration, queuedMessages, stagedPrompt } });
  // Oversized display was never a reason to reject the faithful transcript.
  expect(loadSession(input.id, directory)?.consoleState?.compaction).toBeNull();
});
it.each(["depth", "bytes"])("cannot execute a resumed chat after %s display recovery", async kind => {
  const directory = home(), input = session(display(kind)); writeRaw(input, directory);
  const factory = vi.fn(); const gateway = new ConsoleGateway({ homeDir: directory, projectPath: "/fixture", createSession: factory });
  try {
    const resumed = await gateway.resume(input.id); expect(resumed.status).toBe("cancelling");
    await expect(gateway.send(resumed.id, "Do not bypass owned resource quarantine")).rejects.toThrow("unconfirmed");
    expect(factory).not.toHaveBeenCalled();
    expect(gateway.get(resumed.id).queuedMessages).toEqual(queuedMessages);
    expect(loadSession(input.id, directory)?.consoleState?.configuration).toEqual(configuration);
  } finally { await gateway.closeAll(); }
});
it("does not execute getters, serialization hooks, or proxy traps during protected recovery", () => {
  const directory = home(), invoked = vi.fn(() => { throw new Error("Metadata hook must never execute"); });
  const accessor = Object.defineProperty({}, "trace", { enumerable: true, get: invoked });
  const hook = { toJSON: invoked };
  const customPrototype = Object.create({ toJSON: invoked });
  const proxy = new Proxy({}, { get: invoked, ownKeys: invoked, getOwnPropertyDescriptor: invoked, getPrototypeOf: invoked });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const unsafe of [accessor, hook, customPrototype, proxy, cyclic]) {
    const input = session(unsafe); expect(saveSession(input, directory)).toBe(true);
    expect(loadSession(input.id, directory)?.consoleState).toMatchObject({ executionQuarantine: quarantine, configuration, queuedMessages, stagedPrompt });
  }
  const configurationAccessor = session(null);
  Object.defineProperty(configurationAccessor.consoleState!, "configuration", { enumerable: true, get: invoked });
  expect(saveSession(configurationAccessor, directory)).toBe(true);
  expect(loadSession(configurationAccessor.id, directory)?.consoleState?.executionQuarantine).toEqual(quarantine);
  expect(loadSession(configurationAccessor.id, directory)?.consoleState?.configuration).toBeUndefined();
  const outerAccessor = session(null);
  Object.defineProperty(outerAccessor, "consoleState", { enumerable: true, get: invoked });
  expect(saveSession(outerAccessor, directory)).toBe(false);
  const protectedAccessor = session(null);
  Object.defineProperty(protectedAccessor.consoleState!.executionQuarantine!, "reason", { enumerable: true, get: invoked });
  expect(saveSession(protectedAccessor, directory)).toBe(false);
  expect(invoked).not.toHaveBeenCalled();
});
it("keeps invalid saves strict when there is no valid safety marker", () => {
  const directory = home(), input = session(display("bytes"));
  delete input.consoleState!.executionQuarantine;
  expect(saveSession(input, directory)).toBe(false);
  expect(loadSession(input.id, directory)).toBeNull();
});

it("keeps the faithful native transcript independent of optional metadata size caps", () => {
  const directory = home(), input = session(display("bytes"));
  input.messages = [{ role: "user", content: [{ type: "text", text: "native evidence\n".repeat(300_000) }] }];
  expect(saveSession(input, directory)).toBe(true);
  const loaded = loadSession(input.id, directory)!;
  expect(loaded.messages).toEqual(input.messages);
  expect(loaded.consoleState).toMatchObject({ executionQuarantine: quarantine, configuration, queuedMessages, stagedPrompt });
});

it("retains paused input and staged context when a valid worker transcript crosses the display budget", () => {
  const directory = home(), input = session(null);
  input.consoleState!.workers = [{ id: "retained-worker", parentId: input.id, name: "Worker", status: "stopped", task: "Retain operator context",
    transcript: Array.from({ length: 6 }, (_, turn) => ({ turn, ts: turn, assistant: "x".repeat(800_000) })) }];
  writeRaw(input, directory);
  expect(loadSession(input.id, directory)?.consoleState).toMatchObject({ executionQuarantine: quarantine, configuration, queuedMessages, stagedPrompt });
  expect(saveSession(input, directory)).toBe(true);
  expect(loadSession(input.id, directory)).toMatchObject({ messages: input.messages, consoleState: { executionQuarantine: quarantine, configuration, queuedMessages, stagedPrompt } });
});
