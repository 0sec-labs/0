/**
 * A generic, in-process OAuth engine speaking two browser sign-in KINDS behind
 * one contract: the OAuth 2.0 Device Authorization Grant (RFC 8628,
 * `kind: "device-code"`) and an Authorization Code + PKCE flow with a loopback
 * redirect (RFC 7636 + RFC 8252, `kind: "pkce-loopback"`).
 *
 * This is the sibling of `codex-device-auth.ts`, but it is a different KIND of
 * thing. `codex-device-auth.ts` is a SUBPROCESS orchestrator: it spawns
 * `codex login --device-auth` and scrapes its stdout, because Codex owns the
 * ChatGPT protocol and 0sec must not reimplement it. This module, by contrast,
 * speaks the protocols itself. The device-code path POSTs the device-code
 * endpoint, opens the browser, and polls the token endpoint. The pkce-loopback
 * path generates a code_verifier/code_challenge, stands up a `node:http`
 * loopback server on 127.0.0.1, opens the browser to the provider's authorize
 * URL, awaits the single redirect carrying `code`, and exchanges it for a
 * credential. Both serve providers that have no CLI of their own to lean on.
 *
 * The two are deliberately kept behind the SAME session/update contract
 * (`DeviceAuthPhase`, `DeviceAuthUpdate`, `onUpdate`, `onConnected`, and a
 * `cancel()`-only session) so `connect-screen.tsx` can dispatch to whichever
 * one a provider needs and drive both with one piece of state plumbing.
 *
 * On success the minted credential is persisted through the credential store
 * (`addAccount` + `saveAccountStore`, marked active) AND applied into the live
 * `env` via `accountEnvPatch`, mirroring how the Codex flow reloads its tokens
 * into this process: without the env mutation the provider's green check would
 * not flip until the next restart, because `providerStates` reads only `env`.
 *
 * Everything is wrapped so any failure — a network error, a non-2xx response, a
 * protocol error, an expiry — resolves to phase "failed" with an operator-facing
 * message, never a throw. Network I/O and time are injected (`fetch`, `now`,
 * `sleep`, `openBrowser`) so the whole engine is unit-testable offline.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { defaultOpenBrowser } from "../commands/auth.js";
import {
  accountEnvPatch,
  addAccount,
  loadAccountStore,
  saveAccountStore,
  type AccountRecord,
  type OAuthTokens,
} from "./credential-store.js";
import { PROVIDERS } from "./provider-status.js";
import { sanitizeTuiText } from "./text.js";

/** Bounded transcript, mirroring codex-device-auth.ts. */
const MAX_VISIBLE_LINES = 8;
/** RFC 8628 §3.5: the default minimum poll interval when the server omits one. */
const DEFAULT_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: `slow_down` bumps the interval by at least 5 seconds. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;
/** Fallback overall deadline when the server omits `expires_in`. */
const DEFAULT_EXPIRES_IN_SECONDS = 900;

export type DeviceAuthPhase = "running" | "connected" | "cancelled" | "failed";

export interface DeviceAuthUpdate {
  phase: DeviceAuthPhase;
  lines: readonly string[];
  message: string;
}

export interface DeviceAuthSession {
  cancel(): void;
}

/** A parsed OAuth token endpoint success body, handed to `toAccountRecord`. */
export interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

/**
 * A parsed pkce-loopback exchange response. OpenRouter's keys endpoint mints a
 * durable API key returned as `key`; the union keeps `access_token` too so a
 * provider whose PKCE exchange returns standard OAuth tokens can reuse the
 * engine without a new response type.
 */
export interface PkceExchangeResponse {
  /** OpenRouter: the provisioned `sk-or-...` API key. */
  key?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  [key: string]: unknown;
}

/** The two flow KINDs this engine speaks; `startDeviceAuth` branches on it. */
export type DeviceAuthKind = "device-code" | "pkce-loopback";

/** Fields shared by both flow kinds. */
export interface DeviceAuthProviderConfigBase {
  /** Provider id as `provider-status.ts` names it, e.g. "xai". */
  providerId: string;
  /** Requested scopes; joined with spaces into the `scope` parameter. */
  scopes: readonly string[];
}

