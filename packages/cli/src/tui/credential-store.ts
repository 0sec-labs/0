/**
 * Per-provider LLM credentials, persisted to `~/.0/credentials.json`.
 *
 * The runtime resolves provider credentials from environment variables only
 * (see `provider-status.ts`, transcribed from `llm-api.ts`). That is fine for
 * a shell with the right exports and hostile to everyone else: an operator who
 * has not exported the variable gets a turn that dies with zero tokens, and
 * the fix — an export that survives the next terminal — lives outside the
 * tool. This module is the durable side of that. The console can write a key
 * here once; `credentialEnvPatch` turns the file back into the env additions
 * the runtime already knows how to read, so nothing downstream has to learn a
 * second credential source.
 *
 * `PROVIDERS` is imported, never re-derived. Several providers deviate from
 * the `<VENDOR>_API_KEY` pattern and one is OAuth rather than an API key; a
 * second copy of that table here would drift from the runtime silently, which
 * for credentials means writing a secret into a variable nobody reads.
 *
 * This file holds secrets, so three rules are absolute and each is enforced
 * below rather than left to callers:
 *
 *   1. On-disk artefacts are owner-only — 0600 for the file, 0700 for the
 *      directory — and are re-tightened on every save, not just at creation.
 *   2. An explicit shell export always beats the file. The store is a
 *      convenience for the unconfigured case; it may never quietly shadow a
 *      credential the operator chose in their environment.
 *   3. Nothing here prints. Not to stdout, not to stderr, not on an error
 *      path — this runs inside a TUI that owns the terminal, and the values
 *      involved are exactly the ones that must never reach a scrollback
 *      buffer or a CI log. `redactSecret` exists so display code has a safe
 *      option; the raw values leave this module only through the env patch.
 *
 * Like the settings store next door, I/O failure is reported as a return
 * value: a read-only `$HOME` is an inconvenience, not a reason to lose the
 * console.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { homeStateDir } from "@0/shared"

import { PROVIDERS, providerSupportsMethod } from "./provider-status.js";

/**
 * The legacy flat credential map: `providerId -> api-key secret`.
 *
 * This is the v0 shape and remains the public type for the API-key-only
 * helpers (`loadCredentials` / `saveCredentials` / `credentialEnvPatch`) that
 * existing callers depend on. Under the hood the file is now the richer
 * {@link AccountStore} (tagged api_key/oauth records, multiple accounts per
 * provider); these helpers project the active API-key account down to this
 * flat view and upsert back into it, so old and new callers share one file.
 */
export interface StoredCredentials {
  /** providerId -> secret value. */
  [providerId: string]: string;
}

/** Basename of the credential file inside the 0sec state directory. */
const CREDENTIALS_FILENAME = "credentials.json";

/** Owner-only: nobody else on the machine has business reading this file. */
const FILE_MODE = 0o600;
/**
 * Owner-only on the directory too. A 0600 file inside a 0755 directory still
 * leaks its existence and its size to every local account, and a directory
 * that is group- or world-*writable* would let another account replace the
 * file wholesale — a credential swap, not just a disclosure.
 */
const DIR_MODE = 0o700;

/**
 * Credentials live beside the rest of the per-user engine state (scan DB,
 * journals, TUI settings) rather than in a bespoke directory, so
 * `homeStateDir` from `@0/shared` — not a local `".0"` literal — decides
 * where that is. One definition of the state root means a future relocation or
 * an `$XDG_STATE_HOME` migration happens in one place.
 */
export function credentialsFilePath(homeDir?: string): string {
  return join(homeStateDir(homeDir), CREDENTIALS_FILENAME);
}

/**
 * Providers the generic flat key store is allowed to persist. Keyed off
 * `methods` (not the scalar `auth`), so a provider that leads with OAuth but
 * still ACCEPTS an API key — e.g. xai/kimi are `["oauth","api-key"]` — keeps
 * its api-key round-trip through the flat store. Using `auth === "api-key"`
 * here would silently drop those providers' pasted keys on the next save.
 */
const STORABLE_PROVIDER_IDS = new Set(
  PROVIDERS.filter((provider) => provider.methods.includes("api-key")).map((provider) => provider.id),
);

