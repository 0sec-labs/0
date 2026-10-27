import { describe, it, expect, vi } from "vitest";
import { registerBrowserView, unregisterBrowserView, listBrowserViews, subscribeBrowserView, type BrowserViewFrame } from "./browser-live.js";
import { PlaywrightPage } from "./tools/browser.js";
const frame: BrowserViewFrame = { data: "/9j/", mimeType: "image/jpeg", capturedAt: "2026-10-20T00:00:00Z" };
describe("live browser ownership and producer lifecycle", () => {
  it("shares a single capture, gates every frame and stops at zero subscribers", async () => {
    let allowed = true; let emit!: (frame: BrowserViewFrame) => void;
    const stop = vi.fn(); const start = vi.fn(async callback => { emit = callback; return stop; });
    registerBrowserView("root", "p", () => ({ id: "p", pageId: "p", sessionId: "s", producerId: "child", tab: "main", url: "https://target.test", liveAvailable: true }), () => allowed, start);
    expect(listBrowserViews("other")).toEqual([]);
    await expect(subscribeBrowserView("other", "p", vi.fn())).rejects.toThrow();
    const a = vi.fn(); const b = vi.fn();
    const closeA = await subscribeBrowserView("root", "p", a); const closeB = await subscribeBrowserView("root", "p", b);
    expect(start).toHaveBeenCalledTimes(1); emit(frame); expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
    allowed = false; emit(frame); expect(a).toHaveBeenCalledOnce(); expect(listBrowserViews("root")).toEqual([]);
    closeA(); expect(stop).not.toHaveBeenCalled(); closeB(); expect(stop).toHaveBeenCalledOnce(); unregisterBrowserView("p");
  });
  it("cleans up a producer that finishes starting after the page closes", async () => {
    const gate = Promise.withResolvers<() => void>(); const stop = vi.fn();
    registerBrowserView("root", "closing", () => ({ id: "closing", pageId: "closing", sessionId: "s", producerId: "root", tab: "main", url: "https://target.test", liveAvailable: true }), () => true, () => gate.promise);
    const subscribing = subscribeBrowserView("root", "closing", vi.fn());
    unregisterBrowserView("closing"); gate.resolve(stop); const release = await subscribing; release();
    expect(stop).toHaveBeenCalledOnce(); expect(listBrowserViews("root")).toEqual([]);
  });
  it("reports alternate drivers without capture and rejects live subscriptions", async () => {
    registerBrowserView("root", "fallback", () => ({ id: "fallback", pageId: "fallback", sessionId: "s", producerId: "root", tab: "main", url: "https://target.test", liveAvailable: false }), () => true);
    expect(listBrowserViews("root")[0].liveAvailable).toBe(false);
    await expect(subscribeBrowserView("root", "fallback", vi.fn())).rejects.toThrow(/unavailable/);
    unregisterBrowserView("fallback");
  });
  it("starts genuine CDP screencast, ACKs discarded frames and detaches", async () => {
    let receive!: (payload: any) => void;
    const cdp = { send: vi.fn(async () => undefined), on: vi.fn((_name, callback) => { receive = callback; }), off: vi.fn(), detach: vi.fn(async () => undefined) };
    const page = new PlaywrightPage({ on: vi.fn() } as any, { newCDPSession: async () => cdp } as any);
    const callback = vi.fn(); const stop = await page.streamFrames(callback);
    expect(cdp.send).toHaveBeenCalledWith("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 960, maxHeight: 600, everyNthFrame: 2 });
    receive({ sessionId: 1, data: "/9j/", metadata: { deviceWidth: 960, deviceHeight: 600 } });
    receive({ sessionId: 2, data: "a".repeat(2_800_001) });
    expect(cdp.send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 1 }); expect(cdp.send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 2 });
    expect(callback).toHaveBeenCalledOnce(); expect(callback.mock.calls[0][0]).toMatchObject({ mimeType: "image/jpeg", width: 960, height: 600 });
    stop(); await vi.waitFor(() => expect(cdp.detach).toHaveBeenCalledOnce()); expect(cdp.send).toHaveBeenCalledWith("Page.stopScreencast");
  });
});
