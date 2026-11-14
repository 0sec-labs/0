import { createHash } from "node:crypto";
import { CODEX_CLIENT_VERSION, CODEX_PROTOCOL_HEADERS, getChatGptCodexAccessToken } from "./llm-api.js";

export interface CodexCatalogModel {
  id: string;
  contextTokens?: number;
  /** Backend recommendation rank; lower values are preferred. */
  priority?: number;
}

/** Transient failure with metadata verified for the credentials just resolved. */
export class CodexCatalogRefreshError extends Error {
  readonly cachedModels: readonly CodexCatalogModel[];

  constructor(cachedModels: readonly CodexCatalogModel[]) {
    super("Codex model discovery unavailable; using this account's cached models");
    this.name = "CodexCatalogRefreshError";
    this.cachedModels = cachedModels;
  }
}

// Metadata only; never persist subscription catalogs or plaintext credentials.
let cachedCatalog: { identity: string; models: CodexCatalogModel[] } | undefined;

/** Account catalog used by the Codex Responses backend, also used by 0code/OMP. */
export function parseCodexModels(raw: unknown): CodexCatalogModel[] {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Codex model catalog");
  const body = raw as Record<string, unknown>;
  const rows = body.models ?? body.data;
  if (!Array.isArray(rows)) throw new Error("Invalid Codex model catalog");
  const seen = new Set<string>();
  return rows.flatMap((value): CodexCatalogModel[] => {
    if (!value || typeof value !== "object") throw new Error("Invalid Codex model row");
    const row = value as Record<string, unknown>;
    const id = row.slug ?? row.id;
    if (typeof id !== "string" || !id.trim() || /[\s\x00-\x1f\x7f-\x9f]/.test(id)) {
      throw new Error("Invalid Codex model id");
    }
    if (row.visibility === "hide" || row.visibility === "hidden" || row.hidden === true) return [];
    if (seen.has(id)) return [];
    seen.add(id);
    const context = row.context_window;
    const priority = row.priority;
    return [{
      id,
      ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? { contextTokens: context } : {}),
      ...(typeof priority === "number" && Number.isFinite(priority) ? { priority } : {}),
    }];
  }).sort((left, right) => {
    // Stable sorting preserves backend order when priorities match or are absent.
    const a = left.priority ?? Infinity;
    const b = right.priority ?? Infinity;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Read with the runtime's credential resolver; never borrow another client's account or catalog cache. */
export async function loadCodexModelCatalog(options: {
  env?: Readonly<NodeJS.ProcessEnv>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Host-internal resolver for an already-running subscription account. */
  resolveCredentials?: () => Promise<{ accessToken: string; accountId?: string }>;
} = {}): Promise<CodexCatalogModel[]> {
  const timeout = AbortSignal.timeout(8_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  // Cancelling a picker must not cancel a shared OAuth refresh used by inference.
  // Bound this waiter independently, before starting credential resolution.
  const credentials = await new Promise<{ accessToken: string; accountId?: string }>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    const pending = options.resolveCredentials
      ? options.resolveCredentials()
      : getChatGptCodexAccessToken(options.env ?? process.env);
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
  const { accessToken, accountId } = credentials;
  signal.throwIfAborted();
  const identity = createHash("sha256").update(accountId ? `account:${accountId}` : `token:${accessToken}`).digest("hex");
  // Switching accounts invalidates the previous floor before any HTTP request.
  if (cachedCatalog?.identity !== identity) cachedCatalog = undefined;
  let denied = false;
  try {
    let lastError: unknown = new Error("Codex model discovery unavailable");
    for (const path of ["/codex/models", "/models"]) {
      signal.throwIfAborted();
      try {
        const response = await (options.fetchImpl ?? fetch)(
          `https://chatgpt.com/backend-api${path}?client_version=${CODEX_CLIENT_VERSION}`,
          {
            signal,
            redirect: "error",
            headers: {
              ...CODEX_PROTOCOL_HEADERS,
              Authorization: `Bearer ${accessToken}`,
              ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
              Accept: "application/json",
            },
          },
        );
        denied = response.status === 401 || response.status === 403;
        if (!response.ok) throw new Error(`Codex model discovery failed (HTTP ${response.status})`);
        const models = parseCodexModels(await response.json());
        signal.throwIfAborted();
        cachedCatalog = { identity, models };
        return models;
      } catch (error) {
        // An account denial is definitive; another route cannot grant access.
        if (denied || signal.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError;
  } catch (error) {
    if (denied && cachedCatalog?.identity === identity) cachedCatalog = undefined;
    // A cancelled picker is not an offline refresh and must not paint cached rows.
    if (!options.signal?.aborted && !denied && cachedCatalog?.identity === identity) {
      throw new CodexCatalogRefreshError(cachedCatalog.models);
    }
    throw error;
  }
}
