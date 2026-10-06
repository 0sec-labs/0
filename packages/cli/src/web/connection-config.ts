import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homeStateDir } from "@0/shared";

/** Only transport settings used by existing providers; never an arbitrary env setter. */
const BASE_URL_VARS: Readonly<Record<string, string>> = {
  deepseek: "DEEPSEEK_BASE_URL", anthropic: "ANTHROPIC_BASE_URL", azure: "AZURE_OPENAI_BASE_URL",
  openai: "OPENAI_BASE_URL", "z-ai": "Z_AI_BASE_URL", kimi: "KIMI_BASE_URL", qwen: "QWEN_BASE_URL",
  xai: "XAI_BASE_URL", opencode: "OPENCODE_BASE_URL", cline: "CLINE_BASE_URL", copilot: "COPILOT_BASE_URL",
};
export interface ConnectionConfig { baseUrl?: string; model?: string; projectId?: string }

export function validateConnectionConfig(providerId: string, value: ConnectionConfig): ConnectionConfig {
  const result: ConnectionConfig = {};
  if (value.baseUrl !== undefined) {
    if (!BASE_URL_VARS[providerId]) throw new Error("This provider does not support a custom API endpoint.");
    const url = new URL(value.baseUrl);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("API endpoint must be credential-free HTTPS, or loopback HTTP, without a query or fragment.");
    }
    result.baseUrl = url.href.replace(/\/$/, "");
  }
  if (value.model !== undefined) {
    if (providerId !== "azure") throw new Error("Deployment model configuration is only supported for Azure; select other models through runtime selection.");
    if (!value.model.trim() || value.model.length > 256 || /[\s\x00-\x1f\x7f]/.test(value.model)) throw new Error("Invalid deployment model.");
    result.model = value.model;
  }
  if (value.projectId !== undefined) {
    if (providerId !== "google" || !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(value.projectId)) throw new Error("Invalid Google Cloud project ID.");
    result.projectId = value.projectId;
  }
  return result;
}

export function loadConnectionConfigs(homeDir?: string): Record<string, ConnectionConfig> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(homeStateDir(homeDir), "web-connections.json"), "utf8")); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, ConnectionConfig> = {};
  for (const providerId of [...Object.keys(BASE_URL_VARS), "google"]) {
    const row = (raw as Record<string, unknown>)[providerId];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const config = row as Record<string, unknown>;
    try {
      result[providerId] = validateConnectionConfig(providerId, {
        ...(typeof config.baseUrl === "string" ? { baseUrl: config.baseUrl } : {}),
        ...(typeof config.model === "string" ? { model: config.model } : {}),
        ...(typeof config.projectId === "string" ? { projectId: config.projectId } : {}),
      });
    } catch { /* A malformed persisted endpoint cannot redirect requests. */ }
  }
  return result;
}

export function saveConnectionConfig(providerId: string, config: ConnectionConfig, homeDir?: string): void {
  const value = validateConnectionConfig(providerId, config);
  const next = { ...loadConnectionConfigs(homeDir), [providerId]: value };
  const path = join(homeStateDir(homeDir), "web-connections.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(next) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function connectionConfigEnvPatch(env: NodeJS.ProcessEnv, homeDir?: string): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [id, config] of Object.entries(loadConnectionConfigs(homeDir))) {
    const variable = BASE_URL_VARS[id];
    if (variable && config.baseUrl && !env[variable]) patch[variable] = config.baseUrl;
    if (id === "azure" && config.model && !env.AZURE_OPENAI_MODEL) patch.AZURE_OPENAI_MODEL = config.model;
    if (id === "google" && config.projectId && !env.GOOGLE_CLOUD_PROJECT && !env.ZERO_GEMINI_PROJECT) patch.ZERO_GEMINI_PROJECT = config.projectId;
  }
  return patch;
}