/**
 * An RFC 8628 device-code provider. No behaviour lives here beyond
 * `toAccountRecord`, which turns a token response into the tagged store record;
 * everything else is the endpoints, the client id, and the scopes.
 */
export interface DeviceCodeProviderConfig extends DeviceAuthProviderConfigBase {
  kind: "device-code";
  /** RFC 8628 device authorization endpoint (where the device code is minted). */
  deviceCodeUrl: string;
  /** OAuth token endpoint polled for the access token. */
  tokenUrl: string;
  /** OAuth public client id for the device flow. */
  clientId: string;
  /** Builds the stored account record from a successful token response. */
  toAccountRecord(tokenResponse: DeviceTokenResponse): AccountRecord;
}

/**
 * An Authorization Code + PKCE provider driven through a loopback redirect
 * (RFC 7636 + RFC 8252). The engine mints a code_verifier/code_challenge, opens
 * the browser to `authorizeUrl` with the loopback `redirect_uri` and the S256
 * `code_challenge`, and exchanges the returned `code` (+ verifier) at `keysUrl`.
 */
export interface PkceLoopbackProviderConfig extends DeviceAuthProviderConfigBase {
  kind: "pkce-loopback";
  /** Authorization endpoint the browser is sent to; query params are appended. */
  authorizeUrl: string;
  /** Endpoint the `code` + `code_verifier` are POSTed to for the credential. */
  keysUrl: string;
  /**
   * Public client id, when the provider requires one. OpenRouter's PKCE is
   * CLIENT-ID-LESS, so it is omitted there and no `client_id` param is sent.
   */
  clientId?: string;
  /**
   * The authorize-URL query param that carries the loopback redirect URL.
   * Defaults to the standard `redirect_uri`; OpenRouter uses `callback_url`.
   */
  redirectParam?: string;
  /** Builds the stored account record from a successful exchange response. */
  toAccountRecord(exchange: PkceExchangeResponse): AccountRecord;
}

/**
 * The provider-specific data the generic engine needs, discriminated by `kind`.
 * `startDeviceAuth` accepts either and dispatches to the matching engine.
 */
export type DeviceAuthProviderConfig = DeviceCodeProviderConfig | PkceLoopbackProviderConfig;

/** A minimal fetch shape so tests can inject a transport without a full Response. */
export interface DeviceAuthResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DeviceAuthFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<DeviceAuthResponse>;

/** What the loopback redirect carried: the auth `code`, or an OAuth `error`. */
export interface LoopbackRedirect {
  code?: string;
  error?: string;
}

/**
 * A running loopback server. `port` is the actual bound port (the engine builds
 * the redirect URL from it); `close()` releases the socket and is called on
 * success, timeout, and cancel.
 */
export interface LoopbackServer {
  readonly port: number;
  close(): void;
}

/**
 * Stands up the loopback server. Injected so the whole pkce flow is unit-testable
 * offline: a test factory can synthesise a redirect and record `close()` without
 * a real socket. The default binds a `node:http` server to 127.0.0.1:0.
 */
export type LoopbackServerFactory = (options: {
  onRedirect: (redirect: LoopbackRedirect) => void;
}) => Promise<LoopbackServer>;

/** A PKCE code_verifier and its S256-derived code_challenge. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface StartDeviceAuthOptions {
  /** Environment mutated on success so `providerStates` flips immediately. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Credential-store home dir. Defaults to the real one; injected for tests. */
  homeDir?: string;
  /** Injected HTTP transport. Defaults to the global `fetch`. */
  fetch?: DeviceAuthFetch;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected delay. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected browser opener. Defaults to the shared `defaultOpenBrowser`. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** pkce-loopback only: injected loopback server. Defaults to a `node:http` server. */
  serverFactory?: LoopbackServerFactory;
  /** pkce-loopback only: injected PKCE pair generator, for deterministic tests. */
  createPkcePair?: () => PkcePair;
  onUpdate: (update: DeviceAuthUpdate) => void;
  onConnected: () => void;
}

/** The device-code endpoint response we care about (RFC 8628 §3.2). */
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