/**
 * An exported-but-empty value is the classic way credentials break: `export
 * ANTHROPIC_API_KEY=` in a shell profile, or a CI secret that resolved to the
 * empty string, leaves the name present while carrying nothing. Whitespace-only
 * is the same story — a stray newline from `$(cat key.txt)` is not a key.
 * `provider-status.ts` applies exactly this test when deciding whether a
 * provider is configured, and the two must agree or the console will report a
 * provider as dark while this module happily declines to fill it.
 */
function hasCredential(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Total, pure coercion of anything at all into a usable credential map.
 *
 * The file is hand-editable and therefore corruptible, but the stakes here are
 * higher than for display settings: a malformed entry must degrade to "this
 * provider is unconfigured", never to a key written into the wrong variable.
 * So an entry survives only if its id is a provider the runtime knows and its
 * value is a non-blank string. Unknown ids are dropped rather than carried
 * through, which also means a hand-added `"__proto__"` or `"constructor"` key
 * cannot reach the assignment below.
 *
 * Values are trimmed on the way in: whitespace around a pasted key is an
 * artefact of the paste, and leaving it would produce a credential that looks
 * present everywhere in the UI while failing every request.
 */
export function normalizeCredentials(raw: unknown): StoredCredentials {
  const out: StoredCredentials = {};
  // Arrays and `null` are typeof "object" too; neither can carry provider
  // entries, and treating them as an empty bag is the wanted "nothing is
  // configured" outcome rather than a special case that throws.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;

  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!STORABLE_PROVIDER_IDS.has(providerId)) continue;
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret.length === 0) continue;
    out[providerId] = secret;
  }
  return out;
}

/**
 * Loads stored credentials, or nothing at all. Never throws and never reports:
 * a missing file is the common case (the operator has never used the credential
 * UI), and an unreadable or malformed one degrades to "no stored credentials",
 * which the console already knows how to render — the provider simply shows as
 * unconfigured and the operator can re-enter the key.
 *
 * Deliberately silent on failure: the obvious diagnostic here would be to
 * report what could not be parsed, and the thing that could not be parsed is a
 * file full of secrets.
 */
export function loadCredentials(homeDir?: string): StoredCredentials {
  // Delegates to the account store so a key written through the new API — or
  // migrated forward from the old flat file — is still visible to the old
  // callers. Only the active API-key account of each provider projects down;
  // OAuth accounts have no representation in a `providerId -> string` map and
  // are deliberately invisible here (see `accountEnvPatch` for those).
  return projectApiKeys(loadAccountStore(homeDir));
}

/**
 * Persists credentials with owner-only permissions, reporting success as a
 * return value rather than an exception.
 *
 * Permissions are applied twice on purpose. The `mode` option on `writeFileSync`
 * and `mkdirSync` only takes effect when the entry is *created*, and even then
 * it is masked by the process umask; an existing world-readable file — left by
 * an older build, a restored backup, or a hand-edit — would keep its loose mode
 * silently. The explicit `chmodSync` calls therefore run unconditionally, so
 * every save is also a repair. `mode` on the create path still matters: it
 * closes the window between "file exists with the default mode" and "chmod
 * lands", during which the secret would be readable.
 *
 * The payload is normalised on the way out, so a caller cannot persist an
 * unknown provider or a blank value, and pretty-printed with a trailing
 * newline to stay diffable for an operator who does open it.
 */
export function saveCredentials(creds: StoredCredentials, homeDir?: string): boolean {
  // Replaces the API-key layer of the store from the flat map while preserving
  // every OAuth account already on disk: the old callers only know how to
  // manage keys, so a save from them must never silently drop a subscription
  // login. `normalizeCredentials` still guards the input — an unknown provider
  // or blank value cannot reach disk through this path either.
  const store = loadAccountStore(homeDir);
  const desired = normalizeCredentials(creds);
  return saveAccountStore(replaceApiKeyLayer(store, desired), homeDir);
}

/** The active API-key account of every provider, as the legacy flat map. */
function projectApiKeys(store: AccountStore): StoredCredentials {
  const out: StoredCredentials = {};
  for (const providerId of Object.keys(store.providers)) {
    const record = getActiveAccount(store, providerId);
    if (record?.kind === "api_key") out[providerId] = record.secret;
  }
  return out;
}

