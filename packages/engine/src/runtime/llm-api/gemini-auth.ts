import { CODE_ASSIST_API_VERSION, CODE_ASSIST_ENDPOINT, GEMINI_CLI_VERSION, GEMINI_OAUTH_CLIENT_ID, GEMINI_OAUTH_CLIENT_SECRET, GEMINI_OAUTH_TOKEN_URL } from "./provider-config.js";

export interface GeminiCodeAssistAuthState {
  /** Client captured with this exact credential; omitted only for legacy imports. */
  oauthClient?: { clientId: string; clientSecret?: string };
  /** Long-lived Google refresh token; empty when only an access token was forwarded. */
  refreshToken: string;
  accessToken?: string;
  /** ms-since-epoch deadline; refresh when within 5 min of this. */
  accessTokenExpiresAt: number;
  /** Refresh singleflight — concurrent callers await this same promise. */
  inflightRefresh?: Promise<void>;
  /**
   * Resolved Code Assist project id. `""` = the free tier (project omitted from
   * requests). `undefined` = not yet resolved. Cached for the process lifetime;
   * an env override (GOOGLE_CLOUD_PROJECT / ZERO_GEMINI_PROJECT) short-circuits.
   */
  projectId?: string;
  /** Project-resolution singleflight. */
  inflightProjectResolve?: Promise<string>;
}

/** Share the refresh/project singleflights only among identical credentials. */
export const geminiCodeAssistAuthStates = new Map<string, GeminiCodeAssistAuthState>();

export function geminiAuthStateKey(refreshToken: string, accessToken: string | undefined, oauthClient?: GeminiCodeAssistAuthState["oauthClient"]): string {
  return JSON.stringify([refreshToken, refreshToken ? undefined : accessToken, oauthClient]);
}

/** Reset credential-scoped Gemini Code Assist auth state (test isolation). */
export function __resetGeminiCodeAssistAuthStateForTests(): void {
  geminiCodeAssistAuthStates.clear();
}

export function readGeminiCodeAssistEnv(env: Readonly<NodeJS.ProcessEnv> = process.env):
  | { accessToken?: string; refreshToken?: string; oauthClient?: GeminiCodeAssistAuthState["oauthClient"] }
  | undefined {
  const access = env["ZERO_GEMINI_ACCESS_TOKEN"];
  const refresh = env["ZERO_GEMINI_OAUTH_REFRESH_TOKEN"];
  if ((!access || access.length === 0) && (!refresh || refresh.length === 0)) return undefined;
  const clientId = env["ZERO_GEMINI_OAUTH_CLIENT_ID"]?.trim();
  const clientSecret = env["ZERO_GEMINI_OAUTH_CLIENT_SECRET"]?.trim();
  if (!clientId && clientSecret) throw new Error("Google OAuth client secret requires its matching client ID");
  return {
    ...(clientId ? { oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } } : {}),
    accessToken: access && access.length > 0 ? access : undefined,
    refreshToken: refresh && refresh.length > 0 ? refresh : undefined,
  };
}

export function resolveGeminiCodeAssistAuthState(env: Readonly<NodeJS.ProcessEnv>): GeminiCodeAssistAuthState {
  const tokens = readGeminiCodeAssistEnv(env);
  if (!tokens) {
    throw new Error(
      "Google Gemini Code Assist auth: neither ZERO_GEMINI_ACCESS_TOKEN nor " +
        "ZERO_GEMINI_OAUTH_REFRESH_TOKEN is set. Sign in with your Google " +
        "account (0 connect) or forward a fresh access token.",
    );
  }
  const key = geminiAuthStateKey(tokens.refreshToken ?? "", tokens.accessToken, tokens.oauthClient);
  const existing = geminiCodeAssistAuthStates.get(key);
  if (existing) return existing;
  const state: GeminiCodeAssistAuthState = {
    oauthClient: tokens.oauthClient,
    refreshToken: tokens.refreshToken ?? "",
    accessToken: tokens.accessToken,
    // A forwarded access token with no `exp` we can read: treat as immediately
    // stale so the first call refreshes (when a refresh token is available).
    accessTokenExpiresAt: tokens.accessToken && tokens.refreshToken ? 0 : tokens.accessToken ? Date.now() + 3600_000 : 0,
  };
  geminiCodeAssistAuthStates.set(key, state);
  return state;
}

export interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

export async function refreshGoogleAccessToken(refreshToken: string, oauthClient?: GeminiCodeAssistAuthState["oauthClient"]): Promise<GoogleTokenResponse> {
  const res = await fetch(GEMINI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: oauthClient?.clientId ?? GEMINI_OAUTH_CLIENT_ID,
      ...((oauthClient ? oauthClient.clientSecret : GEMINI_OAUTH_CLIENT_SECRET) ? { client_secret: (oauthClient ? oauthClient.clientSecret : GEMINI_OAUTH_CLIENT_SECRET)! } : {}),
    }).toString(),
  });
  const bodyText = await res.text().catch(() => "");
  let parsed: GoogleTokenResponse = {};
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as GoogleTokenResponse) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    // A permanently invalid grant (revoked / already-invalidated token) must
    // wipe the cached state so a re-login is forced rather than replayed.
    const err = new Error(`Google token refresh failed (HTTP ${res.status}${parsed.error === "invalid_grant" ? ": invalid_grant; reconnect this account" : ""})`);
    (err as { invalidGrant?: boolean }).invalidGrant = parsed.error === "invalid_grant";
    throw err;
  }
  return parsed;
}

/**
 * Return a fresh Google access token for the state, refreshing (once, under a
 * singleflight) when the cached token is missing or within 5 min of expiry.
 * Mirrors refreshChatGptCodexAuthState.
 */
export async function refreshGeminiCodeAssistAuthState(state: GeminiCodeAssistAuthState): Promise<string> {
  const now = Date.now();
  const needsRefresh = !state.accessToken || state.accessTokenExpiresAt - 300_000 <= now;
  if (needsRefresh && !state.refreshToken) {
    if (state.accessToken) return state.accessToken; // forwarded token, no refresh capability
    throw new Error("Google Gemini Code Assist auth: no access or refresh token available.");
  }
  if (needsRefresh) {
    if (!state.inflightRefresh) {
      const usedRefresh = state.refreshToken;
      state.inflightRefresh = (async () => {
        try {
          const tokens = await refreshGoogleAccessToken(usedRefresh, state.oauthClient);
          if (!tokens.access_token) throw new Error("Google token refresh returned no access_token.");
          state.accessToken = tokens.access_token;
          state.accessTokenExpiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
          // Google normally keeps the same refresh token; honour a rotated one.
          if (tokens.refresh_token) state.refreshToken = tokens.refresh_token;
        } catch (err) {
          if ((err as { invalidGrant?: boolean }).invalidGrant) {
            // Wipe every cache entry for this dead credential so nothing replays it.
            state.accessToken = undefined;
            state.accessTokenExpiresAt = 0;
            geminiCodeAssistAuthStates.delete(geminiAuthStateKey(state.refreshToken, state.accessToken, state.oauthClient));
          }
          throw err;
        } finally {
          state.inflightRefresh = undefined;
        }
      })();
    }
    await state.inflightRefresh;
  }
  if (!state.accessToken) {
    throw new Error("Google Gemini Code Assist auth: access token unset after refresh.");
  }
  return state.accessToken;
}

export const GEMINI_CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;

/** POST a Code Assist control-plane method (loadCodeAssist / onboardUser). */
export async function codeAssistPost(
  method: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(`Code Assist ${method} failed: ${res.status} ${text.slice(0, 200)}`);
    (err as { securityPolicyViolated?: boolean }).securityPolicyViolated = text.includes("SECURITY_POLICY_VIOLATED");
    throw err;
  }
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve (and cache) the Code Assist project id for this credential.
 * Precedence: env override → an already-provisioned project on the account →
 * the default tier's onboarding (free tier resolves to `""`). Runs under a
 * singleflight so concurrent turns share one loadCodeAssist/onboardUser cycle.
 */
