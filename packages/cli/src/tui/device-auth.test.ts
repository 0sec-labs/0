import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  PROVIDER_DEVICE_AUTH,
  startDeviceAuth,
  type DeviceAuthResponse,
  type DeviceAuthUpdate,
  type DeviceCodeProviderConfig,
  type LoopbackRedirect,
  type LoopbackServer,
  type PkceLoopbackProviderConfig,
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

const CONFIG = PROVIDER_DEVICE_AUTH.xai as DeviceCodeProviderConfig;

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

const OPENROUTER = PROVIDER_DEVICE_AUTH.openrouter as PkceLoopbackProviderConfig;

/** A fake loopback server whose redirect the test drives by hand. */
function makePkceServer(port = 4567) {
  const state = { closed: 0, port };
  let deliver: ((redirect: LoopbackRedirect) => void) | undefined;
  const factory = async ({ onRedirect }: { onRedirect: (redirect: LoopbackRedirect) => void }): Promise<LoopbackServer> => {
    deliver = onRedirect;
    return { port: state.port, close: () => { state.closed += 1; } };
  };
  return { factory, state, redirect: (redirect: LoopbackRedirect) => deliver?.(redirect) };
}

/** A fake transport recording every request; the keys exchange is queued. */
function makePkceFetch(exchange: DeviceAuthResponse | Error) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<DeviceAuthResponse> => {
    calls.push({ url, body: init.body });
    if (url === OPENROUTER.keysUrl) {
      if (exchange instanceof Error) throw exchange;
      return exchange;
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
}

/** A sleep that never resolves, so the pkce timeout never fires under test. */
const neverSleep = () => new Promise<void>(() => {});

describe("startDeviceAuth pkce-loopback (OpenRouter)", () => {
  it("runs the browser flow: challenge -> loopback code -> minted api_key + env patch", async () => {
    const home = temporaryHome();
    const env: NodeJS.ProcessEnv = {};
    const pkce = makePkceServer();
    const { fetchImpl, calls } = makePkceFetch(jsonResponse(200, { key: "sk-or-provisioned" }));
    const opened: string[] = [];
    const updates: DeviceAuthUpdate[] = [];
    let connected = 0;

    startDeviceAuth(OPENROUTER, {
      env,
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: neverSleep,
      serverFactory: pkce.factory,
      createPkcePair: () => ({ verifier: "verifier-123", challenge: "challenge-abc" }),
      openBrowser: (url) => { opened.push(url); },
      onUpdate: (update) => updates.push(update),
      onConnected: () => { connected += 1; },
    });
    await flush();

    // The browser was sent to the authorize URL with the S256 challenge and the
    // client-id-less loopback callback (OpenRouter names it callback_url).
    expect(opened).toHaveLength(1);
    const authorizeUrl = new URL(opened[0]!);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://openrouter.ai/auth");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("callback_url")).toBe(`http://localhost:${pkce.state.port}/callback`);
    expect(authorizeUrl.searchParams.has("client_id")).toBe(false);

    // The loopback delivers the authorization code.
    pkce.redirect({ code: "auth-code-xyz" });
    await flush();

    // The exchange POSTed { code, code_verifier } to the keys endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OPENROUTER.keysUrl);
    expect(JSON.parse(calls[0]!.body)).toEqual({ code: "auth-code-xyz", code_verifier: "verifier-123" });

    expect(connected).toBe(1);
    expect(updates.at(-1)?.phase).toBe("connected");
    // The server was closed after the redirect landed.
    expect(pkce.state.closed).toBe(1);

    // The minted key is a durable api_key, written to OPENROUTER_API_KEY.
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-provisioned");
    const record = getActiveAccount(loadAccountStore(home), "openrouter");
    expect(record?.kind).toBe("api_key");
    if (record?.kind === "api_key") expect(record.secret).toBe("sk-or-provisioned");
  });

  it("derives the S256 challenge from the generated verifier by default", async () => {
    const home = temporaryHome();
    const pkce = makePkceServer();
    const { fetchImpl, calls } = makePkceFetch(jsonResponse(200, { key: "sk-or-x" }));
    const opened: string[] = [];

    startDeviceAuth(OPENROUTER, {
      env: {},
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: neverSleep,
      serverFactory: pkce.factory,
      // No createPkcePair: exercise the real node:crypto generator.
      openBrowser: (url) => { opened.push(url); },
      onUpdate: () => {},
      onConnected: () => {},
    });
    await flush();
    pkce.redirect({ code: "code-1" });
    await flush();

    const challenge = new URL(opened[0]!).searchParams.get("code_challenge")!;
    const verifier = JSON.parse(calls[0]!.body).code_verifier as string;
    const expected = createHash("sha256").update(verifier).digest().toString("base64url");
    expect(challenge).toBe(expected);
    // base64url: no padding, no + or /.
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("closes the loopback server and reports cancelled on cancel()", async () => {
    const home = temporaryHome();
    const pkce = makePkceServer();
    const { fetchImpl, calls } = makePkceFetch(jsonResponse(200, { key: "should-not-mint" }));
    const updates: DeviceAuthUpdate[] = [];

    const session = startDeviceAuth(OPENROUTER, {
      env: {},
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: neverSleep,
      serverFactory: pkce.factory,
      createPkcePair: () => ({ verifier: "v", challenge: "c" }),
      openBrowser: () => {},
      onUpdate: (update) => updates.push(update),
      onConnected: () => {},
    });
    await flush();

    session.cancel();
    await flush();

    expect(pkce.state.closed).toBe(1);
    expect(calls).toHaveLength(0);
    expect(updates.at(-1)?.phase).toBe("cancelled");
  });

  it("fails (not connects) when the redirect never arrives before the timeout", async () => {
    const home = temporaryHome();
    const pkce = makePkceServer();
    const { fetchImpl, calls } = makePkceFetch(jsonResponse(200, { key: "unreached" }));
    const updates: DeviceAuthUpdate[] = [];
    let connected = 0;

    startDeviceAuth(OPENROUTER, {
      env: {},
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: () => Promise.resolve(), // timeout fires immediately
      serverFactory: pkce.factory,
      createPkcePair: () => ({ verifier: "v", challenge: "c" }),
      openBrowser: () => {},
      onUpdate: (update) => updates.push(update),
      onConnected: () => { connected += 1; },
    });
    await flush();

    expect(connected).toBe(0);
    expect(calls).toHaveLength(0);
    expect(updates.at(-1)?.phase).toBe("failed");
    expect(updates.at(-1)?.message).toMatch(/timed out/i);
    expect(pkce.state.closed).toBe(1);
  });

  it("fails when the keys exchange returns no api key", async () => {
    const home = temporaryHome();
    const pkce = makePkceServer();
    const { fetchImpl } = makePkceFetch(jsonResponse(200, { not_a_key: true }));
    const updates: DeviceAuthUpdate[] = [];
    let connected = 0;

    startDeviceAuth(OPENROUTER, {
      env: {},
      homeDir: home,
      fetch: fetchImpl,
      now: fixedNow,
      sleep: neverSleep,
      serverFactory: pkce.factory,
      createPkcePair: () => ({ verifier: "v", challenge: "c" }),
      openBrowser: () => {},
      onUpdate: (update) => updates.push(update),
      onConnected: () => { connected += 1; },
    });
    await flush();
    pkce.redirect({ code: "code-1" });
    await flush();

    expect(connected).toBe(0);
    expect(updates.at(-1)?.phase).toBe("failed");
    expect(updates.at(-1)?.message).toMatch(/api key/i);
  });
});

describe("provider-status oauth methods", () => {
  it("lets xai and kimi authenticate with oauth (api-key stays secondary)", () => {
    for (const id of ["xai", "kimi"]) {
      expect(providerSupportsMethod(id, "oauth")).toBe(true);
      expect(providerSupportsMethod(id, "api-key")).toBe(true);
    }
  });

  it("lets openrouter authenticate with oauth and api-key", () => {
    expect(providerSupportsMethod("openrouter", "oauth")).toBe(true);
    expect(providerSupportsMethod("openrouter", "api-key")).toBe(true);
  });

  it("keeps anthropic api-key only", () => {
    expect(providerSupportsMethod("anthropic", "api-key")).toBe(true);
    expect(providerSupportsMethod("anthropic", "oauth")).toBe(false);
  });
});