const defaultFetch: DeviceAuthFetch = (url, init) =>
  (globalThis.fetch as unknown as DeviceAuthFetch)(url, init);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Overall deadline for the single pkce-loopback redirect. */
const PKCE_TIMEOUT_SECONDS = 300;

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

/** RFC 7636: 32 random bytes → verifier; S256(verifier) → challenge, both base64url. */
const defaultCreatePkcePair = (): PkcePair => {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

/**
 * The default loopback server: a `node:http` server bound to an ephemeral port
 * on 127.0.0.1 that answers the single `/callback` GET, hands the browser a
 * "you can close this" page, and forwards the `code`/`error` query to the engine.
 */
const defaultServerFactory: LoopbackServerFactory = async ({ onRedirect }) => {
  let delivered = false;
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const code = requestUrl.searchParams.get("code") ?? undefined;
    const error = requestUrl.searchParams.get("error") ?? undefined;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<!doctype html><meta charset=utf-8><title>0sec</title><body>Sign-in complete — you can close this tab and return to 0sec.</body>");
    // Only the first redirect matters; ignore stray probes after it.
    if (delivered) return;
    delivered = true;
    onRedirect({ code, error });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => server.close() };
};

/** The operator-facing label for a provider id, falling back to the id itself. */
function providerLabel(providerId: string): string {
  return PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId;
}

/** A finite, positive integer or the fallback — server-supplied numbers are untrusted. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Starts a device-code sign-in for `config`. Returns immediately with a session
 * whose `cancel()` stops the flow; all progress is reported through `onUpdate`.
 */
