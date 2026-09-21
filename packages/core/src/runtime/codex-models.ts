import { getChatGptCodexAccessToken } from "./llm-api.js";

export interface CodexCatalogModel {
  id: string;
  contextTokens?: number;
}

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
    if (typeof id !== "string" || !id.trim() || /[\s\x00-\x1f\x7f]/.test(id)) {
      throw new Error("Invalid Codex model id");
    }
    if (row.visibility === "hide" || row.visibility === "hidden" || row.hidden === true) return [];
    if (seen.has(id)) return [];
    seen.add(id);
    const context = row.context_window;
    return [{ id, ...(typeof context === "number" && Number.isFinite(context) && context > 0 ? { contextTokens: context } : {}) }];
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
  // Compatibility version used by the pinned OMP Codex catalog protocol.
  const version = "0.144.1";
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
  const response = await (options.fetchImpl ?? fetch)(
    `https://chatgpt.com/backend-api/codex/models?client_version=${version}`,
    {
      signal,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
        "OpenAI-Beta": "responses=experimental",
        originator: "0",
        version,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) throw new Error(`Codex model discovery failed (HTTP ${response.status})`);
  return parseCodexModels(await response.json());
}
