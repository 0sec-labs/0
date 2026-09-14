/**
 * A generic, in-process OAuth 2.0 Device Authorization Grant (RFC 8628) engine.
 *
 * This is the sibling of `codex-device-auth.ts`, but it is a different KIND of
 * thing. `codex-device-auth.ts` is a SUBPROCESS orchestrator: it spawns
 * `codex login --device-auth` and scrapes its stdout, because Codex owns the
 * ChatGPT protocol and 0sec must not reimplement it. This module, by contrast,
 * speaks the device-code protocol itself — it POSTs the device-code endpoint,
 * opens the browser, and polls the token endpoint — for providers that expose a
 * standard RFC 8628 flow and have no CLI of their own to lean on.
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
 * The provider-specific data the generic engine needs. No behaviour lives here
 * beyond `toAccountRecord`, which turns a token response into the tagged store
 * record; everything else is the endpoints, the client id, and the scopes.
 */
export interface DeviceAuthProviderConfig {
  /** Provider id as `provider-status.ts` names it, e.g. "xai". */
  providerId: string;
  /** RFC 8628 device authorization endpoint (where the device code is minted). */
  deviceCodeUrl: string;
  /** OAuth token endpoint polled for the access token. */
  tokenUrl: string;
  /** OAuth public client id for the device flow. */
  clientId: string;
  /** Requested scopes; joined with spaces into the `scope` parameter. */
  scopes: readonly string[];
  /** Builds the stored account record from a successful token response. */
  toAccountRecord(tokenResponse: DeviceTokenResponse): AccountRecord;
}

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

  const requestDeviceCode = async (): Promise<DeviceCodeResponse> => {
    const body = new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    }).toString();
    const response = await doFetch(config.deviceCodeUrl, {
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
      client_id: config.clientId,
    }).toString();
    let response: DeviceAuthResponse;
    try {
      response = await doFetch(config.tokenUrl, {
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

  const persistAndConnect = (tokenResponse: DeviceTokenResponse): void => {
    const record = config.toAccountRecord(tokenResponse);
    const { store } = addAccount(loadAccountStore(options.homeDir), config.providerId, record);
    saveAccountStore(store, options.homeDir);
    // Mirror the Codex flow: mutate the live env so `providerStates(env)` shows
    // the provider connected without waiting for a restart. `accountEnvPatch`
    // keeps the env-wins rule, so an explicit export is never shadowed.
    const patch = accountEnvPatch(store, env);
    for (const [key, value] of Object.entries(patch)) env[key] = value;
    finish("connected", `${label} connected through device sign-in.`);
    options.onConnected();
  };

  const run = async (): Promise<void> => {
    publish("running", `Starting ${label} device sign-in…`);

    let device: DeviceCodeResponse;
    try {
      device = await requestDeviceCode();
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
      const result = await pollTokenOnce(device.device_code);
      if (cancelled) break;
      if (result.kind === "token") {
        persistAndConnect(result.response);
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

  void run();

  return {
    cancel: () => {
      if (settled || cancelled) return;
      cancelled = true;
    },
  };
}

/**
 * Per-provider device-code configuration.
 *
 * ⚠️ UNVERIFIED ENDPOINTS/CLIENT IDS. The `deviceCodeUrl`, `tokenUrl`, and
 * `clientId` values below were assembled from research and have NOT been
 * confirmed against a live xAI or Kimi account. They must be verified with a
 * real sign-in before this flow is trusted — an unverified client id or
 * endpoint will fail at the device-code POST, and the engine will report that
 * as a "failed" phase rather than silently mis-authenticating. Treat these as
 * placeholders pending a live-flow check.
 */
export const PROVIDER_DEVICE_AUTH: Record<string, DeviceAuthProviderConfig> = {
  // ⚠️ UNVERIFIED: confirm against a live xAI account before trusting.
  xai: {
    providerId: "xai",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: ["openid", "profile", "email", "offline_access", "api:access"],
    toAccountRecord: buildOAuthRecord,
  },
  // ⚠️ UNVERIFIED: confirm against a live Kimi (Moonshot) account before trusting.
  kimi: {
    providerId: "kimi",
    deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    scopes: ["openid", "profile", "email", "offline_access"],
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
