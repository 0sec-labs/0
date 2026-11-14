import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Injection seams so the loader is testable without mutating the real env/home. */
interface CodexAuthOptions {
  /** Environment to read AND write. Defaults to the live `process.env`. */
  env?: Record<string, string | undefined>;
  /** Home directory used for the default `~/.codex/auth.json` path. */
  home?: string;
  /**
   * Explicit OAuth reconnect may replace stale process-local ChatGPT tokens
   * with the newly written Codex auth file. Normal startup preserves shell
   * exports as before.
   */
  force?: boolean;
}

/**
 * Override for the codex auth-file path, shared with the engine runtime. The
 * former `ZERO_CHATGPT_AUTH_FILE` spelling is mapped onto this name at process
 * entry by `applyEnvAliases()` (see engine config/deprecated-env.ts).
 */
const AUTH_FILE_ENV = "ZERO_CODEX_AUTH_JSON_PATH";

// Track only values this module loaded into this exact environment object.
// A shell export, stored account, or captured chat env is never inferred to be file-backed.
const bootstrapped = new WeakMap<Record<string, string | undefined>, { access?: string; refresh?: string }>();

/**
 * Local-dev convenience: when no ChatGPT-Codex token is in the env but the
 * user has run `codex login` (so `~/.codex/auth.json` exists), plumb its
 * tokens into `ZERO_CHATGPT_*` — the same wiring the cloud
 * worker-controller does for sandbox runs.
 *
 * The engine's provider priority (`llm-api.ts` detectProvider) ranks
 * `chatgpt-codex` HIGHEST, above `AZURE_OPENAI_API_KEY` / `OPENAI_API_KEY`.
 * So loading the codex token here means a logged-in `codex` session wins over
 * stale Azure/OpenAI keys left in a dev shell — `0 review` "just works"
 * on the subscription backend instead of silently falling through to a dead
 * Azure endpoint.
 *
 * Path precedence: `ZERO_CODEX_AUTH_JSON_PATH` ?? `~/.codex/auth.json`.
 *
 * Explicit `ZERO_CHATGPT_*` tokens win. Tokens this loader placed in the same
 * env can follow a newer CLI login; existing runtime snapshots stay unchanged.
 * No-op if the auth file is absent/unreadable. Best-effort: any failure
 * leaves the env untouched and the engine falls back to other providers.
 */
export function maybeLoadCodexAuth(options: CodexAuthOptions = {}): void {
  const env = options.env ?? process.env;
  const prior = bootstrapped.get(env);
  const fileBacked = prior !== undefined &&
    env.ZERO_CHATGPT_ACCESS_TOKEN === prior.access &&
    env.ZERO_CHATGPT_OAUTH_REFRESH_TOKEN === prior.refresh;
  if (prior && !fileBacked) bootstrapped.delete(env);
  if (
    !options.force && !fileBacked &&
    (
      env["ZERO_CHATGPT_ACCESS_TOKEN"] ||
      env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]
    )
  ) {
    return;
  }
  const home = options.home ?? homedir();
  // An exported-but-empty override is not a path: fall through to the next
  // candidate rather than stat'ing "" and giving up on the default.
  const override = nonEmpty(env[AUTH_FILE_ENV]);
  const path = override ?? join(home, ".codex", "auth.json");
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      tokens?: { access_token?: unknown; refresh_token?: unknown };
    };
    // A hand-edited auth.json can carry a null/number/object where a token
    // string belongs; narrow rather than trusting the cast, so a junk value
    // never lands in the env as "null" and gets sent as a bearer.
    const accessToken = nonEmpty(asString(raw.tokens?.access_token));
    const refreshToken = nonEmpty(asString(raw.tokens?.refresh_token));
    if (!accessToken && !refreshToken) return;
    if (options.force || fileBacked) {
      delete env["ZERO_CHATGPT_ACCESS_TOKEN"];
      delete env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
    }
    if (accessToken) {
      env["ZERO_CHATGPT_ACCESS_TOKEN"] = accessToken;
    }
    if (refreshToken) {
      env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] = refreshToken;
    }
    bootstrapped.set(env, { access: accessToken, refresh: refreshToken });
  } catch {
    // best-effort only — leave env untouched, engine falls back to other providers
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
