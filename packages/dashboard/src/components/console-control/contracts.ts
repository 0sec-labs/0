import type { Finding, HarnessSnapshot, ScanPlan, ScanAttemptOutcome, ConsoleExecutionSnapshot } from "@0/shared";

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
  diagnostics: RuntimeInfo["diagnostics"];
  accounts: { accountId: string; kind: string; active: boolean; label: string }[];
  auth: AuthStatus;
  configuration?: { baseUrl?: string; model?: string; projectId?: string };
}
export interface ProvidersResponse { providers: Provider[]; preference: { providerId: string; model: string; connectionIdentity: string } | null }
export interface ModelsResponse {
  models: { id: string; provider: string; price: string; contextWindowTokens: number | null; source: "account" | "public-catalog" }[];
  providerId: string | null; diagnostics: { providerId: string; message: string }[]; roles: string[];
}
export interface SettingDefinition { key: string; label: string; description: string; kind: "boolean" | "enum"; default: unknown; choices?: string[]; group: string; operatorOnly: boolean }
export interface SettingsResponse { settings: Record<string, unknown>; sources: Record<string, "default" | "global" | "project">; definitions: SettingDefinition[]; defaultWriteLayer: "global" | "project"; persisted?: boolean }
export interface ThemesResponse { active: string; themes: { name: string; label: string; description: string; mode: string; palette: Record<string, string> }[] }
export interface PluginItem { id: string; kind: "plugin" | "theme"; name: string; version: string; description: string; capabilities: string[]; signature: "verified" | "unverified"; state: "available" | "installed" | "enabled" | "active"; loaded: boolean; error: string | null }
export interface PluginsResponse { executionProfile: "local" | "smolvm"; registry: { url: string; available: boolean; error: string | null }; items: PluginItem[]; deferred: string[]; host: { loadedPluginIds: string[]; tools: { name: string; description: string }[] } }
export interface PluginResult { ok: boolean; message: string; state?: string; capabilities?: string[]; deferred?: boolean }
export interface CheckItem { id: string; name: string; prompt: string; revision: number; enabled: boolean; approvedRevision: number | null }
export interface ChecksResponse { project: string; checks: CheckItem[] }
export interface ProjectResponse { path: string; name: string; git: { branch: string | null; dirty: boolean; root: string | null; error: string | null } }
export interface SessionSummary { id: string; title?: string; target: string; role: string; autonomyMode: string; status: string; runtime?: RuntimeInfo; execution?: ConsoleExecutionSnapshot; pendingConfiguration?: unknown }
export interface SessionSnapshot { session: SessionSummary; runtime?: RuntimeInfo | null; execution?: ConsoleExecutionSnapshot; pendingConfiguration?: unknown; harness?: HarnessSnapshot | null; scope: { in_scope?: string[]; out_of_scope?: string[] } | null; scopeEnforcement: { enabled: boolean; message: string }; localScopePath?: string; tools: { name: string; description: string; inputSchema: unknown }[] }
export interface Workflow {
  id: string; sessionId: string; kind: string; status: string; createdAt: string; updatedAt: string;
  request: { target?: string; plan?: ScanPlan; resolved?: { kind: string; target: string; targetType: string; label: string; ecosystem?: string }; [key: string]: unknown }; runtime: { providerId: string; model: string; agentModels?: Record<string, string>; singleModel?: boolean; autoRoute?: boolean };
  events: { sequence: number; timestamp: string; type: string; data: unknown }[];
  oldestSequence: number; eventsTruncated: boolean; report?: unknown; reportRetained: boolean; reportRetentionReason?: string;
  result?: { fix?: WebFix; [key: string]: unknown }; error?: string;
  outcome?: { ok: boolean; exitCode: number; exit_reason: string; plannedRuns?: number; completedRuns?: number; attempts?: ScanAttemptOutcome[]; usage?: { inputTokens: number; outputTokens: number }; estimatedCostUsd?: number; cost_usd?: number; summary?: { totalFindings: number }; error?: string };
}
export interface FixResult {
  status: string; findingId: string; sourceFile?: string; attempts: { attempt: number; reason: string }[];
  precondition?: unknown; postcondition?: unknown; test?: { command: string; exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean };
  patch?: string; diff?: string; candidate?: { repoRoot: string; worktree: string; baseCommit: string; baseBranch?: string; recordPath: string };
  rationale?: string; applied: boolean; error?: string;
}
export interface WebFix {
  id: string; sessionId: string; finding: Finding; repoRoot: string; baseCommit: string; testCommand: string; reviewToken: string;
  eligible: boolean; reason?: string; candidateId?: string; result?: FixResult; verification?: FixResult; application?: FixResult; applied: boolean;
  publication?: { branch: string; baseBranch: string; remote: string; title: string; worktree: string; diff: string; publicationToken: string };
  published?: { prUrl: string; branch: string; worktree: string }; activeWorkflowId?: string;
}
