/** Independently implemented from the public SIWC protocol, not the DevKit.
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * Local open-source runtime only; never shares another application's client ID.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

export const SIWC_ISSUER = "https://auth.openai.com";
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const PATH = "/auth/callback";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function credential(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 65_536 || /[^\x21-\x7e]/.test(value)) throw new Error("The provider returned invalid authentication data.");
  return value;
}
export interface SiwcProfile {
  id: string; clientId: string; subject: string; issuer: typeof SIWC_ISSUER; email?: string;
  scopes: string[]; idToken: string; accessToken?: string; refreshToken?: string;
  expiresAt: number; earliestRefreshAt?: number; status: "connected" | "reauth-required" | "signed-out";
}
export interface SiwcTransport { fetch?: typeof fetch; now?: () => number }

export async function readSiwcJson(url: string, init: RequestInit, transport: SiwcTransport = {}): Promise<unknown> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  let response: Response;
  try { response = await (transport.fetch ?? fetch)(url, { ...init, signal, redirect: "error" }); }
  catch { throw new Error("ChatGPT sign-in could not reach its authentication service. Retry the connection."); }
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? "ChatGPT authentication was rejected. Sign in again." : `ChatGPT authentication is unavailable (HTTP ${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ChatGPT returned an empty authentication response.");
  let bytes = 0, raw = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 1_048_576) throw new Error("ChatGPT authentication response exceeded its limit."); raw += decoder.decode(chunk.value, { stream: true }); }
    raw += decoder.decode();
    try { return JSON.parse(raw); } catch { throw new Error("ChatGPT returned an invalid authentication response."); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function trustedEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("ChatGPT authentication configuration is incomplete.");
  const url = new URL(value);
  if (url.origin !== SIWC_ISSUER || url.username || url.password || url.hash || url.search) throw new Error("ChatGPT authentication configuration contains an untrusted endpoint.");
  return url.href;
}
export async function siwcMetadata(transport: SiwcTransport, signal?: AbortSignal) {
  const data = object(await readSiwcJson(`${SIWC_ISSUER}/.well-known/openid-configuration`, { signal }, transport));
  if (data.issuer !== SIWC_ISSUER) throw new Error("ChatGPT authentication issuer did not match.");
  return { token: trustedEndpoint(data.token_endpoint), jwks: trustedEndpoint(data.jwks_uri), revoke: trustedEndpoint(data.revocation_endpoint) };
}
export async function validateSiwcTokens(value: unknown, clientId: string, metadata: Awaited<ReturnType<typeof siwcMetadata>>, transport: SiwcTransport, signal?: AbortSignal, expected?: { nonce?: string; subject?: string; scopes?: string[]; previous?: SiwcProfile }): Promise<Omit<SiwcProfile, "id">> {
  const data = object(value), previous = expected?.previous;
  const idToken = data.id_token === undefined && previous ? previous.idToken : credential(data.id_token);
  const now = transport.now?.() ?? Date.now();
  let identity;
  if (data.id_token === undefined && previous && previous.clientId === clientId && previous.issuer === SIWC_ISSUER) {
    // Refresh may omit a new ID token; retain the already verified identity.
    identity = { sub: previous.subject, email: previous.email, iat: Math.floor(now / 1000) };
  } else {
    const keys = object(await readSiwcJson(metadata.jwks, { signal }, transport));
    if (!Array.isArray(keys.keys)) throw new Error("ChatGPT returned invalid signing keys.");
    try {
      identity = (await jwtVerify(idToken, createLocalJWKSet(keys as unknown as JSONWebKeySet), { issuer: SIWC_ISSUER, audience: clientId, algorithms: ["RS256", "ES256"], currentDate: new Date(now), requiredClaims: ["sub", "iat", "exp"] })).payload;
    } catch { throw new Error("ChatGPT identity verification failed. Sign in again."); }
  }
  if (typeof identity.sub !== "string" || !identity.sub || typeof identity.iat !== "number" || identity.iat > now / 1000 + 60 || (expected?.nonce !== undefined && identity.nonce !== expected.nonce) || (expected?.subject !== undefined && identity.sub !== expected.subject) || (identity.azp !== undefined && identity.azp !== clientId) || (Array.isArray(identity.aud) && identity.aud.length > 1 && identity.azp !== clientId)) throw new Error("ChatGPT identity did not match this sign-in.");
  const scopes = typeof data.scope === "string" ? [...new Set(data.scope.split(/\s+/).filter(Boolean))] : data.scope === undefined ? expected?.scopes : undefined;
  if (!scopes || !scopes.includes("openid")) throw new Error("ChatGPT did not return the granted identity permissions.");
  const sharing = scopes.includes("chatgpt.tokens.use.direct");
  const accessToken = data.access_token !== undefined ? credential(data.access_token) : undefined;
  const refreshToken = data.refresh_token !== undefined ? credential(data.refresh_token) : previous?.refreshToken;
  if (data.token_type !== "Bearer" || (sharing && (!accessToken || !refreshToken || !scopes.includes("resource.invoke") || !scopes.includes("offline_access"))) || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86_400) throw new Error("ChatGPT did not return a usable token grant.");
  const earliest = data.earliest_refresh_at;
  const earliestRefreshAt = typeof earliest === "number" ? earliest * 1000 : typeof earliest === "string" ? Date.parse(earliest) : undefined;
  if (earliestRefreshAt !== undefined && !Number.isFinite(earliestRefreshAt)) throw new Error("ChatGPT returned an invalid refresh schedule.");
  const email = typeof identity.email === "string" && identity.email.length <= 320 && !/[\x00-\x1f\x7f]/.test(identity.email) ? identity.email : undefined;
  return { clientId, subject: identity.sub, issuer: SIWC_ISSUER, ...(email ? { email } : {}), scopes, idToken, ...(accessToken ? { accessToken } : {}), ...(refreshToken ? { refreshToken } : {}), expiresAt: now + data.expires_in * 1000, ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}), status: "connected" };
}
export async function refreshSiwcProfile(profile: SiwcProfile, transport: SiwcTransport = {}, signal?: AbortSignal, checkpoint?: (value: unknown) => Promise<void>): Promise<SiwcProfile> {
  if (!profile.refreshToken || profile.status !== "connected") throw new Error("Sign in with ChatGPT again before continuing.");
  const metadata = await siwcMetadata(transport, signal);
  const value = await readSiwcJson(metadata.token, { method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: profile.clientId, refresh_token: profile.refreshToken, resource: SIWC_RESOURCE }).toString() }, transport);
  // Persist only bounded primitive grant fields, not arbitrary provider data.
  const body = object(value), receipt: Record<string, unknown> = {};
  for (const key of ["access_token", "refresh_token", "id_token", "token_type", "expires_in", "scope", "earliest_refresh_at"]) {
    const field = body[key];
    if (field !== undefined) receipt[key] = (typeof field === "string" && field.length <= 65_536) || typeof field === "number" || typeof field === "boolean" || field === null ? field : null;
  }
  await checkpoint?.(receipt);
  return { id: profile.id, ...await validateSiwcTokens(value, profile.clientId, metadata, transport, signal, { subject: profile.subject, scopes: profile.scopes, previous: profile }) };
}

export interface SiwcLoginOptions extends SiwcTransport {
  hostId: string; previous?: SiwcProfile; signal?: AbortSignal;
  onAuthorize: (url: string) => void | Promise<void>;
}
export async function loginSiwc(options: SiwcLoginOptions): Promise<Omit<SiwcProfile, "id">> {
  if (!/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.hostId)) throw new Error("ChatGPT sign-in requires this installation's stable host identity.");
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal, AbortSignal.timeout(300_000)]) : AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)]);
  const state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url"), verifier = randomBytes(64).toString("base64url");
  let resolveCallback!: (params: URLSearchParams) => void, rejectCallback!: (error: Error) => void;
  const callback = new Promise<URLSearchParams>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // Attach a handler immediately, including while the callback listener is starting.
  void callback.catch(() => undefined);
  let consumed = false, redirect = "";
  const server = createServer((req, res) => {
    let url: URL;
    try { if (!redirect) throw new Error(); url = new URL(req.url ?? "/", redirect); } catch { res.writeHead(400); res.end("Invalid callback."); return; }
    if (consumed || req.method !== "GET" || req.headers.host !== new URL(redirect).host || url.origin !== new URL(redirect).origin || url.pathname !== PATH || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) { res.writeHead(400, { "Cache-Control": "no-store" }); res.end("This sign-in callback is not valid."); return; }
    consumed = true; res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer" }); res.end("Return to 0 to finish connecting ChatGPT."); resolveCallback(url.searchParams);
  });
  const stopped = () => rejectCallback(new Error("ChatGPT sign-in was cancelled or timed out."));
  signal.addEventListener("abort", stopped, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { server.once("error", () => reject(new Error("The local sign-in callback could not start."))); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("The local sign-in callback could not start.");
    redirect = `http://127.0.0.1:${address.port}${PATH}`;
    const url = new URL(`${SIWC_ISSUER}/api/accounts/authorize`);
    const previous = options.previous;
    const parameters = { client_id: previous?.clientId ?? "dynamic_agent_client", ...(previous ? {} : { agent_name_hint: "0" }), ext_agent_host_id: options.hostId, response_type: "code", redirect_uri: redirect, scope: SIWC_SCOPES.join(" "), resource: SIWC_RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") };
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    void Promise.resolve().then(() => options.onAuthorize(url.href)).catch(() => rejectCallback(new Error("The browser sign-in could not be opened.")));
    const params = await callback; signal.throwIfAborted();
    if (params.has("error")) throw new Error("ChatGPT sign-in was not authorized. No account was changed.");
    const clientId = params.has("client_id") ? credential(params.get("client_id")) : previous?.clientId;
    if (!clientId || clientId === "dynamic_agent_client" || params.getAll("client_id").length > 1 || (previous && clientId !== previous.clientId) || params.getAll("code").length !== 1) throw new Error("ChatGPT registration did not match this sign-in.");
    const code = credential(params.get("code")), metadata = await siwcMetadata(options, signal);
    const value = await readSiwcJson(metadata.token, { method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: SIWC_RESOURCE }).toString() }, options);
    return await validateSiwcTokens(value, clientId, metadata, options, signal, { nonce, ...(previous ? { subject: previous.subject } : {}) });
  } finally { abort.abort(); signal.removeEventListener("abort", stopped); server.closeAllConnections(); await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()); }); }
}
