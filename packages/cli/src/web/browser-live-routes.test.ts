import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBrowserLiveRequest } from "./browser-live-routes.js";

function fixture() {
  const req = Object.assign(new EventEmitter(), { method: "GET" }) as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn((_chunk: string) => true),
    end: vi.fn(), destroyed: false, writableEnded: false,
  });
  const stop = vi.fn();
  let frame!: (value: { data: string; mimeType: "image/jpeg"; capturedAt: string }) => void;
  const source = {
    list: vi.fn(() => [{ pageId: "page-1", liveAvailable: true }]),
    subscribe: vi.fn(async (_owner: string, _page: string, callback: typeof frame): Promise<() => void> => { frame = callback; return stop; }),
  };
  const open = (url = "http://local/api/console/sessions/chat/browser/views/page-1/stream", pageId: string | undefined = "page-1") =>
    handleBrowserLiveRequest(req, res as unknown as ServerResponse, new URL(url), "chat", pageId, source);
  return { req, res, source, stop, open, emitFrame: () => frame({ data: "jpeg", mimeType: "image/jpeg", capturedAt: "2026-10-20T00:00:00Z" }) };
}
afterEach(() => { vi.useRealTimers(); });

describe("browser live transport", () => {
  it("exposes only views returned for the authenticated owner", async () => {
    const f = fixture();
    await handleBrowserLiveRequest(f.req, f.res as unknown as ServerResponse, new URL("http://local/views"), "chat", undefined, f.source);
    expect(f.source.list).toHaveBeenCalledWith("chat");
    expect(f.res.end).toHaveBeenCalledWith(JSON.stringify({ views: [{ pageId: "page-1", liveAvailable: true }] }));
    expect(f.source.subscribe).not.toHaveBeenCalled();
  });
  it("rejects foreign or missing pages before subscribing", async () => {
    const f = fixture();
    await f.open(undefined, "foreign");
    expect(f.res.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(f.source.subscribe).not.toHaveBeenCalled();
  });
  it("refuses credentials or options supplied in the stream URL", async () => {
    const f = fixture();
    await f.open("http://local/views/page-1/stream?token=secret");
    expect(f.res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(f.source.subscribe).not.toHaveBeenCalled();
  });
  it("streams frames, drops backpressured frames and unsubscribes immediately on disconnect", async () => {
    const f = fixture(); await f.open();
    f.res.write.mockClear(); f.res.write.mockReturnValueOnce(false);
    f.emitFrame(); f.emitFrame(); f.emitFrame();
    expect(f.res.write).toHaveBeenCalledTimes(1);
    expect(f.res.write.mock.calls[0]?.[0]).toContain('event: frame');
    f.res.emit("drain"); f.emitFrame();
    expect(f.res.write).toHaveBeenCalledTimes(2);
    f.res.emit("close"); f.emitFrame();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.res.write).toHaveBeenCalledTimes(2);
    expect(f.res.listenerCount("drain")).toBe(0);
  });
  it("releases a subscription that finishes connecting after the client disconnects", async () => {
    const f = fixture(); const gate = Promise.withResolvers<() => void>();
    f.source.subscribe.mockReturnValue(gate.promise);
    const opening = f.open(); f.res.emit("close"); gate.resolve(f.stop); await opening;
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it("ends the stream and producer when the page disappears", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.open();
    f.source.list.mockReturnValue([]); vi.advanceTimersByTime(15_000);
    expect(f.res.write).toHaveBeenCalledWith(expect.stringContaining('"status":"closed"'));
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.res.end).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends subscriptions at the bounded stream lifetime", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.open(); vi.advanceTimersByTime(300_000);
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.res.end).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
