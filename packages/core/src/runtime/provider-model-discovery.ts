import { execFile } from "node:child_process";

export interface DiscoveredProviderModel {
  id: string;
  contextTokens?: number;
}

/** Injectable read-only Azure CLI runner. Output is parsed internally, never surfaced in errors. */
export type AzureModelDiscoveryRunner = (args: readonly string[], signal: AbortSignal) => Promise<string>;

export interface ProviderModelDiscoveryOptions {
  provider: string;
  baseUrl: string;
  /** Already-resolved headers belonging to this exact inference connection. */
  headers: HeadersInit;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  runAzureCli?: AzureModelDiscoveryRunner;
}

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_PAGES = 100;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\s\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new Error("Provider returned an invalid model identifier.");
  }
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function endpoint(value: string): URL {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch {
    throw new Error("Model discovery requires a valid provider endpoint.");
  }
}

function modelUrl(base: URL, provider: string): URL {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}${provider === "anthropic" && !path.endsWith("/v1") ? "/v1" : ""}/models${provider === "openrouter" ? "/user" : ""}`;
  return url;
}

/** Do not offer known embedding, speech, moderation or image-only routes as agents. */
function textGenerationModel(row: Record<string, unknown>, id: string): boolean {
  const capabilities = record(row.capabilities);
  const type = capabilities?.type ?? row.type;
  if (typeof type === "string" && /embedding|image|audio|speech|moderation|rerank/i.test(type)) return false;
  const output = record(row.architecture)?.output_modalities;
  if (Array.isArray(output) && !output.includes("text")) return false;
  return !/(?:^|[\/\-_.])(?:embedding[s]?|embed|whisper|tts|dall-e|moderation|rerank|transcribe|transcription|realtime|audio|speech|image)(?:$|[\-_.])/i.test(id)
    && !/(?:^|\/)(?:flux|stable-diffusion|sdxl|imagen)(?:$|[\-_.])/i.test(id);
}

function parseModel(rowValue: unknown, provider: string): DiscoveredProviderModel | undefined {
  const row = record(rowValue);
  if (!row) throw new Error("Provider returned an invalid model row.");
  const id = identifier(row.id);
  if (row.hidden === true || row.visibility === "hidden" || row.visibility === "hide" || !textGenerationModel(row, id)) return undefined;
  const capabilities = record(row.capabilities);
  if (provider === "copilot") {
    // Policy is access control; picker presentation flags alone do not establish entitlement.
    if (capabilities?.type !== "chat") return undefined;
    const policy = record(row.policy);
    if (row.policy !== undefined && policy?.state !== "enabled") return undefined;
    if (record(capabilities.supports)?.tool_calls === false) return undefined;
  }
  const limits = record(capabilities?.limits);
  const contextTokens = positiveInteger(row.context_window) ?? positiveInteger(row.context_length)
    ?? positiveInteger(row.max_input_tokens) ?? positiveInteger(limits?.max_context_window_tokens);
  return { id, ...(contextTokens !== undefined ? { contextTokens } : {}) };
}

async function readProviderModels(options: ProviderModelDiscoveryOptions, base: URL, signal: AbortSignal): Promise<DiscoveredProviderModel[]> {
  const url = modelUrl(base, options.provider);
  const models: DiscoveredProviderModel[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(url.href, {
        method: "GET", headers: options.headers, signal, redirect: "error",
      });
    } catch {
      throw new Error("Provider model discovery could not reach the selected endpoint.");
    }
    if (!response.ok) throw new Error(`Provider model discovery failed (HTTP ${response.status}).`);
    let body: Record<string, unknown> | undefined;
    try { body = record(await response.json()); }
    catch { throw new Error("Provider returned an invalid model discovery response."); }
    if (!body || !Array.isArray(body.data)) throw new Error("Provider returned an invalid model discovery response.");
    if (body.has_more !== undefined && typeof body.has_more !== "boolean") throw new Error("Provider returned invalid model pagination.");
    for (const row of body.data) {
      const model = parseModel(row, options.provider);
      if (model && !seen.has(model.id)) { seen.add(model.id); models.push(model); }
    }
    signal.throwIfAborted();
    if (body.has_more !== true) return models;
    // Anthropic documents after_id/last_id. Never follow provider-supplied URLs with credentials.
    if (options.provider !== "anthropic") throw new Error("Provider model discovery returned unsupported pagination.");
    const cursor = identifier(body.last_id);
    if (cursors.has(cursor)) throw new Error("Provider model discovery returned a repeated pagination cursor.");
    cursors.add(cursor);
    url.searchParams.set("after_id", cursor);
  }
  throw new Error("Provider model discovery exceeded its pagination limit.");
}

const defaultAzureRunner: AzureModelDiscoveryRunner = (args, signal) => new Promise((resolve, reject) => {
  execFile("az", [...args], {
    encoding: "utf8", timeout: DISCOVERY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    signal, windowsHide: true,
    env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: "false" },
  }, (error, stdout) => {
    if (error) reject(new Error("Azure deployment discovery requires Azure CLI installed and an existing signed-in session with resource read access."));
    else resolve(stdout);
  });
});

async function azureJson(runner: AzureModelDiscoveryRunner, args: string[], signal: AbortSignal): Promise<unknown[]> {
  signal.throwIfAborted();
  let result: unknown;
  try {
    const output = await runner([...args, "--output", "json", "--only-show-errors"], signal);
    signal.throwIfAborted();
    result = JSON.parse(output);
  } catch {
    throw new Error("Azure deployment discovery requires Azure CLI installed and an existing signed-in session with resource read access. Check the selected subscription and endpoint.");
  }
  if (!Array.isArray(result)) throw new Error("Azure CLI returned an invalid deployment discovery response.");
  return result;
}

function accountMatches(account: Record<string, unknown>, host: string): boolean {
  const properties = record(account.properties);
  const endpoints = [properties?.endpoint, ...Object.values(record(properties?.endpoints) ?? {})];
  for (const value of endpoints) {
    if (typeof value !== "string") continue;
    try { if (endpoint(value).hostname === host) return true; } catch { /* Not an endpoint. */ }
  }
  const subdomain = properties?.customSubDomainName;
  if (typeof subdomain !== "string" || !/^[a-zA-Z0-9-]+$/.test(subdomain)) return false;
  return [".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com",
    ".openai.azure.us", ".openai.azure.cn", ".cognitiveservices.azure.us", ".cognitiveservices.azure.cn"]
    .some((suffix) => host === `${subdomain.toLowerCase()}${suffix}`);
}

function azureTextDeployment(properties: Record<string, unknown>): boolean {
  const model = record(properties.model);
  if (typeof model?.name !== "string") throw new Error("Azure CLI returned an invalid deployment model.");
  if (!textGenerationModel(model, model.name)) return false;
  const capabilities = record(properties.capabilities);
  const generation = ["chatCompletion", "chat_completion", "completion", "responses", "textGeneration", "text_generation"];
  if (generation.some((key) => capabilities?.[key] === true || capabilities?.[key] === "true")) return true;
  // Old management responses omit capabilities; recognise text families using underlying model names only.
  // Deployment aliases are never interpreted as model types.
  return /^(?:gpt-(?!image|audio|realtime)|o[134](?:-|$)|text-davinci|phi-|llama-|deepseek-|grok-|kimi-|mistral-|qwen-|claude-|glm-)/i.test(model.name);
}

async function readAzureDeployments(options: ProviderModelDiscoveryOptions, base: URL, signal: AbortSignal): Promise<DiscoveredProviderModel[]> {
  const runner = options.runAzureCli ?? defaultAzureRunner;
  // Never invoke login, mutate the active subscription, or ask Azure's base-model catalog.
  const accounts = await azureJson(runner, ["cognitiveservices", "account", "list"], signal);
  const matched = accounts.map((value) => {
    const account = record(value);
    if (!account) throw new Error("Azure CLI returned an invalid account row.");
    return account;
  }).filter((account) => accountMatches(account, base.hostname));
  if (matched.length !== 1) throw new Error("Azure deployment discovery could not uniquely match the selected endpoint in the current Azure CLI subscription. Check the subscription and resource read access.");
  const account = matched[0];
  const name = identifier(account.name);
  const group = account.resourceGroup;
  if (typeof group !== "string" || !group || /[\x00-\x1f\x7f]/.test(group)) throw new Error("Azure CLI returned an invalid account resource group.");
  const args = ["cognitiveservices", "account", "deployment", "list", "--name", name, "--resource-group", group];
  // Pin the discovered subscription even if another process changes the CLI's active subscription.
  const subscription = typeof account.id === "string" ? /^\/subscriptions\/([^/]+)\//i.exec(account.id)?.[1] : undefined;
  if (subscription) args.push("--subscription", identifier(subscription));
  const deployments = await azureJson(runner, args, signal);
  const models: DiscoveredProviderModel[] = [];
  const seen = new Set<string>();
  for (const value of deployments) {
    const deployment = record(value);
    const properties = record(deployment?.properties);
    if (!deployment || !properties) throw new Error("Azure CLI returned an invalid deployment row.");
    const id = identifier(deployment.name);
    if (properties.provisioningState !== "Succeeded" || !azureTextDeployment(properties) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id });
  }
  return models;
}

/** Only models discovered for the selected endpoint; no public-catalog or configured-model fallback. */
export async function discoverProviderModels(options: ProviderModelDiscoveryOptions): Promise<DiscoveredProviderModel[]> {
  if (options.provider === "google") throw new Error("Google Code Assist does not support account model discovery here. Select a provider with model discovery support.");
  if (options.provider === "chatgpt-codex") throw new Error("Use the active ChatGPT account's Codex model discovery.");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)])
    : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  signal.throwIfAborted();
  const base = endpoint(options.baseUrl);
  return options.provider === "azure" ? readAzureDeployments(options, base, signal) : readProviderModels(options, base, signal);
}