export function startDeviceAuth(
  config: DeviceAuthProviderConfig,
  options: StartDeviceAuthOptions,
): DeviceAuthSession {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? defaultFetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const label = providerLabel(config.providerId);

  const lines: string[] = [];
  let settled = false;
  let cancelled = false;

  const pushLine = (text: string): void => {
    const value = sanitizeTuiText(text);
    if (value.length === 0) return;
    lines.push(value);
    if (lines.length > MAX_VISIBLE_LINES) lines.shift();
  };
  const publish = (phase: DeviceAuthPhase, message: string): void => {
    options.onUpdate({ phase, lines: [...lines], message });
  };
  const finish = (phase: DeviceAuthPhase, message: string): void => {
    if (settled) return;
    settled = true;
    publish(phase, message);
  };

  const requestDeviceCode = async (cfg: DeviceCodeProviderConfig): Promise<DeviceCodeResponse> => {
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      scope: cfg.scopes.join(" "),
    }).toString();
    const response = await doFetch(cfg.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!response.ok) {
      throw new Error(`Device code request failed (HTTP ${response.status}).`);
    }
    const parsed = await response.json();
    if (!isPlainObject(parsed) || typeof parsed.device_code !== "string" || typeof parsed.user_code !== "string") {
      throw new Error("Device code response was missing a device_code or user_code.");
    }
    const verificationUri =
      typeof parsed.verification_uri === "string"
        ? parsed.verification_uri
        : typeof parsed.verification_uri_complete === "string"
          ? parsed.verification_uri_complete
          : undefined;
    if (verificationUri === undefined) {
      throw new Error("Device code response was missing a verification URL.");
    }
    return {
      device_code: parsed.device_code,
      user_code: parsed.user_code,
      verification_uri: verificationUri,
      verification_uri_complete:
        typeof parsed.verification_uri_complete === "string" ? parsed.verification_uri_complete : undefined,
      interval: positiveInt(parsed.interval, DEFAULT_INTERVAL_SECONDS),
      expires_in: positiveInt(parsed.expires_in, DEFAULT_EXPIRES_IN_SECONDS),
    };
  };

  /** Poll the token endpoint once; returns the token response, or a control signal. */
  const pollTokenOnce = async (
    cfg: DeviceCodeProviderConfig,
    deviceCode: string,
  ): Promise<
    | { kind: "token"; response: DeviceTokenResponse }
    | { kind: "pending" }
    | { kind: "slow_down" }
    | { kind: "failed"; message: string }
  > => {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: cfg.clientId,
    }).toString();
    let response: DeviceAuthResponse;
    try {
      response = await doFetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
    } catch (error) {
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { kind: "failed", message: `Token response was not valid JSON (HTTP ${response.status}).` };
    }
    if (response.ok && isPlainObject(parsed) && typeof parsed.access_token === "string") {
      return { kind: "token", response: parsed as DeviceTokenResponse };
    }
    const oauthError = isPlainObject(parsed) && typeof parsed.error === "string" ? parsed.error : undefined;
    switch (oauthError) {
      case "authorization_pending":
        return { kind: "pending" };
      case "slow_down":
        return { kind: "slow_down" };
      case "expired_token":
        return { kind: "failed", message: `${label} device sign-in code expired. Start again.` };
      case "access_denied":
        return { kind: "failed", message: `${label} device sign-in was denied.` };
      default:
        return {
          kind: "failed",
          message: oauthError
            ? `${label} device sign-in failed: ${oauthError}.`
            : `${label} device sign-in failed (HTTP ${response.status}).`,
        };
    }
  };

  /**
   * The success tail shared by both flows: persist the record active, mirror it
   * into the live env (so `providerStates(env)` flips without a restart), and
   * announce it. `accountEnvPatch` keeps the env-wins rule so an explicit export
   * is never shadowed.
   */
  const persist = (record: AccountRecord, connectedMessage: string): void => {
    const { store } = addAccount(loadAccountStore(options.homeDir), config.providerId, record);
    saveAccountStore(store, options.homeDir);
    const patch = accountEnvPatch(store, env);
    for (const [key, value] of Object.entries(patch)) env[key] = value;
    finish("connected", connectedMessage);
    options.onConnected();
  };

  // ---- device-code flow (RFC 8628) ----------------------------------------
  const runDeviceCode = async (cfg: DeviceCodeProviderConfig): Promise<void> => {
    publish("running", `Starting ${label} device sign-in…`);

    let device: DeviceCodeResponse;
    try {
      device = await requestDeviceCode(cfg);
    } catch (error) {
      finish("failed", error instanceof Error ? error.message : String(error));
      return;
    }
    if (cancelled) {
      finish("cancelled", `${label} device sign-in cancelled.`);
      return;
    }

    const openUrl = device.verification_uri_complete ?? device.verification_uri;
    pushLine(`Enter code: ${device.user_code}`);
    pushLine(`Visit: ${device.verification_uri}`);
    publish("running", `Complete the ${label} device sign-in in your browser.`);
    try {
      await openBrowser(openUrl);
    } catch {
      pushLine("Could not open a browser automatically; open the URL above.");
      publish("running", `Complete the ${label} device sign-in in your browser.`);
    }

    let intervalSeconds = device.interval ?? DEFAULT_INTERVAL_SECONDS;
    const deadline = now() + (device.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;

    while (!cancelled) {
      await sleep(intervalSeconds * 1000);
      if (cancelled) break;
      if (now() >= deadline) {
        finish("failed", `${label} device sign-in timed out. Start again.`);
        return;
      }
      const result = await pollTokenOnce(cfg, device.device_code);
      if (cancelled) break;
      if (result.kind === "token") {
        persist(cfg.toAccountRecord(result.response), `${label} connected through device sign-in.`);
        return;
      }
      if (result.kind === "failed") {
        finish("failed", result.message);
        return;
      }
      if (result.kind === "slow_down") {
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
      }
    }
    finish("cancelled", `${label} device sign-in cancelled.`);
  };

  // ---- pkce-loopback flow (RFC 7636 + RFC 8252) ---------------------------
  /** POST the authorization code + verifier to the keys/token endpoint. */
  const exchangeCode = async (
    cfg: PkceLoopbackProviderConfig,
    code: string,
    verifier: string,
  ): Promise<{ kind: "ok"; response: PkceExchangeResponse } | { kind: "failed"; message: string }> => {
    let response: DeviceAuthResponse;
    try {
      response = await doFetch(cfg.keysUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier }),
      });
    } catch (error) {
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { kind: "failed", message: `${label} sign-in exchange was not valid JSON (HTTP ${response.status}).` };
    }
    if (!response.ok) {
      const oauthError = isPlainObject(parsed) && typeof parsed.error === "string" ? parsed.error : undefined;
      return {
        kind: "failed",
        message: oauthError
          ? `${label} browser sign-in failed: ${oauthError}.`
          : `${label} browser sign-in failed (HTTP ${response.status}).`,
      };
    }
    if (!isPlainObject(parsed)) {
      return { kind: "failed", message: `${label} sign-in exchange returned an unexpected body.` };
    }
    return { kind: "ok", response: parsed as PkceExchangeResponse };
  };

  const runPkceLoopback = async (cfg: PkceLoopbackProviderConfig): Promise<void> => {
    publish("running", `Starting ${label} browser sign-in…`);

    const { verifier, challenge } = (options.createPkcePair ?? defaultCreatePkcePair)();
    const serverFactory = options.serverFactory ?? defaultServerFactory;

    // A single settlement point raced by the redirect, cancel, and the timeout.
    type Outcome =
      | { type: "redirect"; redirect: LoopbackRedirect }
      | { type: "cancelled" }
      | { type: "timeout" };
    let resolveOutcome: (outcome: Outcome) => void = () => {};
    const outcomePromise = new Promise<Outcome>((resolve) => {
      resolveOutcome = resolve;
    });

    let server: LoopbackServer;
    try {
      server = await serverFactory({
        onRedirect: (redirect) => resolveOutcome({ type: "redirect", redirect }),
      });
    } catch (error) {
      finish("failed", `${label} browser sign-in could not start a local server: ${error instanceof Error ? error.message : String(error)}.`);
      return;
    }
    // cancelWaiter lets the returned cancel() unblock this flow; the socket is
    // then closed on exactly one path — the `server.close()` below — so cancel
    // never double-closes.
    cancelWaiter = () => resolveOutcome({ type: "cancelled" });
    if (cancelled) {
      server.close();
      finish("cancelled", `${label} browser sign-in cancelled.`);
      return;
    }

    const redirectUri = `http://localhost:${server.port}/callback`;
    const authorizeUrl = new URL(cfg.authorizeUrl);
    authorizeUrl.searchParams.set(cfg.redirectParam ?? "redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (cfg.clientId !== undefined) authorizeUrl.searchParams.set("client_id", cfg.clientId);
    if (cfg.scopes.length > 0) authorizeUrl.searchParams.set("scope", cfg.scopes.join(" "));
    const openUrl = authorizeUrl.toString();

    // Always surface the URL so a headless operator can open it by hand.
    pushLine(`Sign in at: ${openUrl}`);
    publish("running", `Complete the ${label} sign-in in your browser.`);
    try {
      await openBrowser(openUrl);
    } catch {
      pushLine("Could not open a browser automatically; open the URL above.");
      publish("running", `Complete the ${label} sign-in in your browser.`);
    }

    // Fire the timeout without blocking; whichever outcome lands first wins.
    void sleep(PKCE_TIMEOUT_SECONDS * 1000).then(() => resolveOutcome({ type: "timeout" }));

    const outcome = await outcomePromise;
    server.close();

    if (outcome.type === "cancelled" || cancelled) {
      finish("cancelled", `${label} browser sign-in cancelled.`);
      return;
    }
    if (outcome.type === "timeout") {
      finish("failed", `${label} browser sign-in timed out. Start again.`);
      return;
    }
    const { code, error } = outcome.redirect;
    if (error !== undefined) {
      finish("failed", `${label} browser sign-in was denied: ${error}.`);
      return;
    }
    if (code === undefined || code.length === 0) {
      finish("failed", `${label} browser sign-in did not return an authorization code.`);
      return;
    }

    const result = await exchangeCode(cfg, code, verifier);
    if (cancelled) {
      finish("cancelled", `${label} browser sign-in cancelled.`);
      return;
    }
    if (result.kind === "failed") {
      finish("failed", result.message);
      return;
    }
    let record: AccountRecord;
    try {
      record = cfg.toAccountRecord(result.response);
    } catch (error) {
      finish("failed", error instanceof Error ? error.message : String(error));
      return;
    }
    persist(record, `${label} connected through browser sign-in.`);
  };

  // Set by the pkce flow so cancel() can unblock its single awaited redirect.
  let cancelWaiter: (() => void) | undefined;

  void (config.kind === "pkce-loopback" ? runPkceLoopback(config) : runDeviceCode(config));

  return {
    cancel: () => {
      if (settled || cancelled) return;
      cancelled = true;
      // pkce-loopback: unblock the awaited redirect so the flow closes its own
      // socket on the single close path (avoids a double close); device-code
      // notices `cancelled` on its next loop turn.
      cancelWaiter?.();
    },
  };
}

