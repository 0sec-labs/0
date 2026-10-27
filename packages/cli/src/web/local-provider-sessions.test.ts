import { describe, expect, it, vi } from "vitest";
import type { DesktopConsoleSession, ConsoleRuntimeSnapshot } from "@0/shared";
import { LocalProviderSessions } from "./local-provider-sessions.js";
import type { createLocalProviderRelay } from "./local-provider-relay.js";

function fixture() {
  const order: string[] = [];
  const relays: Array<Awaited<ReturnType<typeof createLocalProviderRelay>>> = [];
  const createRelay = vi.fn(async () => {
    const relay = { grant: { id: `grant-${relays.length}`, epoch: "epoch", provider: "chatgpt-codex" as const, models: ["local-model"], model: "local-model", expiresAt: new Date(Date.now() + 60000).toISOString() }, info: { providerId: "chatgpt-codex", model: "local-model" } as ConsoleRuntimeSnapshot, status: () => ({ phase: "registered" as const, lastPollAt: null, seenRequests: 0, activeRequests: 0, bytesForwarded: 0 }), start: vi.fn(() => { order.push("start"); }), close: vi.fn(async () => { order.push("close"); }) };
    relays.push(relay); order.push("grant"); return relay;
  });
  const registry = { handshake: vi.fn(), request: vi.fn(async (_backend: string, _path: string, _options: unknown) => { order.push("remote"); return Response.json({ session: { id: "chat" } }); }) };
  const service = new LocalProviderSessions({ registry, createRelay });
  return { service, registry, relays, createRelay, order };
}