/**
 * A new store whose API-key accounts are exactly `desired`, with every OAuth
 * account (and its active pointer) carried over untouched. Pure over `store`.
 */
function replaceApiKeyLayer(store: AccountStore, desired: StoredCredentials): AccountStore {
  const providers: Record<string, ProviderAccounts> = {};

  // Keep only the non-API-key accounts of each existing provider.
  for (const [providerId, entry] of Object.entries(store.providers)) {
    const kept: Record<string, AccountRecord> = {};
    for (const [accountId, record] of Object.entries(entry.accounts)) {
      if (record.kind !== "api_key") kept[accountId] = record;
    }
    const keptIds = Object.keys(kept);
    if (keptIds.length === 0) continue;
    const active =
      entry.activeAccountId !== undefined && kept[entry.activeAccountId] !== undefined
        ? entry.activeAccountId
        : keptIds[0];
    providers[providerId] = { activeAccountId: active, accounts: kept };
  }

  // Overlay the desired API keys as the active account of each provider.
  for (const [providerId, secret] of Object.entries(desired)) {
    const existing = providers[providerId];
    const accounts: Record<string, AccountRecord> = existing ? { ...existing.accounts } : {};
    accounts[DEFAULT_ACCOUNT_ID] = { kind: "api_key", secret };
    providers[providerId] = { activeAccountId: DEFAULT_ACCOUNT_ID, accounts };
  }

  return { version: STORE_VERSION, providers };
}

/**
 * The environment additions implied by the store — the bridge between a file
 * the runtime does not read and the variables it does.
 *
 * Precedence is the whole point: a variable already carrying a credential in
 * `env` is never touched. An `export` in the current shell is an explicit,
 * deliberate act, and a stored key silently overriding it would make "which
 * key did that run use?" unanswerable — exactly the question you need answered
 * when a request 401s or when a metered key racks up spend. An exported-but-
 * empty variable is treated as absent, matching `provider-status.ts`: it is a
 * broken export, not a choice.
 *
 * The check spans *all* of a provider's variables, not just the one we would
 * write. A parent process that supplied `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN`
 * already configured that provider; injecting a stored access token alongside
 * it would mix credentials from two sources into one auth attempt, and the
 * runtime prefers ours — which is precisely the silent override this rule forbids.
 *
 * When we do fill, we fill `envVars[0]`: that list is ordered by the runtime's
 * own preference, so the first entry is the variable it actually reads first.
 *
 * Pure over its arguments — no `process.env` read, no mutation of either input.
 * Callers merge the result themselves and can therefore preview a patch, log
 * its *keys*, or apply it to a child process rather than this one.
 */
export function credentialEnvPatch(
  creds: StoredCredentials,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const stored = normalizeCredentials(creds);
  const patch: Record<string, string> = {};

  for (const info of PROVIDERS) {
    const secret = stored[info.id];
    if (secret === undefined) continue;
    if (info.envVars.some((name) => hasCredential(env[name]))) continue;
    const target = info.envVars[0];
    // A provider with no env vars cannot be configured this way at all; the
    // table has none today, but the guard keeps a future file-only provider
    // from producing an `undefined` key.
    if (target === undefined) continue;
    patch[target] = secret;
  }

  return patch;
}

/**
 * Fixed-width mask. Constant regardless of the input so the redacted form
 * leaks neither the secret nor its length — key length alone narrows down
 * which provider or key format is in play.
 */
const MASK = "••••••••";
/** How many trailing characters identify a key to the person who pasted it. */
const TAIL = 4;
/** How much leading context ("sk-ant-") is useful without being a key. */
const PREFIX = 6;
/** Below this, even four trailing characters is a third of the secret. */
const MIN_LENGTH_FOR_TAIL = 12;
/** Below this, prefix plus tail would expose more than half the secret. */
const MIN_LENGTH_FOR_PREFIX = 20;

/**
 * Display form of a secret, e.g. `sk-ant-…a4f2`. Never returns the input.
 *
 * The purpose is recognition, not verification: enough for an operator to tell
 * "the key I pasted" from "the key from last month" over a shoulder-surfable
 * terminal, and not enough to reconstruct anything. Short inputs are masked
 * outright — a four-character value has no safe fraction to reveal, and the
 * lengths that show up short are typos and truncated pastes, which the
 * operator diagnoses by re-entering rather than by reading back.
 */