/**
 * Per-provider browser sign-in configuration, discriminated by `kind`.
 *
 * ⚠️ UNVERIFIED ENDPOINTS/CLIENT IDS. Every URL and client id below was
 * assembled from research and has NOT been confirmed against a live account.
 * They must be verified with a real sign-in before this flow is trusted — an
 * unverified endpoint will fail at the first POST (device-code) or at the
 * loopback exchange (pkce), and the engine will report that as a "failed" phase
 * rather than silently mis-authenticating. Treat these as placeholders pending
 * a live-flow check.
 */
export const PROVIDER_DEVICE_AUTH: Record<string, DeviceAuthProviderConfig> = {
  // ⚠️ UNVERIFIED: confirm against a live xAI account before trusting.
  xai: {
    kind: "device-code",
    providerId: "xai",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: ["openid", "profile", "email", "offline_access", "api:access"],
    toAccountRecord: buildOAuthRecord,
  },
  // ⚠️ UNVERIFIED: confirm against a live Kimi (Moonshot) account before trusting.
  kimi: {
    kind: "device-code",
    providerId: "kimi",
    deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    scopes: ["openid", "profile", "email", "offline_access"],
    toAccountRecord: buildOAuthRecord,
  },
  // ⚠️ UNVERIFIED: OpenRouter PKCE browser sign-in. The authorize/keys URLs and
  // the client-id-less, `callback_url`-named redirect param are RESEARCH values
  // and must be confirmed against a live OpenRouter account before trusting.
  //
  // Flow: open https://openrouter.ai/auth?callback_url=<loopback>&code_challenge=<c>
  // &code_challenge_method=S256 (no client_id — OpenRouter's PKCE is CLIENT-ID-LESS),
  // then POST { code, code_verifier } to /api/v1/auth/keys, which PROVISIONS a
  // durable `sk-or-...` API key (NOT OAuth tokens). That key is stored as an
  // `api_key` record and written to OPENROUTER_API_KEY (envVars[0]) by
  // accountEnvPatch, which llm-api already reads — so no llm-api change.
  openrouter: {
    kind: "pkce-loopback",
    providerId: "openrouter",
    authorizeUrl: "https://openrouter.ai/auth",
    keysUrl: "https://openrouter.ai/api/v1/auth/keys",
    redirectParam: "callback_url",
    scopes: [],
    toAccountRecord: buildOpenRouterKeyRecord,
  },
};

