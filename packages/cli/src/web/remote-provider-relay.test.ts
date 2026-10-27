import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleSession } from "@0/core";
import { RemoteProviderRelayBroker } from "./remote-provider-relay.js";
import { loadSession } from "../tui/session-store.js";
import { ConsoleGateway } from "./console-gateway.js";
const brokers: RemoteProviderRelayBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); vi.restoreAllMocks(); });
function fixture() {
  const broker = new RemoteProviderRelayBroker({ epoch: "epoch-1" }); brokers.push(broker);
  const grant = broker.create({ epoch: "epoch-1", provider: "chatgpt-codex", models: ["gpt-6.1-sol"], model: "gpt-6.1-sol" });
  broker.bind(grant.id, "session-1");
  return { broker, grant };
}
const envelope = { provider: "chatgpt-codex" as const, model: "gpt-6.1-sol", body: JSON.stringify({ model: "gpt-6.1-sol", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], stream: true, store: false }) };
function respond(broker: RemoteProviderRelayBroker, grantId: string, request: { requestId: string; sessionId: string }, text = "Local account response") {
  const stream = `data: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 5, output_tokens: 3 } } })}\n\n`;
  return broker.events(grantId, request.requestId, { epoch: "epoch-1", sessionId: request.sessionId, events: [{ kind: "headers", status: 200, contentType: "text/event-stream" }, { kind: "chunk", data: Buffer.from(stream).toString("base64") }, { kind: "end" }] });
}
describe("remote execution / local provider relay", () => {
  it("keeps an attached pump alive beyond the initial 30-minute lease but expires disconnected grants", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { broker, grant } = fixture();
    for (let poll = 1; poll <= 4; poll++) {
      clock.mockReturnValue(1_800_000_000_000 + poll * 20 * 60_000);
      expect(() => broker.poll(grant.id)).not.toThrow();
    }
    expect(Date.parse(broker.status(grant.id).expiresAt)).toBe(Date.now() + 30 * 60_000);
    clock.mockReturnValue(Date.now() + 31 * 60_000);
    expect(() => broker.poll(grant.id)).toThrow("grant expired");
  });

  it("redelivers an unacknowledged poll response without duplicating inference after headers", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { broker, grant } = fixture();
    const response = broker.request(grant.id, "session-1", envelope);
    const first = broker.poll(grant.id).requests[0]!;
    expect(broker.poll(grant.id).requests).toEqual([]);
    clock.mockReturnValue(Date.now() + 5001);
    expect(broker.poll(grant.id).requests[0]?.requestId).toBe(first.requestId);
    broker.events(grant.id, first.requestId, { epoch: "epoch-1", sessionId: "session-1", events: [{ kind: "headers", status: 200, contentType: "text/event-stream" }] });
    const accepted = await response;
    clock.mockReturnValue(Date.now() + 5001);
    expect(broker.poll(grant.id).requests).toEqual([]);
    broker.events(grant.id, first.requestId, { epoch: "epoch-1", sessionId: "session-1", events: [{ kind: "end" }] });
    await accepted.text();
  });

  it("streams a real runtime request through the queue and full Responses parser without remote fetch/auth", async () => {
    const { broker, grant } = fixture(); const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Remote inference must never fetch provider endpoints"));
    const runtime = broker.runtime(grant.id, "session-1");
    const pending = runtime.executeNative("System", [{ role: "user", content: [{ type: "text", text: "hello" }] }], []);
    let request: ReturnType<typeof broker.poll>["requests"][number] | undefined;
    await vi.waitFor(() => { request = broker.poll(grant.id).requests[0]; expect(request).toBeDefined(); });
    expect(JSON.parse(request!.body).input).toBeDefined(); expect(request).toMatchObject({ grantId: grant.id, epoch: "epoch-1", sessionId: "session-1", model: "gpt-6.1-sol" });
    respond(broker, grant.id, request!); const result = await pending;
    expect(result.content).toContainEqual({ type: "text", text: "Local account response" }); expect(result.usage?.inputTokens).toBe(5); expect(fetch).not.toHaveBeenCalled();
    expect(runtime.connectionIdentity()).toBe(`relay:epoch-1:${grant.id}`);
    await expect(runtime.forkForSubagent(1000, { model: "not-granted" })).rejects.toThrow();
    expect(() => runtime.reconfigure({ provider: "anthropic" })).toThrow(/grant/);
  });
  it("keeps operator cancellation terminal through the model runtime", async () => {
    const { broker, grant } = fixture(); const abort = new AbortController();
    const runtime = broker.runtime(grant.id, "session-1");
    const result = runtime.executeNative("", [{ role: "user", content: [{ type: "text", text: "hello" }] }], [], undefined, abort.signal);
    let request: ReturnType<typeof broker.poll>["requests"][number] | undefined;
    await vi.waitFor(() => { request = broker.poll(grant.id).requests[0]; expect(request).toBeDefined(); });
    abort.abort(); expect((await result).cancelled).toBe(true);
    expect(broker.poll(grant.id).cancelled).toContain(request!.requestId);
    expect(broker.poll(grant.id).requests).toEqual([]);
  });
  it("enforces session, epoch, exact provider/model and no background storage", async () => {
    const { broker, grant } = fixture();
    expect(() => broker.bind(grant.id, "other-session")).toThrow(/another/);
    expect(() => broker.create({ epoch: "stale", provider: "chatgpt-codex", model: "gpt-6.1-sol", models: ["gpt-6.1-sol"] })).toThrow(/epoch/);
    expect(() => broker.request(grant.id, "session-1", { ...envelope, model: "other" })).toThrow(/grant/);
    expect(() => broker.request(grant.id, "session-1", { ...envelope, body: JSON.stringify({ model: envelope.model, input: [], store: true }) })).toThrow(/Responses/);
    const pending = broker.request(grant.id, "session-1", envelope); const rejected = pending.catch(error => error);
    const request = broker.poll(grant.id).requests[0]!;
    expect(() => broker.events(grant.id, request.requestId, { epoch: "wrong", sessionId: "session-1", events: [{ kind: "end" }] })).toThrow(/epoch/);
    broker.close(grant.id); expect(await rejected).toBeInstanceOf(Error);
  });
  it("reports non-draining bounded diagnostic metadata without request contents", async () => {
    const { broker, grant } = fixture();
    const pending = broker.request(grant.id, "session-1", envelope); const settled = pending.catch(error => error);
    const initial = broker.status(grant.id);
    expect(initial.pending).toHaveLength(1); expect(initial.pending[0]).toMatchObject({ delivered: false, headers: false, receivedBytes: 0, bufferedBytes: 0 });
    expect(JSON.stringify(initial)).not.toContain("hello"); expect(JSON.stringify(initial)).not.toContain(envelope.body);
    const next = broker.poll(grant.id).requests[0]!; expect(next.requestId).toBe(initial.pending[0].id);
    expect(broker.status(grant.id).pending[0].delivered).toBe(true);
    broker.close(grant.id); await settled;
  });
  it("propagates cancellation to the local pump and rejects late response data", async () => {
    const { broker, grant } = fixture(); const abort = new AbortController();
    const pending = broker.request(grant.id, "session-1", envelope, abort.signal); const rejected = pending.catch(error => error);
    const request = broker.poll(grant.id).requests[0]!; abort.abort();
    expect(await rejected).toBeInstanceOf(Error); expect(broker.poll(grant.id).cancelled).toContain(request.requestId);
    expect(() => respond(broker, grant.id, request)).toThrow(/pending/);
  });
  it("exposes local model ownership before the first turn and uses it in an actual gateway session", async () => {
    const broker = new RemoteProviderRelayBroker({ epoch: "epoch-1" }); brokers.push(broker);
    const grant = broker.create({ epoch: "epoch-1", provider: "chatgpt-codex", models: ["gpt-6.1-sol"], model: "gpt-6.1-sol" });
    const home = mkdtempSync(join(tmpdir(), "0-relay-gateway-"));
    const gateway = new ConsoleGateway({ homeDir: home, remoteProviderRelays: broker, createSession: input => createConsoleSession({ ...input, runtime: broker.runtime(grant.id, input.scanId) }) });
    try {
      const session = gateway.create({ modelSource: { kind: "local", grantId: grant.id } });
      expect(session.runtime).toMatchObject({ providerId: "chatgpt-codex", model: "gpt-6.1-sol", modelSource: "local", configured: true });
      await gateway.send(session.id, "hello");
      let request: ReturnType<typeof broker.poll>["requests"][number] | undefined;
      await vi.waitFor(() => { request = broker.poll(grant.id).requests[0]; expect(request).toBeDefined(); });
      respond(broker, grant.id, request!); await vi.waitFor(() => expect(gateway.get(session.id).session.status).toBe("ready"));
      expect(gateway.get(session.id).lastOutcome?.assistantText).toBe("Local account response");
      const saved = gateway.save(session.id);
      const retained = loadSession(saved.id, home)!;
      expect(retained.consoleState?.configuration?.modelSource).toBe("local");
      expect(JSON.stringify(retained)).not.toContain(grant.id);
      await gateway.closeAll();
      const createHostSession = vi.fn(() => { throw new Error("Must not fall back to remote credentials"); });
      const restarted = new ConsoleGateway({ homeDir: home, remoteProviderRelays: broker, createSession: createHostSession });
      try {
        const resumed = await restarted.resume(saved.id);
        expect(resumed.runtime).toMatchObject({ modelSource: "local", configured: false });
        await expect(restarted.send(resumed.id, "continue")).rejects.toThrow(/Reconnect the local model source/);
        expect(createHostSession).not.toHaveBeenCalled();
      } finally { await restarted.closeAll(); }
    } finally { await gateway.closeAll(); rmSync(home, { recursive: true, force: true }); }
  });
});
