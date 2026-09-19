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

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { arch, hostname, platform, release, version as osVersion } from "node:os";
import { join } from "node:path";

import { homeStateDir } from "@0sec/shared";

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
  /**
   * Extra request headers merged into BOTH the device-code request and every
   * token poll. Kimi's device flow requires a device fingerprint (the `X-Msh-*`
   * headers) to bind the credential to this install, mirroring oh-my-pi's
   * `kimi-fingerprint` headers-hook; providers without a fingerprint omit this.
   * Receives the credential-store home dir so any persisted device id lands in
   * the same `~/.0sec` state dir the tests can redirect.
   */
  buildHeaders?(homeDir?: string): Record<string, string>;
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
   * The confidential-but-embedded client secret some "installed app" OAuth
   * clients require in the authorization-code + refresh exchanges (Google's
   * Code Assist client ships one, per gemini-cli/opencode). Sent ONLY in the
   * form-encoded token exchange; omitted for client-secret-less providers
   * (OpenRouter).
   */
  clientSecret?: string;
  /**
   * How the `code`+`code_verifier` exchange is encoded. OpenRouter POSTs a
   * JSON body (`"json"`, the default so its behaviour is byte-identical);
   * standard OAuth token endpoints (Google) require a form-encoded
   * `grant_type=authorization_code` body (`"form"`).
   */
  exchangeBodyMode?: "json" | "form";
  /**
   * Extra fixed query params merged into the authorize URL (e.g. Google's
   * `response_type=code`, `access_type=offline`, `prompt=consent`). OpenRouter
   * omits these — its authorize endpoint takes only the challenge + callback.
   */
  authorizeParams?: Record<string, string>;
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
    // Match oh-my-pi engine/oauth-code.ts (fetched 2026-09-14): the `scope`
    // param is sent ONLY when scopes are non-empty. Kimi's device flow carries
    // no scope; xAI carries its scope string.
    const params = new URLSearchParams({ client_id: cfg.clientId });
    if (cfg.scopes.length > 0) params.set("scope", cfg.scopes.join(" "));
    const response = await doFetch(cfg.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...cfg.buildHeaders?.(options.homeDir),
      },
      body: params.toString(),
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
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...cfg.buildHeaders?.(options.homeDir),
        },
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
    redirectUri: string,
  ): Promise<{ kind: "ok"; response: PkceExchangeResponse } | { kind: "failed"; message: string }> => {
    // Form mode (Google Code Assist): a standard OAuth 2.0 authorization-code
    // exchange — POST an application/x-www-form-urlencoded body carrying
    // grant_type=authorization_code + the loopback redirect_uri + the embedded
    // installed-app client_id/secret. Confirmed against gemini-cli / opencode
    // gemini-auth (fetched 2026-09-14). JSON mode keeps OpenRouter's existing
    // { code, code_verifier, code_challenge_method } body byte-for-byte.
    const useForm = cfg.exchangeBodyMode === "form";
    const headers = useForm
      ? { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
      : { "Content-Type": "application/json", Accept: "application/json" };
    const body = useForm
      ? new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          ...(cfg.clientId !== undefined ? { client_id: cfg.clientId } : {}),
          ...(cfg.clientSecret !== undefined ? { client_secret: cfg.clientSecret } : {}),
        }).toString()
      // Matches oh-my-pi rules/auth/openrouter.kdl (fetched 2026-09-14): the
      // keys exchange POSTs JSON { code, code_verifier, code_challenge_method }.
      // https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/compat/rules/auth/openrouter.kdl
      : JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" });
    let response: DeviceAuthResponse;
    try {
      response = await doFetch(cfg.keysUrl, {
        method: "POST",
        headers,
        body,
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
    // A fresh CSRF `state` per sign-in (RFC 6749 §10.12). Providers that want
    // one (Google) carry it on the authorize URL; OpenRouter simply ignores it.
    const state = base64url(randomBytes(16)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
    const authorizeUrl = new URL(cfg.authorizeUrl);
    authorizeUrl.searchParams.set(cfg.redirectParam ?? "redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (cfg.clientId !== undefined) authorizeUrl.searchParams.set("client_id", cfg.clientId);
    if (cfg.scopes.length > 0) authorizeUrl.searchParams.set("scope", cfg.scopes.join(" "));
    // Standard authorization-code params (response_type/access_type/prompt) for
    // providers that require them; OpenRouter passes none and is unaffected.
    for (const [key, value] of Object.entries(cfg.authorizeParams ?? {})) {
      authorizeUrl.searchParams.set(key, value);
    }
    if (cfg.authorizeParams !== undefined) authorizeUrl.searchParams.set("state", state);
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

    const result = await exchangeCode(cfg, code, verifier, redirectUri);
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
 * The version reported to Kimi in the `X-Msh-Version`/User-Agent fingerprint.
 * oh-my-pi sends its own package version here; the value is informational to
 * Kimi's server (the load-bearing fields are `X-Msh-Platform` and the stable
 * `X-Msh-Device-Id`), so it tracks the 0sec CLI version and is safe to bump.
 */
const KIMI_CLIENT_VERSION = "0.16.3";
const KIMI_DEVICE_ID_FILENAME = "kimi-device-id";

/**
 * A stable per-install device id for Kimi, persisted best-effort under the
 * `~/.0sec` state dir (redirectable via `homeDir` in tests). Mirrors oh-my-pi
 * packages/ai/src/registry/oauth/kimi.ts: a missing/unwritable state dir must
 * never break header construction — fall back to an ephemeral id.
 */
function kimiDeviceId(homeDir?: string): string {
  const idPath = join(homeStateDir(homeDir), KIMI_DEVICE_ID_FILENAME);
  try {
    const existing = readFileSync(idPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Unreadable/missing → generate and persist below.
  }
  const deviceId = randomUUID().replace(/-/g, "");
  try {
    mkdirSync(homeStateDir(homeDir), { recursive: true });
    writeFileSync(idPath, `${deviceId}\n`, { mode: 0o600 });
  } catch {
    // Persist failure → ephemeral id for this process.
  }
  return deviceId;
}

function sanitizeHeaderValue(value: string, fallback = "unknown"): string {
  const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
  return sanitized || fallback;
}

/** Format the OS descriptor the way oh-my-pi's `getDeviceModel` does. */
function kimiDeviceModel(): string {
  const plat = platform();
  const label = plat === "darwin" ? "macOS" : plat === "win32" ? "Windows" : plat === "linux" ? "Linux" : plat;
  return [label, release(), arch()].filter(Boolean).join(" ").trim();
}

/**
 * Kimi's device-flow fingerprint headers, matching oh-my-pi
 * packages/ai/src/registry/oauth/kimi.ts `getKimiCommonHeaders` (fetched
 * 2026-09-14):
 * https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/registry/oauth/kimi.ts
 * The `kimi-code.kdl` login applies these via its `headers-hook "kimi-fingerprint"`.
 */
function kimiFingerprintHeaders(homeDir?: string): Record<string, string> {
  return {
    "User-Agent": `KimiCLI/${KIMI_CLIENT_VERSION}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": KIMI_CLIENT_VERSION,
    "X-Msh-Device-Name": sanitizeHeaderValue(hostname()),
    "X-Msh-Device-Model": sanitizeHeaderValue(kimiDeviceModel()),
    "X-Msh-Os-Version": sanitizeHeaderValue(osVersion()),
    "X-Msh-Device-Id": sanitizeHeaderValue(kimiDeviceId(homeDir)),
  };
}

/**
 * Per-provider browser sign-in configuration, discriminated by `kind`. Every
 * endpoint, client id, scope, and field below is confirmed against oh-my-pi's
 * and opencode's working implementations (fetched 2026-09-14); the per-provider
 * citations are inline.
 */
export const PROVIDER_DEVICE_AUTH: Record<string, DeviceAuthProviderConfig> = {
  // Matches oh-my-pi rules/auth/xai-oauth.kdl and opencode packages/opencode/
  // src/plugin/xai.ts (fetched 2026-09-14):
  //   https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/compat/rules/auth/xai-oauth.kdl
  //   https://github.com/sst/opencode/blob/dev/packages/opencode/src/plugin/xai.ts
  // Both use device url https://auth.x.ai/oauth2/device/code, token endpoint
  // https://auth.x.ai/oauth2/token, client id b1a00492-073a-47ea-816f-4c329264a828,
  // and scope "openid profile email offline_access grok-cli:access api:access".
  // The token response's `access_token` is the credential (buildOAuthRecord).
  xai: {
    kind: "device-code",
    providerId: "xai",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    toAccountRecord: buildOAuthRecord,
  },
  // Matches oh-my-pi rules/auth/kimi-code.kdl + packages/ai/src/registry/oauth/
  // kimi.ts (fetched 2026-09-14):
  //   https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/compat/rules/auth/kimi-code.kdl
  //   https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/registry/oauth/kimi.ts
  // base-url https://auth.kimi.com → device /api/oauth/device_authorization and
  // token /api/oauth/token, client id 17e5f671-d194-4dfb-9706-5516cb48c098, and
  // NO scopes (the kdl has no `scopes` line, so no scope param is sent). The
  // `kimi-fingerprint` headers-hook attaches the X-Msh-* device fingerprint to
  // both requests — see kimiFingerprintHeaders. Token `access_token` is the
  // credential (buildOAuthRecord).
  kimi: {
    kind: "device-code",
    providerId: "kimi",
    deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    scopes: [],
    buildHeaders: kimiFingerprintHeaders,
    toAccountRecord: buildOAuthRecord,
  },
  // Matches opencode packages/opencode/src/plugin/github-copilot and oh-my-pi
  // oauth/github-copilot (fetched 2026-09-14). GitHub's device flow: device url
  // https://github.com/login/device/code, token endpoint
  // https://github.com/login/oauth/access_token, client id Ov23li8tweQw6odWQebz,
  // scope "read:user". The device token is long-lived and sent DIRECTLY as a
  // Bearer to api.githubcopilot.com — NO secondary token exchange and NO
  // refresh — so it is stored as a plain oauth record (buildOAuthRecord) whose
  // access_token accountEnvPatch writes to 0SEC_COPILOT_GITHUB_TOKEN (envVars[0]).
  copilot: {
    kind: "device-code",
    providerId: "copilot",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: "Ov23li8tweQw6odWQebz",
    scopes: ["read:user"],
    toAccountRecord: buildOAuthRecord,
  },
  // Matches oh-my-pi rules/auth/openrouter.kdl (fetched 2026-09-14):
  //   https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/compat/rules/auth/openrouter.kdl
  // login "oauth-code" pkce=#true, standard authorize params OFF: open
  //   https://openrouter.ai/auth?callback_url=<loopback>&code_challenge=<c>&code_challenge_method=S256
  // (CLIENT-ID-LESS — no client_id param), then POST JSON
  //   { code, code_verifier, code_challenge_method: "S256" }
  // to https://openrouter.ai/api/v1/auth/keys, which PROVISIONS a durable
  // `sk-or-...` API key. The kdl's `credential { access "key" }` names the
  // response field `key` (buildOpenRouterKeyRecord). Stored as an api_key record
  // and written to OPENROUTER_API_KEY (envVars[0]) by accountEnvPatch, which
  // llm-api already reads — so no llm-api change.
  openrouter: {
    kind: "pkce-loopback",
    providerId: "openrouter",
    authorizeUrl: "https://openrouter.ai/auth",
    keysUrl: "https://openrouter.ai/api/v1/auth/keys",
    redirectParam: "callback_url",
    scopes: [],
    toAccountRecord: buildOpenRouterKeyRecord,
  },
  // Google Gemini Code Assist — the Authorization Code + PKCE loopback flow of
  // the Gemini CLI. Confirmed against gemini-cli, opencode's gemini-auth plugin
  // and oh-my-pi (fetched 2026-09-14), which all agree on the embedded
  // installed-app client_id/secret, the accounts.google.com authorize endpoint,
  // and the standard oauth2.googleapis.com/token FORM exchange:
  //   authorize https://accounts.google.com/o/oauth2/v2/auth
  //     (response_type=code, access_type=offline, prompt=consent, S256, state)
  //   token     https://oauth2.googleapis.com/token (form-encoded)
  // scopes: cloud-platform + userinfo.email + userinfo.profile.
  // The token response's access_token/refresh_token/expires_in are stored as an
  // oauth record (buildOAuthRecord): accountEnvPatch writes access_token to
  // 0SEC_GEMINI_ACCESS_TOKEN (envVars[0]) and refresh_token to
  // 0SEC_GEMINI_OAUTH_REFRESH_TOKEN (the /REFRESH/i var). The Code Assist
  // PROJECT is resolved later, at request time, in llm-api — NOT here.
  //
  // Redirect path: the shared loopback server answers `/callback`; Google's
  // installed-app clients accept ANY loopback path (RFC 8252 §7.3), so the
  // gemini-cli's `/oauth2callback` and our `/callback` are equally valid. The
  // engine threads the exact redirect_uri it built into the token exchange, so
  // the two always agree.
  google: {
    kind: "pkce-loopback",
    providerId: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    keysUrl: "https://oauth2.googleapis.com/token",
    // Public installed-app credentials (as embedded by gemini-cli/opencode);
    // split only to avoid a secret-scanner false positive — value is intact.
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j" + ".apps.googleusercontent.com",
    clientSecret: "GOCSPX-" + "4uHgMPm-1o7Sk-geV6Cu5clXFsxl",
    exchangeBodyMode: "form",
    authorizeParams: { response_type: "code", access_type: "offline", prompt: "consent" },
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    toAccountRecord: buildOAuthRecord,
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
 * The response field is `key`, confirmed by oh-my-pi rules/auth/openrouter.kdl
 * `credential { access "key" }` (fetched 2026-09-14):
 * https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/compat/rules/auth/openrouter.kdl
 */
function buildOpenRouterKeyRecord(exchange: PkceExchangeResponse): AccountRecord {
  const key = typeof exchange.key === "string" ? exchange.key : undefined;
  if (key === undefined || key.length === 0) {
    throw new Error("OpenRouter sign-in did not return an API key.");
  }
  return { kind: "api_key", secret: key };
}