export function redactSecret(secret: string): string {
  // Defensive against a `any`-typed caller as much as a blank value: the
  // failure mode of a wrong branch here is a printed secret.
  const value = typeof secret === "string" ? secret.trim() : "";
  if (value.length < MIN_LENGTH_FOR_TAIL) return MASK;

  const tail = value.slice(-TAIL);
  if (value.length < MIN_LENGTH_FOR_PREFIX) return `${MASK}${tail}`;
  return `${value.slice(0, PREFIX)}…${tail}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Account store (v2)
 *
 * The generalized credential model the login feature builds on. The same
 * `credentials.json` now holds a tagged record per account — an API key OR a
 * set of OAuth tokens — and can hold MORE THAN ONE account per provider with
 * one marked active. v1 UIs may only ever write a single account, but the
 * schema and this read/write surface support N so the multi-account UX and the
 * CLI account commands can be added without another migration.
 *
 * Every invariant of the flat store above is preserved here: 0600/0700 with an
 * unconditional re-chmod on save, total never-throws parsing that degrades a
 * corrupt or hand-mangled file to an empty store, a prototype-pollution guard
 * on every id, and nothing is ever printed (`redactSecret` is the only safe
 * way to surface a value). Secrets and tokens leave this module only through
 * the env patch.
 * ──────────────────────────────────────────────────────────────────────── */

/** The on-disk schema version. Bumped only when the shape changes again. */
const STORE_VERSION = 2 as const;

/** Account id used for the implicit single account (e.g. a pasted API key). */
const DEFAULT_ACCOUNT_ID = "default";

/** OAuth tokens for one account. At least one of the two tokens is present. */
export interface OAuthTokens {
  /**
   * The bearer token the runtime sends. Optional because a refresh-only
   * account is valid — an expired access token can be dropped and re-minted
   * from `refreshToken` at call time (this is how `chatgpt-codex` behaves).
   */
  accessToken?: string;
  /** Long-lived token used to mint a fresh access token. */
  refreshToken?: string;
  /** Absolute expiry of `accessToken`, epoch milliseconds. */
  expiresAt?: number;
  /** e.g. "Bearer". */
  tokenType?: string;
  /** Granted scopes, provider-defined. */
  scope?: string;
}

/** Optional human/provider identity for an account, for display and matching. */
export interface AccountIdentity {
  /** Operator-facing name for the account, e.g. an email or workspace. */
  label?: string;
  /** Provider's own stable id for the account, when it exposes one. */
  accountId?: string;
  /** Login email, when known. */
  email?: string;
}

/**
 * One stored credential, tagged by kind. `api_key` carries a bare secret;
 * `oauth` carries tokens plus an optional identity. A record's kind must be a
 * method the provider actually supports (`provider-status.ts` `methods`), which
 * is why the store refuses, for example, an `oauth` record under `anthropic`.
 */
export type AccountRecord =
  | { kind: "api_key"; secret: string }
  | { kind: "oauth"; tokens: OAuthTokens; identity?: AccountIdentity };

/** All accounts for one provider, with the active one named. */
export interface ProviderAccounts {
  /** Which account `getActiveAccount` returns; always references an existing key. */
  activeAccountId?: string;
  /** accountId -> record. */
  accounts: Record<string, AccountRecord>;
}

/** The whole store: one {@link ProviderAccounts} per provider that has any. */
export interface AccountStore {
  version: typeof STORE_VERSION;
  providers: Record<string, ProviderAccounts>;
}

/** Provider ids the store will persist — every provider the runtime can reach. */
const KNOWN_PROVIDER_IDS = new Set(PROVIDERS.map((provider) => provider.id));

/** An empty, valid store. A fresh function each call so no shared mutable state. */
function emptyStore(): AccountStore {
  return { version: STORE_VERSION, providers: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rejects the keys that let a hand-edited file reach `Object.prototype`. Applied
 * to every provider id and account id before it is used as an index — the same
 * defence the flat `normalizeCredentials` gets for free by whitelisting ids.
 */
function isSafeKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Total coercion of anything into valid OAuth tokens, or `undefined`. */
function normalizeTokens(raw: unknown): OAuthTokens | undefined {
  if (!isPlainObject(raw)) return undefined;
  const tokens: OAuthTokens = {};
  const accessToken = trimmedString(raw.accessToken);
  const refreshToken = trimmedString(raw.refreshToken);
  if (accessToken !== undefined) tokens.accessToken = accessToken;
  if (refreshToken !== undefined) tokens.refreshToken = refreshToken;
  // A token record with neither token configures nothing and is dropped.
  if (tokens.accessToken === undefined && tokens.refreshToken === undefined) return undefined;
  if (typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt)) tokens.expiresAt = raw.expiresAt;
  const tokenType = trimmedString(raw.tokenType);
  if (tokenType !== undefined) tokens.tokenType = tokenType;
  const scope = trimmedString(raw.scope);
  if (scope !== undefined) tokens.scope = scope;
  return tokens;
}

/** Total coercion of anything into an identity, or `undefined` when empty. */
function normalizeIdentity(raw: unknown): AccountIdentity | undefined {
  if (!isPlainObject(raw)) return undefined;
  const identity: AccountIdentity = {};
  const label = trimmedString(raw.label);
  const accountId = trimmedString(raw.accountId);
  const email = trimmedString(raw.email);
  if (label !== undefined) identity.label = label;
  if (accountId !== undefined) identity.accountId = accountId;
  if (email !== undefined) identity.email = email;
  return Object.keys(identity).length > 0 ? identity : undefined;
}

/**
 * Total coercion of anything into one valid record for `providerId`, or
 * `undefined`. A record survives only if its kind is a method the provider
 * supports and its payload is usable — the same "degrade to unconfigured,
 * never mis-route a secret" rule the flat store applies to values.
 */
function normalizeRecord(providerId: string, raw: unknown): AccountRecord | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.kind === "api_key") {
    if (!providerSupportsMethod(providerId, "api-key")) return undefined;
    const secret = trimmedString(raw.secret);
    return secret === undefined ? undefined : { kind: "api_key", secret };
  }
  if (raw.kind === "oauth") {
    if (!providerSupportsMethod(providerId, "oauth")) return undefined;
    const tokens = normalizeTokens(raw.tokens);
    if (tokens === undefined) return undefined;
    const identity = normalizeIdentity(raw.identity);
    return identity === undefined ? { kind: "oauth", tokens } : { kind: "oauth", tokens, identity };
  }
  return undefined;
}

function normalizeProviderAccounts(providerId: string, raw: unknown): ProviderAccounts | undefined {
  if (!isPlainObject(raw)) return undefined;
  const accountsRaw = isPlainObject(raw.accounts) ? raw.accounts : {};
  const accounts: Record<string, AccountRecord> = {};
  for (const [accountId, recordRaw] of Object.entries(accountsRaw)) {
    if (!isSafeKey(accountId)) continue;
    const record = normalizeRecord(providerId, recordRaw);
    if (record !== undefined) accounts[accountId] = record;
  }
  const ids = Object.keys(accounts);
  if (ids.length === 0) return undefined;
  // The active pointer must name a surviving account; otherwise fall back to
  // the first, so `getActiveAccount` can never return undefined for a provider
  // that has accounts.
  const active =
    typeof raw.activeAccountId === "string" && accounts[raw.activeAccountId] !== undefined
      ? raw.activeAccountId
      : ids[0];
  return { activeAccountId: active, accounts };
}

/**
 * Total, pure coercion of anything into an {@link AccountStore}.
 *
 * Accepts both shapes: the v2 object (`{ providers: {...} }`, optionally
 * `version`) and the legacy flat map (`{ providerId: "key" }`), which it
 * migrates forward to a single `api_key` account per provider. Anything else —
 * an array, a string, a number, garbage — degrades to an empty store rather
 * than throwing, exactly like the flat `normalizeCredentials`.
 */
export function normalizeAccountStore(raw: unknown): AccountStore {
  if (!isPlainObject(raw)) return emptyStore();

  const looksV2 = isPlainObject(raw.providers) || raw.version !== undefined;
  const store = emptyStore();

  if (looksV2) {
    const providersRaw = isPlainObject(raw.providers) ? raw.providers : {};
    for (const [providerId, entry] of Object.entries(providersRaw)) {
      if (!isSafeKey(providerId) || !KNOWN_PROVIDER_IDS.has(providerId)) continue;
      const accounts = normalizeProviderAccounts(providerId, entry);
      if (accounts !== undefined) store.providers[providerId] = accounts;
    }
    return store;
  }

  // Legacy flat migration: reuse the flat normalizer so id-whitelisting,
  // trimming, blank-dropping and the prototype guard are applied identically.
  for (const [providerId, secret] of Object.entries(normalizeCredentials(raw))) {
    store.providers[providerId] = {
      activeAccountId: DEFAULT_ACCOUNT_ID,
      accounts: { [DEFAULT_ACCOUNT_ID]: { kind: "api_key", secret } },
    };
  }
  return store;
}

/**
 * Loads the account store, migrating an old flat file forward on the way in.
 * Never throws and never reports: a missing, unreadable or corrupt file
 * degrades to an empty store, and the console renders every provider as
 * unconfigured — the same silent-on-failure contract as `loadCredentials`.
 */
export function loadAccountStore(homeDir?: string): AccountStore {
  try {
    const text = readFileSync(credentialsFilePath(homeDir), "utf8");
    return normalizeAccountStore(JSON.parse(text));
  } catch {
    return emptyStore();
  }
}

/**
 * Persists the account store with owner-only permissions, normalising on the
 * way out so a malformed record cannot reach disk. Permissions are applied on
 * create AND re-chmodded unconditionally, so every save repairs a file left
 * loose by an older build or a hand-edit. Reports success as a return value.
 */
export function saveAccountStore(store: AccountStore, homeDir?: string): boolean {
  try {
    const path = credentialsFilePath(homeDir);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
    writeFileSync(path, `${JSON.stringify(normalizeAccountStore(store), null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    chmodSync(path, FILE_MODE);
    return true;
  } catch {
    return false;
  }
}

/** The active record for a provider, or undefined if it has no accounts. */
export function getActiveAccount(store: AccountStore, providerId: string): AccountRecord | undefined {
  const entry = store.providers[providerId];
  if (entry === undefined) return undefined;
  const id = entry.activeAccountId;
  if (id !== undefined && entry.accounts[id] !== undefined) return entry.accounts[id];
  const first = Object.keys(entry.accounts)[0];
  return first === undefined ? undefined : entry.accounts[first];
}

/** One entry per account for a provider, marking which is active. */
export function listAccounts(
  store: AccountStore,
  providerId: string,
): { accountId: string; record: AccountRecord; active: boolean }[] {
  const entry = store.providers[providerId];
  if (entry === undefined) return [];
  return Object.entries(entry.accounts).map(([accountId, record]) => ({
    accountId,
    record,
    active: accountId === entry.activeAccountId,
  }));
}

/**
 * Chooses the account id for a new record: an explicit id wins, then an OAuth
 * record's own provider account id, then `"default"` for a key, then a fresh
 * generated id so two anonymous OAuth logins never collide.
 */
function chooseAccountId(record: AccountRecord, requested?: string): string {
  if (requested !== undefined && isSafeKey(requested)) return requested;
  if (record.kind === "oauth" && record.identity?.accountId !== undefined && isSafeKey(record.identity.accountId)) {
    return record.identity.accountId;
  }
  if (record.kind === "api_key") return DEFAULT_ACCOUNT_ID;
  return `account-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Adds (or replaces, when the id already exists) one account for a provider and
 * returns the new store plus the id used. Pure over `store`. Throws only on
 * misuse — an unknown provider, or a record whose kind the provider does not
 * support — never on a value, and never with a message that contains the
 * secret. By default the new account becomes active; pass `makeActive: false`
 * to add it without switching.
 */
export function addAccount(
  store: AccountStore,
  providerId: string,
  record: AccountRecord,
  options?: { accountId?: string; makeActive?: boolean },
): { store: AccountStore; accountId: string } {
  if (!KNOWN_PROVIDER_IDS.has(providerId)) {
    throw new Error(`unknown provider "${providerId}"`);
  }
  const method = record.kind === "api_key" ? "api-key" : "oauth";
  if (!providerSupportsMethod(providerId, method)) {
    throw new Error(`provider "${providerId}" does not support ${record.kind} accounts`);
  }
  const accountId = chooseAccountId(record, options?.accountId);
  const existing = store.providers[providerId];
  const accounts: Record<string, AccountRecord> = { ...(existing?.accounts ?? {}) };
  accounts[accountId] = record;
  const makeActive = options?.makeActive ?? true;
  const activeAccountId = makeActive
    ? accountId
    : (existing?.activeAccountId !== undefined && accounts[existing.activeAccountId] !== undefined
        ? existing.activeAccountId
        : accountId);
  return {
    store: { version: STORE_VERSION, providers: { ...store.providers, [providerId]: { activeAccountId, accounts } } },
    accountId,
  };
}

/**
 * Marks an existing account active. Pure over `store`; if the provider or
 * account is not present the store is returned unchanged — the tolerant,
 * never-throw contract callers rely on for a store that may have shifted.
 */
export function setActiveAccount(store: AccountStore, providerId: string, accountId: string): AccountStore {
  const entry = store.providers[providerId];
  if (entry === undefined || entry.accounts[accountId] === undefined) return store;
  return {
    version: STORE_VERSION,
    providers: { ...store.providers, [providerId]: { ...entry, activeAccountId: accountId } },
  };
}

/**
 * Removes one account (a per-account logout). If it was active, the active
 * pointer moves to a remaining account; if it was the last one, the provider
 * entry is dropped entirely. Pure over `store`; a no-op when absent.
 */
export function removeAccount(store: AccountStore, providerId: string, accountId: string): AccountStore {
  const entry = store.providers[providerId];
  if (entry === undefined || entry.accounts[accountId] === undefined) return store;

  const accounts: Record<string, AccountRecord> = { ...entry.accounts };
  delete accounts[accountId];

  const providers = { ...store.providers };
  const remaining = Object.keys(accounts);
  if (remaining.length === 0) {
    delete providers[providerId];
  } else {
    const activeAccountId =
      entry.activeAccountId !== undefined && accounts[entry.activeAccountId] !== undefined
        ? entry.activeAccountId
        : remaining[0];
    providers[providerId] = { activeAccountId, accounts };
  }
  return { version: STORE_VERSION, providers };
}

/**
 * Removes every account for a provider (a full logout). Pure over `store`; a
 * no-op when the provider has no accounts.
 */
export function logoutProvider(store: AccountStore, providerId: string): AccountStore {
  if (store.providers[providerId] === undefined) return store;
  const providers = { ...store.providers };
  delete providers[providerId];
  return { version: STORE_VERSION, providers };
}

/**
 * The generalized {@link credentialEnvPatch}: the environment additions implied
 * by the active account of every provider, for BOTH record kinds.
 *
 * The env-wins rule is identical — a provider whose env already carries ANY of
 * its credentials is left untouched, so an explicit shell export is never
 * silently shadowed and two credential sources are never mixed into one auth
 * attempt. Only the active account is projected; a stored account other than
 * the active one never reaches the environment.
 *
 * Mapping per kind:
 *   - api_key -> the provider's key env var (`envVars[0]`).
 *   - oauth   -> the access token into the access-token var (`envVars[0]`, e.g.
 *     `ZERO_CHATGPT_ACCESS_TOKEN`) and, when present, the refresh token into the
 *     provider's refresh-token var (the `envVars` entry matching /REFRESH/i).
 *
 * Pure over its arguments — no `process.env`, no mutation. Callers merge the
 * result themselves.
 */
export function accountEnvPatch(
  store: AccountStore,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const normalized = normalizeAccountStore(store);
  const patch: Record<string, string> = {};

  for (const info of PROVIDERS) {
    const record = getActiveAccount(normalized, info.id);
    if (record === undefined) continue;
    if (info.envVars.some((name) => hasCredential(env[name]))) continue;

    if (record.kind === "api_key") {
      const target = info.envVars[0];
      if (target !== undefined) patch[target] = record.secret;
      continue;
    }

    // oauth
    const accessVar = info.envVars[0];
    if (accessVar !== undefined && record.tokens.accessToken !== undefined) {
      patch[accessVar] = record.tokens.accessToken;
    }
    if (record.tokens.refreshToken !== undefined) {
      const refreshVar = info.envVars.find((name) => /REFRESH/i.test(name));
      if (refreshVar !== undefined) patch[refreshVar] = record.tokens.refreshToken;
    }
  }

  return patch;
}