export async function resolveGeminiCodeAssistProject(
  state: GeminiCodeAssistAuthState,
  env: Readonly<NodeJS.ProcessEnv>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  if (state.projectId !== undefined) return state.projectId;
  if (state.inflightProjectResolve) return state.inflightProjectResolve;
  state.inflightProjectResolve = (async () => {
    try {
      const override = firstNonEmptyEnv(env, "GOOGLE_CLOUD_PROJECT", "ZERO_GEMINI_PROJECT");
      const accessToken = await refreshGeminiCodeAssistAuthState(state);

      let load: Record<string, unknown>;
      try {
        load = await codeAssistPost("loadCodeAssist", accessToken, {
          ...(override ? { cloudaicompanionProject: override } : {}),
          metadata: GEMINI_CODE_ASSIST_METADATA,
        });
      } catch (err) {
        // VPC-SC (SECURITY_POLICY_VIOLATED): the account is on the standard tier
        // behind a service perimeter — the project MUST come from the env.
        if ((err as { securityPolicyViolated?: boolean }).securityPolicyViolated) {
          if (override) return override;
          throw new Error(
            "Google Gemini Code Assist: this account is behind a VPC Service " +
              "Controls perimeter — set GOOGLE_CLOUD_PROJECT (or ZERO_GEMINI_PROJECT).",
          );
        }
        throw err;
      }

      // Already provisioned (standard/paid account with a bound project).
      const bound = load.cloudaicompanionProject;
      if (typeof bound === "string" && bound.length > 0) return bound;

      // Pick the default tier and whether it defines its own project.
      const tiers = Array.isArray(load.allowedTiers) ? (load.allowedTiers as Array<Record<string, unknown>>) : [];
      const defaultTier = tiers.find((tier) => tier.isDefault === true);
      const currentTier = load.currentTier as Record<string, unknown> | undefined;
      const tierId = (currentTier?.id as string | undefined) ?? (defaultTier?.id as string | undefined) ?? "free-tier";
      const tierForProject = currentTier ?? defaultTier;
      const isFreeTier =
        tierForProject?.userDefinedCloudaicompanionProject === false || tierId === "free-tier";
      const onboardProject = isFreeTier ? undefined : override;

      // onboardUser returns a long-running operation; poll it until done.
      let op = await codeAssistPost("onboardUser", accessToken, {
        tierId,
        ...(onboardProject ? { cloudaicompanionProject: onboardProject } : {}),
        metadata: GEMINI_CODE_ASSIST_METADATA,
      });
      let guard = 0;
      while (op.done !== true && guard < 60) {
        const opName = typeof op.name === "string" ? op.name : undefined;
        if (!opName) break;
        await sleep(5000);
        const opRes = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}/${opName}`, {
          headers: { Authorization: `Bearer ${await refreshGeminiCodeAssistAuthState(state)}` },
        });
        const opText = await opRes.text().catch(() => "");
        if (!opRes.ok) throw new Error(`Code Assist onboard poll failed: ${opRes.status} ${opText.slice(0, 200)}`);
        op = opText ? (JSON.parse(opText) as Record<string, unknown>) : {};
        guard += 1;
      }
      const response = op.response as Record<string, unknown> | undefined;
      const project = response?.cloudaicompanionProject as Record<string, unknown> | string | undefined;
      const resolved =
        typeof project === "string"
          ? project
          : typeof project?.id === "string"
            ? (project.id as string)
            : undefined;
      // Free tier: no project — resolve to "" (omitted from every request body).
      return resolved && resolved.length > 0 ? resolved : (override ?? "");
    } finally {
      state.inflightProjectResolve = undefined;
    }
  })();
  const resolved = await state.inflightProjectResolve;
  state.projectId = resolved;
  return resolved;
}

export function firstNonEmptyEnv(env: Readonly<NodeJS.ProcessEnv>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** The User-Agent Code Assist gates its subscription quota on. */
export function geminiUserAgent(model: string): string {
  return `GeminiCLI/${GEMINI_CLI_VERSION} (${process.platform}; ${process.arch}) ${model}`;
}
