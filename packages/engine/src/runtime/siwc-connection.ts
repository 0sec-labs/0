/** Host-injected, verified SIWC registration. No credential persistence or env export. */
export interface SiwcConnection {
  readonly accountId: string;
  readonly clientId: string;
  readonly hostId: string;
  readonly resolveCredentials: (signal?: AbortSignal) => Promise<{ accessToken: string; scopes: readonly string[] }>;
}
export interface SiwcModel { slug: string; display_name: string }
export function captureSiwcConnection(connection: SiwcConnection): SiwcConnection {
  if (!connection.accountId || !connection.clientId || connection.clientId === "dynamic_agent_client" || !connection.hostId || typeof connection.resolveCredentials !== "function") {
    throw new Error("ChatGPT plan requires a verified account, issued client ID and stable host ID");
  }
  return Object.freeze({ accountId: connection.accountId, clientId: connection.clientId, hostId: connection.hostId, resolveCredentials: connection.resolveCredentials });
}
async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("ChatGPT plan request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export async function siwcHeaders(connection: SiwcConnection, signal?: AbortSignal): Promise<Record<string, string>> {
  signal?.throwIfAborted();
  const credentials = await abortable(connection.resolveCredentials(signal), signal);
  signal?.throwIfAborted();
  if (typeof credentials.accessToken !== "string" || !credentials.accessToken || credentials.accessToken.length > 65536 || /[\s\x00-\x1f\x7f]/.test(credentials.accessToken) || !Array.isArray(credentials.scopes) || !["resource.invoke", "chatgpt.tokens.use.direct"].every(scope => credentials.scopes.includes(scope))) {
    throw new Error("ChatGPT plan permission is not enabled; authorize plan usage for this account");
  }
  return { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" };
}
/** Account-specific public SIWC catalog; never substitutes the API-key catalog. */
export async function listSiwcModels(connection: SiwcConnection, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<SiwcModel[]> {
  const response = await fetchImpl("https://api.openai.com/v1/models", { headers: await siwcHeaders(captureSiwcConnection(connection), signal), signal, redirect: "error" });
  if (!response.ok) throw new Error(`ChatGPT plan model discovery failed (HTTP ${response.status})`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("models" in data) || !Array.isArray(data.models)) throw new Error("Invalid ChatGPT plan model catalog");
  return data.models.filter((model): model is SiwcModel & {visibility: string} => !!model && typeof model === "object" && model.visibility === "list" && typeof model.slug === "string" && !!model.slug && typeof model.display_name === "string")
    .map(({slug, display_name}) => ({slug, display_name}));
}