/** Standard OAuth token response → an `oauth` account record. */
function buildOAuthRecord(tokenResponse: DeviceTokenResponse): AccountRecord {
  const tokens: OAuthTokens = {};
  if (typeof tokenResponse.access_token === "string") tokens.accessToken = tokenResponse.access_token;
  if (typeof tokenResponse.refresh_token === "string") tokens.refreshToken = tokenResponse.refresh_token;
  if (typeof tokenResponse.expires_in === "number" && Number.isFinite(tokenResponse.expires_in)) {
    tokens.expiresAt = Date.now() + tokenResponse.expires_in * 1000;
  }
  return { kind: "oauth", tokens };
}

/**
 * OpenRouter's keys exchange returns a provisioned, durable API key — not OAuth
 * tokens — so it is stored as an `api_key` record. accountEnvPatch then writes
 * `secret` to OPENROUTER_API_KEY (the provider's envVars[0]).
 *
 * ⚠️ UNVERIFIED: the `key` field name is a research value; confirm the real
 * response shape before trusting.
 */
function buildOpenRouterKeyRecord(exchange: PkceExchangeResponse): AccountRecord {
  const key = typeof exchange.key === "string" ? exchange.key : undefined;
  if (key === undefined || key.length === 0) {
    throw new Error("OpenRouter sign-in did not return an API key.");
  }
  return { kind: "api_key", secret: key };
}