describe("trusted local provider session orchestration", () => {
  it("injects the locally issued grant and starts its pump before returning the remote conversation", async () => {
    const f = fixture();
    const result = await f.service.create("remote", { title: "Review", role: "discovery", autonomyMode: "standard", runtime: { model: "local-model" } }, "owner");
    expect(result.session.id).toBe("chat");
    expect(f.order).toEqual(["grant", "remote", "start"]);
    expect(f.registry.request).toHaveBeenCalledWith("remote", "/api/console/sessions", expect.objectContaining({ method: "POST", body: expect.objectContaining({ modelSource: { kind: "local", grantId: "grant-0" }, runtime: { model: "local-model", providerId: "chatgpt-codex" } }) }));
    expect(JSON.stringify(result)).not.toContain("grant-0");
    await f.service.dispose();
  });
  it("rejects browser-supplied grants and foreign workspace/session configuration before touching local credentials", async () => {
    const f = fixture();
    await expect(f.service.create("remote", { modelSource: { kind: "local", grantId: "forged" } })).rejects.toThrow(/issued locally/);
    expect(f.createRelay).not.toHaveBeenCalled();
    await f.service.create("remote", {}, "owner");
    await expect(f.service.configure("remote", "chat", { model: "local-model" }, "other-owner")).rejects.toThrow(/workspace/);
    await expect(f.service.configure("other-backend", "chat", {}, "owner")).rejects.toThrow(/existing local-model/);
    expect(f.createRelay).toHaveBeenCalledTimes(1);
    await f.service.dispose();
  });
  it("keeps the old model grant alive after a failed remote change, replacing it only after success", async () => {
    const f = fixture(); await f.service.create("remote", {}, "owner");
    f.registry.request.mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 409 }));
    await expect(f.service.configure("remote", "chat", { model: "new-model" }, "owner")).rejects.toThrow(/rejected/);
    expect(f.relays[0]!.close).not.toHaveBeenCalled();
    expect(f.relays[1]!.close).toHaveBeenCalledOnce();
    expect(f.relays[1]!.start).not.toHaveBeenCalled();
    await f.service.configure("remote", "chat", { model: "new-model" }, "owner");
    expect(f.relays[2]!.start).toHaveBeenCalledWith("chat");
    expect(f.relays[0]!.close).toHaveBeenCalledOnce();
    await f.service.dispose();
    expect(f.relays[2]!.close).toHaveBeenCalledOnce();
  });
  it("cleans a rejected creation and refuses local backend dispatch", async () => {
    const f = fixture();
    await expect(f.service.create("local", {})).rejects.toThrow(/remote host/);
    f.registry.request.mockResolvedValueOnce(Response.json({ error: "scope" }, { status: 403 }));
    await expect(f.service.create("remote", {})).rejects.toThrow(/rejected/);
    expect(f.relays[0]!.close).toHaveBeenCalledOnce();
    expect(f.relays[0]!.start).not.toHaveBeenCalled();
    await f.service.dispose();
  });
  it("only releases a session for its owning identity and backend", async () => {
    const f = fixture(); await f.service.create("remote", {}, "owner");
    await f.service.release("remote", "chat", "other-owner");
    expect(f.relays[0]!.close).not.toHaveBeenCalled();
    await f.service.release("remote", "chat", "owner");
    expect(f.relays[0]!.close).toHaveBeenCalledOnce();
    await expect(f.service.configure("remote", "chat", {}, "owner")).rejects.toThrow(/existing local-model/);
    await f.service.dispose();
  });
  it("explicit model configuration restores only an idle saved local-model marker through a fresh grant", async () => {
    const f = fixture();
    f.registry.request.mockResolvedValueOnce(Response.json({ snapshot: { session: { id: "saved", status: "ready" }, runtime: { modelSource: "local", model: "saved-model" } } }));
    f.registry.request.mockResolvedValueOnce(Response.json({ session: { id: "saved", status: "ready" } }));
    await f.service.configure("remote", "saved", {}, "owner");
    expect(f.createRelay).toHaveBeenCalledWith(expect.objectContaining({ backendId: "remote", selection: { providerId: "chatgpt-codex", model: "saved-model" } }));
    expect(f.relays[0]!.start).toHaveBeenCalledWith("saved");
    await expect(f.service.configure("remote", "saved", {}, "other-owner")).rejects.toThrow(/workspace/);
    await f.service.dispose();
  });
  it.each(["host", "working"])("does not recreate inference authority for an unsupported saved marker/state %s", async state => {
    const f = fixture();
    f.registry.request.mockResolvedValueOnce(Response.json({ snapshot: { session: { id: "saved", status: state === "working" ? "working" : "ready" }, runtime: { modelSource: state === "host" ? "host" : "local", model: "saved-model" } } }));
    await expect(f.service.configure("remote", "saved", {}, "owner")).rejects.toThrow();
    expect(f.createRelay).not.toHaveBeenCalled();
    await f.service.dispose();
  });

  it("returns scoped status metadata without exposing grant/request capabilities or remote text", async () => {
    const f = fixture(); await f.service.create("remote", {}, "owner");
    f.registry.request.mockResolvedValueOnce(Response.json({ grantId: "grant-0", epoch: "epoch", sessionId: "chat", cancelledCount: 1, pending: [{ id: "secret-request-id", delivered: true, headers: false, receivedBytes: 0, bufferedBytes: 0, ageMs: 20, body: "private input" }], secret: "private token" }));
    const status = await f.service.status("remote", "chat", "owner");
    expect(status.remote).toEqual({ available: true, cancelledCount: 1, pending: [{ delivered: true, headers: false, receivedBytes: 0, bufferedBytes: 0, ageMs: 20 }] });
    expect(JSON.stringify(status)).not.toMatch(/grant-0|secret-request-id|private/);
    const requests = f.registry.request.mock.calls.length;
    await expect(f.service.status("remote", "chat", "foreign")).rejects.toThrow(/workspace/);
    expect(f.registry.request).toHaveBeenCalledTimes(requests);
    f.registry.request.mockResolvedValueOnce(Response.json({ grantId: "wrong", epoch: "epoch", sessionId: "chat", pending: [], cancelledCount: 0 }));
    expect((await f.service.status("remote", "chat", "owner")).remote).toEqual({ available: false });
    await f.service.dispose();
  });

});
