import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceHostRequest, isLocalBrowserRequest } from "./workspace-host-routes.js";

const request = (address: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: address }, headers }) as never;
const response = () => ({ once: vi.fn(), writableEnded: false }) as never;

describe("host-only workspace routes", () => {
  it("treats only a direct loopback connection as the host's own browser", () => {
    expect(isLocalBrowserRequest(request("127.0.0.1"))).toBe(true);
    expect(isLocalBrowserRequest(request("::1"))).toBe(true);
    expect(isLocalBrowserRequest(request("::ffff:127.0.0.1"))).toBe(true);
    expect(isLocalBrowserRequest(request("100.64.1.2"))).toBe(false);
    expect(isLocalBrowserRequest(request("127.0.0.1", { "x-forwarded-for": "100.64.1.2" }))).toBe(false);
  });
  it("opens the Files & Folders pane for a local browser on macOS only", async () => {
    const open = vi.fn(async () => undefined);
    expect(await handleWorkspaceHostRequest("project/open-privacy-settings", "POST", {}, request("127.0.0.1"), response(), { platform: "darwin", open })).toEqual({ status: 200, data: { opened: true } });
    expect(open).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders");
    await handleWorkspaceHostRequest("project/open-privacy-settings", "POST", { pane: "fullDisk" }, request("::1"), response(), { platform: "darwin", open });
    expect(open).toHaveBeenLastCalledWith(expect.stringContaining("Privacy_AllFiles"));
  });
  it("refuses remote clients, other platforms, unknown panes and wrong methods without opening anything", async () => {
    const open = vi.fn(async () => undefined);
    expect(await handleWorkspaceHostRequest("project/open-privacy-settings", "POST", {}, request("100.64.1.2"), response(), { platform: "darwin", open })).toMatchObject({ status: 403, data: { code: "host_only" } });
    expect(await handleWorkspaceHostRequest("project/open-privacy-settings", "POST", {}, request("127.0.0.1"), response(), { platform: "linux", open })).toMatchObject({ status: 400 });
    expect(await handleWorkspaceHostRequest("project/open-privacy-settings", "POST", { pane: "x; rm -rf /" }, request("127.0.0.1"), response(), { platform: "darwin", open })).toMatchObject({ status: 400 });
    expect(await handleWorkspaceHostRequest("project/open-privacy-settings", "GET", undefined, request("127.0.0.1"), response(), { platform: "darwin", open })).toMatchObject({ status: 405 });
    expect(open).not.toHaveBeenCalled();
    expect(await handleWorkspaceHostRequest("project/other", "POST", {}, request("127.0.0.1"), response())).toBeNull();
  });
  it("tells the chooser whether the browser is local and aborts it when the request closes", async () => {
    const choose = vi.fn(async () => ({ supported: false, path: null }));
    const res = { once: vi.fn(), writableEnded: false };
    await handleWorkspaceHostRequest("project/choose-directory", "POST", { path: "/x" }, request("100.64.1.2"), res as never, { platform: "darwin", choose });
    const options = (choose.mock.calls[0] as unknown as [unknown, { local: boolean; signal: AbortSignal }])[1];
    expect(options.local).toBe(false);
    expect(options.signal.aborted).toBe(false);
    res.once.mock.calls[0]![1]();
    expect(options.signal.aborted).toBe(true);
  });
});
