import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedWorker } from "../worker-deploy.js";
import { startManagedHostReconnect } from "./managed-host-reconnect.js";

const worker = { schemaVersion: 1 as const, backendId: "managed", ssh: "trusted", port: 23456, remoteDir: "/tmp/zero-engine" };
afterEach(() => { vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  const registry = {
    list: vi.fn(() => [{ id: "managed", status: "disconnected" }]),
    handshake: vi.fn(async () => ({ backend: { status: "disconnected" } })),
  };
  const repair = vi.fn(async (_id: string, _signal: AbortSignal): Promise<unknown> => undefined);
  const getMetadata = vi.fn((_id: string): ManagedWorker => worker);
  const onRecovered = vi.fn();
  const start = () => startManagedHostReconnect({ getRegistry: () => registry, repair, getMetadata, onRecovered });
  return { registry, repair, getMetadata, onRecovered, start };
}
describe("managed host recovery", () => {
  it("repairs registered managed legacy hosts, then refreshes their status", async () => {
    const f = fixture(); const dispose = f.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.repair).toHaveBeenCalledWith("managed", expect.any(AbortSignal));
    expect(f.onRecovered).toHaveBeenCalledWith("managed"); dispose();
  });
  it("does not repair connected, explicitly stopped or unmanaged hosts", async () => {
    const f = fixture();
    f.registry.list.mockReturnValue([{ id: "connected", status: "connected" }, { id: "stopped", status: "disconnected" }, { id: "unmanaged", status: "disconnected" }]);
    f.getMetadata.mockImplementation(id => {
      if (id === "unmanaged") throw new Error("No trusted metadata");
      return { ...worker, autoReconnect: id !== "stopped" };
    });
    f.registry.handshake.mockResolvedValue({ backend: { status: "connected" } });
    const dispose = f.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.repair).not.toHaveBeenCalled(); dispose();
  });
  it("backs failures off for one, two and five minutes", async () => {
    const f = fixture(); f.repair.mockRejectedValue(new Error("SSH unavailable"));
    const dispose = f.start(); await vi.advanceTimersByTimeAsync(0); expect(f.repair).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.repair).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.repair).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000); expect(f.repair).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(270_000); expect(f.repair).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.repair).toHaveBeenCalledTimes(4); dispose();
  });
  it("never overlaps repairs and aborts its child on disposal", async () => {
    const f = fixture(); const pending = Promise.withResolvers<void>(); f.repair.mockReturnValue(pending.promise);
    const dispose = f.start(); await vi.advanceTimersByTimeAsync(90_000);
    expect(f.repair).toHaveBeenCalledTimes(1);
    const signal = f.repair.mock.calls[0]![1]; dispose(); expect(signal.aborted).toBe(true);
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.onRecovered).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
