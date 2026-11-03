import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { PROVIDER_DEVICE_AUTH, startDeviceAuth, type DeviceAuthSession, type DeviceAuthUpdate, type PkceLoopbackProviderConfig } from "./device-auth.js";

const homes: string[] = [];
const sessions: DeviceAuthSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.cancel(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function waitFor(test: () => boolean) { const start = Date.now(); while (!test()) { if (Date.now() - start > 3000) throw new Error("Auth flow did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); } }
function visit(url: URL): Promise<number> {
  return new Promise((resolve, reject) => { const req = request({ hostname: "127.0.0.1", port: url.port, path: url.pathname + url.search }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }); req.on("error", reject); req.end(); });
}
async function begin() {
  const home = mkdtempSync(join(tmpdir(), "0-auth-capability-")); homes.push(home);
  const updates: DeviceAuthUpdate[] = []; const calls: unknown[] = []; const opened: string[] = []; let connected = 0;
  const session = startDeviceAuth(PROVIDER_DEVICE_AUTH.openrouter as PkceLoopbackProviderConfig, { homeDir: home, env: {},
    openBrowser: url => { opened.push(url); }, fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ key: "sk-or-test-only" }) }; },
    onUpdate: update => updates.push(update), onConnected: () => { connected++; },
  }); sessions.push(session); await waitFor(() => opened.length === 1);
  const callback = new URL(new URL(opened[0]!).searchParams.get("callback_url")!);
  return { callback, updates, calls, connected: () => connected };
}

describe("real OAuth loopback callback capability", () => {
  it("ignores fixed-path and wrong-capability probes, then completes the valid PKCE callback", async () => {
    const flow = await begin(); expect(flow.callback.pathname).toMatch(/^\/callback\/[A-Za-z0-9_-]{43}$/);
    for (const pathname of ["/callback", "/callback/wrong"]) {
      const probe = new URL(flow.callback); probe.pathname = pathname; probe.search = "?error=access_denied";
      expect(await visit(probe)).toBe(404); expect(flow.updates.at(-1)?.phase).toBe("running"); expect(flow.calls).toEqual([]);
    }
    const valid = new URL(flow.callback); valid.search = "?code=valid-code";
    expect(await visit(valid)).toBe(200); await waitFor(() => flow.connected() === 1);
    expect(flow.calls).toMatchObject([{ body: { code: "valid-code", code_challenge_method: "S256" } }]);
    expect(flow.updates.at(-1)?.phase).toBe("connected");
  });

  it("uses a different capability for concurrent transactions and accepts genuine denial", async () => {
    const first = await begin(); const second = await begin(); expect(first.callback.pathname).not.toBe(second.callback.pathname);
    const cross = new URL(second.callback); cross.pathname = first.callback.pathname; cross.search = "?error=access_denied";
    expect(await visit(cross)).toBe(404); expect(second.updates.at(-1)?.phase).toBe("running");
    const denied = new URL(second.callback); denied.search = "?error=access_denied";
    expect(await visit(denied)).toBe(200); await waitFor(() => second.updates.at(-1)?.phase === "failed");
    expect(second.calls).toEqual([]); expect(second.connected()).toBe(0); expect(first.updates.at(-1)?.phase).toBe("running");
  });
});
