import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_ISSUER } from "./provider-config.js";

export interface CodexTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface ChatGptCodexAuthState {
  refreshToken: string;
  accountId?: string;
  accessToken?: string;
  /** ms-since-epoch deadline; refresh when within 60s of this. */
  accessTokenExpiresAt: number;
  /**
   * Singleflight handle. When a refresh is in flight, concurrent
   * callers await this same Promise instead of triggering parallel
   * refresh calls. Cleared (set to undefined) when the refresh
   * settles — pass or fail. Critical because OpenAI's refresh
   * endpoint rotates the refresh_token itself on every call: two
   * concurrent refreshes can persist a stale token + lock the user
   * out. See opencode codex.ts:431-447 (which lacks this guard —
   * gets away with it via single-request architecture).
   */
  inflightRefresh?: Promise<void>;
  /**
   * Path to the `~/.codex/auth.json` the tokens were loaded from, when they came
   * from disk (local CLI/TUI path) rather than an env-forwarded access token
   * (worker-controller/cloud path). Set → the rotated refresh_token is written
   * back on every refresh so the NEXT process doesn't replay an already-used
   * token and 401. Undefined for the env-forwarded path (nothing to persist).
   */
  authFilePath?: string;
}

/** Share refresh singleflight only among identical credential sources, never accounts. */
export const chatGptCodexAuthStates = new Map<string, ChatGptCodexAuthState>();

export function codexAuthStateKey(state: Pick<ChatGptCodexAuthState, "authFilePath" | "accountId" | "refreshToken" | "accessToken">): string {
  return JSON.stringify([state.authFilePath, state.accountId, state.refreshToken || state.accessToken]);
}

/** Reset credential-scoped Codex auth state (test isolation). */
export function __resetChatGptCodexAuthStateForTests(): void {
  chatGptCodexAuthStates.clear();
}

export function readChatGptCodexEnv(env: Readonly<NodeJS.ProcessEnv> = process.env):
  | { accessToken?: string; refreshToken?: string; accountId?: string }
  | undefined {
  const access = env["ZERO_CHATGPT_ACCESS_TOKEN"];
  const refresh = env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
  if ((!access || access.length === 0) && (!refresh || refresh.length === 0)) {
    return undefined;
  }
  const accountId = env["ZERO_CHATGPT_ACCOUNT_ID"];
  return {
    accessToken: access && access.length > 0 ? access : undefined,
    refreshToken: refresh && refresh.length > 0 ? refresh : undefined,
    accountId,
  };
}

/** Resolve the codex auth.json path (env override or the default `~/.codex`). */
export function resolveChatGptCodexAuthPath(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return env["ZERO_CODEX_AUTH_JSON_PATH"] ?? join(env.HOME ?? homedir(), ".codex", "auth.json");
}

/**
 * Persist a refreshed token set back to `~/.codex/auth.json`, preserving every
 * other field the file carries (e.g. `OPENAI_API_KEY`, unrelated `tokens.*`).
 * OpenAI ROTATES the refresh_token on every refresh, so the on-disk copy becomes
 * single-use-spent the instant we refresh; writing the new one back is what keeps
 * the NEXT `0`/`codex` process from replaying an already-used token
 * and hitting a 401. Mirrors the codex CLI's own auth.json write-back.
 *
 * Atomic (temp-file + rename) and 0600, so a concurrent reader never sees a
 * half-written credential file. Best-effort: a write failure is logged and
 * swallowed — the in-memory token still works for THIS process; only the next
 * process would need a re-login.
 */
