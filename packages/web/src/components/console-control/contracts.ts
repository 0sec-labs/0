import type { ConsoleExecutionSnapshot } from "@0/engine/shared";

export interface RuntimeInfo {
  providerId: string;
  providerLabel: string;
  model: string;
  configured: boolean;
  connectionIdentity: string | null;
  diagnostics: { valid: boolean; reason: string | null; message: string | null };
  agentModels: Record<string, string>;
  singleModel: boolean;
  autoRoute: boolean;
  contextWindowTokens: number | null;
}
export interface RuntimeSelection { providerId?: string; model?: string; agentModels?: Record<string, string>; singleModel?: boolean; autoRoute?: boolean }
export interface AuthStatus { phase: string; message: string; lines: string[]; verificationUrl: string | null; userCode: string | null; available: boolean }
export interface Provider {
  id: string; label: string; methods: ("api-key" | "oauth")[]; configured: boolean; source: string | null;
  /** Opaque bound credential/endpoint identity; never contains credential values. */
  connectionIdentity?: string | null;
  diagnostics: RuntimeInfo["diagnostics"];
  accounts: { accountId: string; kind: string; active: boolean; label: string; status?: string; sharing?: boolean }[];
  auth: AuthStatus;
  configuration?: { baseUrl?: string; model?: string };
  /** Whether the key works (server probe), not just whether one is present. */
  health?: { state: "ok" | "rejected" | "unreachable" | "unknown"; checking?: boolean; hint?: string | null };
  /** Variable that supplies the credential when it comes from the environment; it wins over a saved key. */
  environmentVariable?: string | null;
}
export interface ProvidersResponse { providers: Provider[]; preference: { providerId: string; model: string; connectionIdentity: string } | null }
export interface ModelsResponse {
  models: { id: string; provider: string; price: string; contextWindowTokens: number | null; source: "account" | "public-catalog"; enabled?: boolean }[];
  providerId: string | null; diagnostics: { providerId: string; message: string }[]; roles: string[];
  /** Per-role picks reachable on the connected providers, from the engine recommendation catalog. */
  recommended?: { role: string; label: string; why?: string; providerId: string; model: string }[];
  /** Discovery is still running for some providers: they are connected, just not listed yet. */
  pending?: boolean; pendingProviders?: string[];
}
export interface SettingDefinition { key: string; label: string; description: string; kind: "boolean" | "enum" | "number" | "text"; default: unknown; choices?: string[]; min?: number; max?: number; step?: number; maxLength?: number; group: string; operatorOnly: boolean }
export interface SettingsResponse { settings: Record<string, unknown>; sources: Record<string, "default" | "global" | "project">; definitions: SettingDefinition[]; defaultWriteLayer: "global" | "project"; persisted?: boolean; accessUpgradeNotice?: { agents: number; threads: number } }
export interface CheckItem { id: string; name: string; prompt: string; revision: number; enabled: boolean; approvedRevision: number | null }
export interface ChecksResponse { project: string; checks: CheckItem[] }
export interface ProjectResponse { path: string; name: string; git: { branch: string | null; dirty: boolean; root: string | null; error: string | null } }
export interface SessionSummary { id: string; title?: string; parentSessionId?: string; skillAllowList?: string[]; titleSource?: "default" | "auto" | "user"; role: string; status: string; runtime?: RuntimeInfo; execution?: ConsoleExecutionSnapshot; pendingConfiguration?: unknown }
export interface SessionSnapshot { session: SessionSummary; runtime?: RuntimeInfo | null; execution?: ConsoleExecutionSnapshot; pendingConfiguration?: unknown; tools: { name: string; description: string; inputSchema: unknown }[] }
