import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROVIDER_DEVICE_AUTH,
  startDeviceAuth,
  type DeviceAuthResponse,
  type DeviceAuthUpdate,
} from "./device-auth.js";
import { getActiveAccount, loadAccountStore } from "./credential-store.js";
import { providerSupportsMethod } from "./provider-status.js";

const directories: string[] = [];

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "0sec-device-auth-"));
  directories.push(home);
  return home;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function jsonResponse(status: number, body: unknown): DeviceAuthResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const CONFIG = PROVIDER_DEVICE_AUTH.xai;

/** A fake transport: device code always succeeds, token responses are queued. */
function makeFetch(tokenResponses: Array<DeviceAuthResponse | Error>) {
  const calls = { device: 0, token: 0 };
  const fetchImpl = async (
    url: string,
    _init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<DeviceAuthResponse> => {
    if (url === CONFIG.deviceCodeUrl) {
      calls.device += 1;
      return jsonResponse(200, {
        device_code: "dev-code",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.x.ai/device",
        interval: 1,
        expires_in: 600,
      });
    }
    if (url === CONFIG.tokenUrl) {
      const next = tokenResponses[calls.token] ?? jsonResponse(400, { error: "authorization_pending" });
      calls.token += 1;
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
}

/** Drain the microtask queue so the injected-immediate async engine settles. */
async function flush(times = 50): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

const noopBrowser = () => {};
const fixedNow = () => 1_000;

describe("startDeviceAuth", () => {
  it("polls pending -> success, builds the account record and applies the env patch", async () => {
    const home = temporaryHome();
    const env: NodeJS.ProcessEnv = {};
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(400, { error: "authorization_pending" }),
      jsonResponse(200, { access_token: "access-tok", refresh_token: "refresh-tok", expires_in: 3600 }),
    ]);
    const updates: DeviceAuthUpdate[] = [];
    let connected = 0;

    startDeviceAuth(CONFIG, {
      env,
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: () => Promise.resolve(),
      openBrowser: noopBrowser,
      onUpdate: (update) => updates.push(update),
      onConnected: () => { connected += 1; },
    });
    await flush();

    // Two token polls: the pending one, then the success.
    expect(calls.token).toBe(2);
    expect(connected).toBe(1);
    expect(updates.at(-1)?.phase).toBe("connected");

    // The env patch flipped the provider on, so providerStates would see it.
    expect(env.XAI_API_KEY).toBe("access-tok");
    expect(env["0SEC_XAI_OAUTH_REFRESH_TOKEN"]).toBe("refresh-tok");

    // The account record was persisted as an active oauth account.
    const record = getActiveAccount(loadAccountStore(home), "xai");
    expect(record?.kind).toBe("oauth");
    if (record?.kind === "oauth") {
      expect(record.tokens.accessToken).toBe("access-tok");
      expect(record.tokens.refreshToken).toBe("refresh-tok");
      expect(record.tokens.expiresAt).toBeTypeOf("number");
    }

    // The user code and verification URL were surfaced as transcript lines.
    const running = updates.find((u) => u.lines.length > 0);
    expect(running?.lines.some((line) => line.includes("ABCD-1234"))).toBe(true);
  });

  it("honors slow_down by backing off the poll interval", async () => {
    const home = temporaryHome();
    const sleeps: number[] = [];
    const { fetchImpl } = makeFetch([
      jsonResponse(400, { error: "slow_down" }),
      jsonResponse(200, { access_token: "access-tok" }),
    ]);

    startDeviceAuth(CONFIG, {
      env: {},
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      openBrowser: noopBrowser,
      onUpdate: () => {},
      onConnected: () => {},
    });
    await flush();

    // interval starts at 1s; after slow_down it bumps by 5s to 6s.
    expect(sleeps[0]).toBe(1_000);
    expect(sleeps[1]).toBe(6_000);
  });

  it("treats expired_token as a failure, not a connection", async () => {
    const home = temporaryHome();
    const env: NodeJS.ProcessEnv = {};
    const { fetchImpl } = makeFetch([jsonResponse(400, { error: "expired_token" })]);
    const updates: DeviceAuthUpdate[] = [];
    let connected = 0;

    startDeviceAuth(CONFIG, {
      env,
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: () => Promise.resolve(),
      openBrowser: noopBrowser,
      onUpdate: (update) => updates.push(update),
      onConnected: () => { connected += 1; },
    });
    await flush();

    expect(connected).toBe(0);
    expect(updates.at(-1)?.phase).toBe("failed");
    expect(updates.at(-1)?.message).toMatch(/expired/i);
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it("stops polling when cancelled during the poll interval", async () => {
    const home = temporaryHome();
    let release: (() => void) | undefined;
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(200, { access_token: "should-not-be-reached" }),
    ]);
    const updates: DeviceAuthUpdate[] = [];

    const session = startDeviceAuth(CONFIG, {
      env: {},
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: () => new Promise<void>((resolve) => { release = resolve; }),
      openBrowser: noopBrowser,
      onUpdate: (update) => updates.push(update),
      onConnected: () => {},
    });
    await flush();

    // The device code was fetched and we're parked in the first sleep.
    expect(calls.device).toBe(1);
    expect(release).toBeDefined();

    session.cancel();
    release?.();
    await flush();

    // The token endpoint was never polled after cancellation.
    expect(calls.token).toBe(0);
    expect(updates.at(-1)?.phase).toBe("cancelled");
  });

  it("reports a network error as a failure with the error message", async () => {
    const home = temporaryHome();
    const { fetchImpl } = makeFetch([new Error("boom: connection reset")]);
    const updates: DeviceAuthUpdate[] = [];

    startDeviceAuth(CONFIG, {
      env: {},
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: () => Promise.resolve(),
      openBrowser: noopBrowser,
      onUpdate: (update) => updates.push(update),
      onConnected: () => {},
    });
    await flush();

    expect(updates.at(-1)?.phase).toBe("failed");
    expect(updates.at(-1)?.message).toContain("boom: connection reset");
  });
});

describe("provider-status oauth methods", () => {
  it("lets xai and kimi authenticate with oauth (api-key stays secondary)", () => {
    for (const id of ["xai", "kimi"]) {
      expect(providerSupportsMethod(id, "oauth")).toBe(true);
      expect(providerSupportsMethod(id, "api-key")).toBe(true);
    }
  });

  it("keeps anthropic api-key only", () => {
    expect(providerSupportsMethod("anthropic", "api-key")).toBe(true);
    expect(providerSupportsMethod("anthropic", "oauth")).toBe(false);
  });
});