export function persistChatGptCodexAuthFile(authPath: string, tokens: CodexTokenResponse, usedRefreshToken: string): void {
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
    const prevTokens =
      (existing.tokens as Record<string, unknown> | undefined) ?? {};
    // A different login or logout must not be overwritten by an older runtime.
    if (prevTokens.refresh_token !== usedRefreshToken) return;
    const nextTokens: Record<string, unknown> = {
      ...prevTokens,
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
    };
    const merged = {
      ...existing,
      tokens: nextTokens,
      last_refresh: new Date().toISOString(),
    };
    const tmp = `${authPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, authPath);
  } catch (err) {
    // Non-fatal: the refresh already succeeded for this process.
    process.stderr.write(
      `[0] warning: could not persist rotated Codex refresh token to ${authPath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

export function readChatGptCodexAuthFile(env: Readonly<NodeJS.ProcessEnv> = process.env):
  | { accessToken?: string; refreshToken?: string; accountId?: string }
  | undefined {
  const authPath = resolveChatGptCodexAuthPath(env);
  if (!existsSync(authPath)) return undefined;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
      tokens?: {
        access_token?: unknown;
        refresh_token?: unknown;
        account_id?: unknown;
      };
    };
    const tokens = auth.tokens;
    if (!tokens) return undefined;
    const accessToken = typeof tokens.access_token === "string" && tokens.access_token.length > 0
      ? tokens.access_token
      : undefined;
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
      ? tokens.refresh_token
      : undefined;
    if (!accessToken && !refreshToken) return undefined;
    return {
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof tokens.account_id === "string" && tokens.account_id.length > 0
        ? { accountId: tokens.account_id }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Pull the `exp` (seconds since epoch) claim out of an OpenAI-issued
 * JWT and return it as ms-since-epoch. Used when a pre-issued
 * access_token arrives via `ZERO_CHATGPT_ACCESS_TOKEN` so we know
 * when it stops working — typically ~1h from issuance.
 *
 * Falls back to a default-1h-from-now estimate when the token isn't a
 * recognisable JWT (defensive — should never happen for OpenAI's
 * tokens). The fallback means a worker forwarding a malformed token
 * still gets ~1h of usage before we throw on expiry, instead of
 * refusing to start.
 */
export function accessTokenExpiryMs(accessToken: string): number {
  const claims = parseJwtPayload(accessToken);
  const exp = claims?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    return exp * 1000;
  }
  return Date.now() + 3600_000;
}

export async function refreshChatGptCodexAccessToken(refreshToken: string): Promise<CodexTokenResponse> {
  const res = await fetch(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ChatGPT Codex token refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as CodexTokenResponse;
}

/** Parse a JWT payload (no signature verification — we trust our auth.json). */
export function parseJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

export function extractChatGptAccountId(tokens: CodexTokenResponse): string | undefined {
  const checkClaims = (claims: Record<string, unknown>): string | undefined => {
    if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id;
    const authClaim = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    if (typeof authClaim.chatgpt_account_id === "string") return authClaim.chatgpt_account_id;
    const orgs = claims.organizations;
    if (Array.isArray(orgs) && orgs.length > 0 && orgs[0] && typeof orgs[0] === "object") {
      const id = (orgs[0] as { id?: unknown }).id;
      if (typeof id === "string") return id;
    }
    return undefined;
  };
  for (const tok of [tokens.id_token, tokens.access_token]) {
    if (!tok) continue;
    const claims = parseJwtPayload(tok);
    if (claims) {
      const id = checkClaims(claims);
      if (id) return id;
    }
  }
  return undefined;
}

/**
 * Return a fresh access_token for the chatgpt-codex provider. Caches the
 * token until ~60s before expiry, refreshing on demand. Throws if the
 * refresh fails OR if ZERO_CHATGPT_OAUTH_REFRESH_TOKEN is unset.
 *
 * Exported so callers outside the runtime (e.g. one-off cli probes)
 * can bootstrap a token with the same logic.
 */
export async function getChatGptCodexAccessToken(env: Readonly<NodeJS.ProcessEnv> = process.env): Promise<{
  accessToken: string;
  accountId?: string;
}> {
  return refreshChatGptCodexAuthState(resolveChatGptCodexAuthState(env));
}

export function resolveChatGptCodexAuthState(env: Readonly<NodeJS.ProcessEnv>): ChatGptCodexAuthState {
  const fromEnvOnly = readChatGptCodexEnv(env);
  const fromFile = fromEnvOnly ? undefined : readChatGptCodexAuthFile(env);
  const tokens = fromEnvOnly ?? fromFile;
  if (!tokens) {
    throw new Error(
      "ChatGPT Codex auth: neither ZERO_CHATGPT_ACCESS_TOKEN nor " +
        "ZERO_CHATGPT_OAUTH_REFRESH_TOKEN is set. Run `codex login` and " +
        "either forward the access token via worker-controller (preferred " +
        "for multi-sandbox dispatch — avoids the OAuth refresh-token " +
        "rotation race) or keep a valid ~/.codex/auth.json on this host.",
    );
  }
  const identity = {
    refreshToken: tokens.refreshToken ?? "",
    accessToken: tokens.accessToken,
    accountId: tokens.accountId ?? (tokens.accessToken
      ? extractChatGptAccountId({ access_token: tokens.accessToken } as CodexTokenResponse)
      : undefined),
    ...(fromFile ? { authFilePath: resolveChatGptCodexAuthPath(env) } : {}),
  };
  const key = codexAuthStateKey(identity);
  const existing = chatGptCodexAuthStates.get(key);
  if (existing) return existing;
  const state: ChatGptCodexAuthState = {
    ...identity,
    accessTokenExpiresAt: tokens.accessToken ? accessTokenExpiryMs(tokens.accessToken) : 0,
  };
  chatGptCodexAuthStates.set(key, state);
  return state;
}

export async function refreshChatGptCodexAuthState(state: ChatGptCodexAuthState): Promise<{
  accessToken: string;
  accountId?: string;
}> {
  const now = Date.now();
  // Refresh if we have no token or we're within 60s of expiry.
  const needsRefresh =
    !state.accessToken || state.accessTokenExpiresAt - 60_000 <= now;
  if (needsRefresh && !state.refreshToken) {
    // Forwarded-access-token-only path (typical for E2B sandboxes
    // dispatched from worker-controller). No refresh capability. If the
    // token has expired, the sandbox should be torn down and the
    // controller should dispatch a fresh one with a new token.
    throw new Error(
      "ChatGPT Codex access token expired and no refresh token is " +
        "available. The worker-controller should forward a fresh " +
        "access token at sandbox dispatch.",
    );
  }
  if (needsRefresh) {
    // Singleflight: if a refresh is already in flight, await it. The
    // first concurrent caller wins; the others piggyback on the same
    // refresh response without firing duplicate POSTs.
    if (!state.inflightRefresh) {
      const usedRefresh = state.refreshToken;
      state.inflightRefresh = (async () => {
        try {
          const tokens = await refreshChatGptCodexAccessToken(usedRefresh);
          state.accessToken = tokens.access_token;
          state.accessTokenExpiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
          // Refresh token rotates on every call. Persist the new one
          // immediately or the old one becomes invalid and future
          // refreshes 401 ("refresh token has already been used").
          if (tokens.refresh_token) {
            state.refreshToken = tokens.refresh_token;
            // Write the rotation back to ~/.codex/auth.json on the local
            // CLI/TUI path (authFilePath set). Without this, the NEXT
            // `0`/`codex` process re-reads the now-spent token
            // from disk and 401s on its first call — the exact failure the
            // operator hit. The env-forwarded cloud path has authFilePath
            // undefined and is left to the worker-controller.
            if (state.authFilePath) {
              persistChatGptCodexAuthFile(state.authFilePath, tokens, usedRefresh);
            }
          }
          if (!state.accountId) {
            state.accountId = extractChatGptAccountId(tokens);
          }
          // A new runtime may read the rotated file while an existing runtime
          // still holds its original credential snapshot. Both share singleflight.
          chatGptCodexAuthStates.set(codexAuthStateKey(state), state);
        } finally {
          // Always clear so the next refresh-needed check can fire
          // again — even on failure (e.g. transient 5xx). The caller
          // sees the rejected promise and handles it.
          state.inflightRefresh = undefined;
        }
      })();
    }
    await state.inflightRefresh;
  }
  if (!state.accessToken) {
    throw new Error("ChatGPT Codex auth: access token still unset after refresh — refresh must have failed.");
  }
  return { accessToken: state.accessToken, accountId: state.accountId };
}

// ── Google Gemini Code Assist auth + project resolution ────────────────────
//
// Two independent singleflights per credential, mirroring the chatgpt-codex
// state machine: (a) OAuth access-token refresh, (b) Code Assist project
// resolution. Both are cached on the shared state so concurrent turns coalesce
// onto one network round-trip.
