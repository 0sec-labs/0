// Bearer-authenticated 0 client for health, hosted model catalog,
// inference balance, and request usage. Provider keys stay on the service.
//
// SECURITY:
//   - The Authorization header value is built from the token but never
//     emitted back to the caller. Errors include status + path + host,
//     never headers or the token itself.
//   - `User-Agent` includes `@0/cli/<version>` so server-side ops can
//     identify CLI traffic if it looks anomalous.

import { VERSION } from "@0/shared";

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string,
    /** The gateway's machine error code from the `{error:{code}}` body, when present
     * (e.g. `inference_disabled`, `provider_unavailable`, `billing_unavailable`,
     * `insufficient_funds`) — lets a caller tell a deliberate service gate from an
     * outage. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/** 401 — token rejected. Distinct from CloudAuthMissingError, which means no token was configured. */
export class CloudUnauthorizedError extends CloudError {
  constructor(path: string) {
    super(`0-cloud auth rejected (HTTP 401) on ${path}. Run \`0 auth login\` to refresh.`, 401, path);
    this.name = "CloudUnauthorizedError";
  }
}
export class CloudForbiddenError extends CloudError {
  constructor(path: string) {
    super(
      `0-cloud forbidden (HTTP 403) on ${path}. Token lacks scope for this resource.`,
      403,
      path,
    );
    this.name = "CloudForbiddenError";
  }
}
export class CloudNetworkError extends CloudError {
  constructor(message: string, path: string) {
    super(`0-cloud network error on ${path}: ${message}`, undefined, path);
    this.name = "CloudNetworkError";
  }
}

export type FetchImpl = typeof fetch;

export interface CloudClientOptions {
  host: string;
  token: string;
  fetchImpl?: FetchImpl;
}

/** Shape of a `/health` response. Kept loose on purpose: the server may
 *  add fields, and we only commit to `status` for this PR. zod schemas
 *  arrive when real endpoints land. */
export interface CloudHealthResponse {
  status: string;
}

// ── Hosted inference API types ──

/** A single model entry from the hosted inference catalog. */
export interface InferenceModel {
  id: string;
  object: "model";
  owned_by: string;
  provider: string;
  upstream_model: string;
  wire_api: "chat_completions" | "responses";
  context_length: number;
  max_output_tokens: number;
  pricing: {
    input_per_million_usd: number;
    output_per_million_usd: number;
    cached_input_per_million_usd: number;
  };
}

/** Response shape from GET /api/inference/v1/models */
export interface InferenceModelsResponse {
  object: "list";
  data: InferenceModel[];
}

/** Usage metadata from GET /api/inference/usage */
export interface InferenceUsageResponse {
  requests: Record<string, unknown>[];
}

// ── Audit-skills API types ──

/** Source metadata for an audit skill. */
export interface AuditSkillSource {
  type: "markdown" | "github";
  repository?: string;
  ref?: string;
  commit?: string;
  path?: string;
}

/** A single file in an audit-skill snapshot. */
export interface AuditSkillFile {
  path: string;
  content: string;
}

/** Full snapshot of a specific revision of an audit skill. */
export interface AuditSkillSnapshot {
  skillId: string;
  revisionId: string;
  revision: number;
  name: string;
  description: string;
  sha256: string;
  entrypoint: string;
  files: AuditSkillFile[];
  source?: AuditSkillSource;
}

/** Lightweight summary of an audit skill (list view). */
export interface AuditSkillSummary {
  id: string;
  name: string;
  description: string;
  latestRevision: number;
  source: AuditSkillSource;
  createdAt: string;
  updatedAt: string;
  projectCount: number;
}

/** Skills list response from GET /api/audit-skills. */
export interface AuditSkillsListResponse {
  skills: AuditSkillSummary[];
  projects: Array<{ id: string; fullName: string }>;
}

/** Single-skill detail response from GET /api/audit-skills/:id. */
export interface AuditSkillDetailResponse {
  skill: AuditSkillSummary;
  revisions: AuditSkillSnapshot[];
  assignments: Array<{ projectId: string; revisionId: string }>;
}

/** Create skill request body. */
export interface AuditSkillCreateInput {
  name: string;
  description?: string;
  files: AuditSkillFile[];
}

/** GitHub import request body. */
export interface AuditSkillImportInput {
  repository: string;
  ref?: string;
  path?: string;
  name?: string;
}

/** Create revision request body. */
export interface AuditSkillRevisionInput {
  expectedRevision: number;
  files: AuditSkillFile[];
  name?: string;
  description?: string;
}

/** Sync request body. */
export interface AuditSkillSyncInput {
  expectedRevision: number;
}

/** Assign request body. */
export interface AuditSkillAssignInput {
  revisionId: string;
}

/** Response from create or import. */
export interface AuditSkillCreateResponse {
  skill: AuditSkillSummary;
  revision: AuditSkillSnapshot;
}

/** Response from assign/unassign. */
export interface AuditSkillBindResponse {
  projectId: string;
  revisionId: string;
}

/** Response from GET /api/audit-skills/by-project/:projectId. */
export interface AuditSkillsByProjectResponse {
  project: { id: string; fullName: string };
  assignments: Array<{ skillId: string; skillName: string; revisionId: string; revision: number }>;
  availableSkills: AuditSkillSummary[];
}

// ── Credit account types (usage-v2 /account DTO) ──

/**
 * Customer credit account from GET /api/inference/account.
 *
 * Wires the usage-v2 schema. Monetary amount fields are decimal
 * strings or `null` — no client-side Number coercion.
 *
 * Authenticated `disabled`/`unavailable`/`restricted` returns HTTP 200
 * with `state`/`reason` and nullable amounts. A missing, unknown, or
 * malformed response is `null` — not an auth error. HTTP 401/403 still
 * throw the existing typed errors.
 */
export interface CreditAccount {
  schemaVersion: "usage-v2";
  snapshotAt: string;
  scope: { orgId: string };
  state: "ready" | "disabled" | "unavailable" | "restricted";
  reason: string | null;
  plan: { id: "pro" | "gold" | "enterprise" | null; name: string | null; monthlyPriceUsd: string | null };
  included: { state: "active" | "exhausted" | "none" | "unavailable"; usedPercent: number | null; resetsAt: string | null };
  prepaid: { balanceUsd: string | null; fallbackEnabled: boolean };
  canManageBilling: boolean;
  admission: { eligible: boolean; reason: string | null };
}

/**
 * Bounded runtime type guard for the CreditAccount usage-v2 wire shape.
 *
 * Checks the top-level discriminator (`schemaVersion === "usage-v2"`),
 * structural fields, and type discipline. Unrecognised / legacy /
 * structurally invalid payloads return `false`, which surfaces
 * as a `null` account — never an auth failure.
 *
 * Retains an explicit set of known fields so a structurally valid
 * response passes even when optional server-side extras are present;
 * the caller (getInferenceAccount) strips those via destructuring.
 */
function isUsageAccount(raw: unknown): raw is CreditAccount {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;

  // ── Discriminator — reject legacy and unknown schemas ──
  if (obj.schemaVersion !== "usage-v2") return false;

  // ── Required top-level fields ──
  if (!isUtcDate(obj.snapshotAt)) return false;

  // ── Scope ──
  if (!obj.scope || typeof obj.scope !== "object") return false;
  if (typeof (obj.scope as Record<string, unknown>).orgId !== "string") return false;

  // ── State ──
  if (typeof obj.state !== "string") return false;
  if (!["ready", "disabled", "unavailable", "restricted"].includes(obj.state)) return false;

  // ── Reason (string or null) ──
  if (obj.reason !== null && typeof obj.reason !== "string") return false;

  // ── plan ──
  const plan = obj.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return false;
  if (typeof plan.id !== "string" && plan.id !== null) return false;
  if (plan.id !== null && !["pro", "gold", "enterprise"].includes(plan.id)) return false;
  if (typeof plan.name !== "string" && plan.name !== null) return false;
  if (!isUsd(plan.monthlyPriceUsd)) return false;

  // ── included ──
  const included = obj.included as Record<string, unknown> | undefined;
  if (!included || typeof included !== "object") return false;
  if (typeof included.state !== "string") return false;
  if (!["active", "exhausted", "none", "unavailable"].includes(included.state as string)) return false;
  if (included.usedPercent !== null && typeof included.usedPercent !== "number") return false;
  if (included.usedPercent !== null && (!Number.isFinite(included.usedPercent) || included.usedPercent < 0 || included.usedPercent > 100)) return false;
  if (included.resetsAt !== null && !isUtcDate(included.resetsAt)) return false;

  // ── prepaid ──
  const prepaid = obj.prepaid as Record<string, unknown> | undefined;
  if (!prepaid || typeof prepaid !== "object") return false;
  if (!isUsd(prepaid.balanceUsd)) return false;
  if (typeof prepaid.fallbackEnabled !== "boolean") return false;

  // ── canManageBilling ──
  if (typeof obj.canManageBilling !== "boolean") return false;

  // ── admission ──
  const admission = obj.admission as Record<string, unknown> | undefined;
  if (!admission || typeof admission !== "object") return false;
  if (typeof admission.eligible !== "boolean") return false;
  if (admission.reason !== null && typeof admission.reason !== "string") return false;

  return true;
}

function isUsd(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^\d+(?:\.\d{1,9})?$/.test(value));
}

function isUtcDate(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function healthPath(host: string): string {
  try {
    const hostname = new URL(host).hostname.toLowerCase();
    if (hostname === "cloud.0.ai" || hostname === "cloud.0.security") {
      return "/api/health";
    }
  } catch {
    // Preserve the generic path and let getJson surface the malformed host.
  }
  return "/health";
}


export class CloudClient {
  private readonly host: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: CloudClientOptions) {
    this.host = opts.host;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Verify cloud reachability through its health route. The hosted dashboard
   * uses `/api/health`; a self-hosted receiver uses `/health`.
   */
  async pingHealth(): Promise<CloudHealthResponse> {
    return this.getJson<CloudHealthResponse>(healthPath(this.host));
  }

  /**
   * Fetch the hosted inference model catalog — available models, pricing,
   * wire API protocol, and context limits. Used at runtime for model
   * selection and by the hosted provider to determine per-model capabilities.
   * Returns the raw list response; the caller caches/filters as needed.
   */
  async getInferenceModels(): Promise<InferenceModelsResponse> {
    return this.getJson<InferenceModelsResponse>("/api/inference/v1/models");
  }

  /**
   * Fetch the organization's credit account — usage-v2 shape including
   * plan, included allowance, prepaid balance, and admission status.
   *
   * Returns `null` when the response is a recognised HTTP 200 (customer is
   * authenticated) but the payload is missing, legacy, or structurally
   * unrecognised — not an auth failure. HTTP 401/403 still throw the
   * existing typed errors so the caller can distinguish a credential
   * problem from unsupported credit data.
   *
   * Monetary amounts are decimal strings (no Number coercion); the
   * caller preserves them for exact display.
   */
  async getInferenceAccount(): Promise<CreditAccount | null> {
    const raw = await this.getJson<unknown>("/api/inference/account");
    if (!isUsageAccount(raw)) return null;
    // Return only the customer-contract fields. A valid usage-v2 payload
    // must not smuggle private accounting metadata into CLI JSON.
    const { plan, included, prepaid, admission } = raw;
    return {
      schemaVersion: raw.schemaVersion,
      snapshotAt: raw.snapshotAt,
      scope: { orgId: raw.scope.orgId },
      state: raw.state,
      reason: raw.reason,
      plan: {
        id: plan.id,
        name: plan.name,
        monthlyPriceUsd: plan.monthlyPriceUsd,
      },
      included: {
        state: included.state,
        usedPercent: included.usedPercent,
        resetsAt: included.resetsAt,
      },
      prepaid: {
        balanceUsd: prepaid.balanceUsd,
        fallbackEnabled: prepaid.fallbackEnabled,
      },
      canManageBilling: raw.canManageBilling,
      admission: { eligible: admission.eligible, reason: admission.reason },
    };
  }

  /**
   * Fetch request-level usage metadata for the operator's hosted
   * inference sessions. Returns lightweight metadata records (model,
   * tokens, provider, timestamp) — no prompt/response payload.
   */
  async getInferenceUsage(): Promise<InferenceUsageResponse> {
    return this.getJson<InferenceUsageResponse>("/api/inference/usage");
  }

  // ── Audit-skills helpers (#audit-skills) ──

  /** List all audit skills for the authenticated organization. */
  async listAuditSkills(): Promise<AuditSkillsListResponse> {
    return this.getJson<AuditSkillsListResponse>("/api/audit-skills");
  }

  /**
   * Get a single audit skill with its revision history and project
   * assignments.
   */
  async getAuditSkill(id: string): Promise<AuditSkillDetailResponse> {
    return this.getJson<AuditSkillDetailResponse>(`/api/audit-skills/${encodeURIComponent(id)}`);
  }

  /** Create a new markdown-based audit skill. */
  async createAuditSkill(
    input: AuditSkillCreateInput,
  ): Promise<AuditSkillCreateResponse> {
    return this.postJson<AuditSkillCreateResponse>("/api/audit-skills", input);
  }

  /** Import an audit skill from a GitHub repository. */
  async importAuditSkillFromGithub(
    input: AuditSkillImportInput,
  ): Promise<AuditSkillCreateResponse> {
    return this.postJson<AuditSkillCreateResponse>(
      "/api/audit-skills/import",
      input,
    );
  }

  /** Create a new revision of an audit skill (CAS — 409 on stale expectedRevision). */
  async createAuditSkillRevision(
    id: string,
    input: AuditSkillRevisionInput,
  ): Promise<AuditSkillCreateResponse> {
    return this.postJson<AuditSkillCreateResponse>(
      `/api/audit-skills/${encodeURIComponent(id)}/revisions`,
      input,
    );
  }

  /** Re-fetch the skill from its original GitHub source. */
  async syncAuditSkill(
    id: string,
    expectedRevision: number,
  ): Promise<AuditSkillCreateResponse> {
    return this.postJson<AuditSkillCreateResponse>(
      `/api/audit-skills/${encodeURIComponent(id)}/sync`,
      { expectedRevision } satisfies AuditSkillSyncInput,
    );
  }

  /** Pin an audit skill revision to a project for future scans. */
  async assignAuditSkill(
    id: string,
    projectId: string,
    revisionId: string,
  ): Promise<AuditSkillBindResponse> {
    return this.postJson<AuditSkillBindResponse>(
      `/api/audit-skills/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`,
      { revisionId } satisfies AuditSkillAssignInput,
    );
  }

  /** Unpin an audit skill from a project (future scans no longer use it). */
  async unassignAuditSkill(
    id: string,
    projectId: string,
  ): Promise<AuditSkillBindResponse> {
    return this.deleteJson<AuditSkillBindResponse>(
      `/api/audit-skills/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`,
    );
  }

  /** Archive an audit skill (disables future bindings, preserves history). */
  async archiveAuditSkill(id: string): Promise<void> {
    await this.deleteJson<void>(
      `/api/audit-skills/${encodeURIComponent(id)}`,
    );
  }

  /**
   * List audit skills available to a specific project, along with current
   * assignments for that project. The project must belong to the caller's org.
   */
  async listAuditSkillsByProject(
    projectId: string,
  ): Promise<AuditSkillsByProjectResponse> {
    return this.getJson<AuditSkillsByProjectResponse>(
      `/api/audit-skills/by-project/${encodeURIComponent(projectId)}`,
    );
  }

  /**
   * Generic JSON DELETE helper with the same error mapping as getJson/postJson.
   * Used by `0 service disconnect` to remove scan schedules.
   */
  async deleteJson<T = unknown>(path: string): Promise<T> {
    const url = `${this.host}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "DELETE",
        headers: { ...this.headers(), "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CloudNetworkError(this.scrub(msg), path);
    }
    if (!res.ok) {
      let code: string | undefined;
      try {
        const parsed = (await res.json()) as { error?: { code?: unknown } | string } | null;
        const raw = typeof parsed?.error === "object" ? parsed.error?.code : undefined;
        if (typeof raw === "string" && raw.length > 0) code = raw;
      } catch { /* no / malformed body */ }
      this.throwForStatus(res.status, path, code);
    }
    // 204 No Content is the orchestrator's successful-delete contract
    // (scan-schedules). res.json() on an empty body throws — treat it as
    // success with no payload instead of misreporting a completed delete.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Generic JSON POST helper with the same error mapping as getJson.
   * Used by `0 connect` to enqueue scans and schedules.
   */
  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = `${this.host}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CloudNetworkError(this.scrub(msg), path);
    }
    if (!res.ok) {
      let code: string | undefined;
      try {
        const parsed = (await res.json()) as { error?: { code?: unknown } | string } | null;
        const raw = typeof parsed?.error === "object" ? parsed.error?.code : undefined;
        if (typeof raw === "string" && raw.length > 0) code = raw;
      } catch { /* no / malformed body */ }
      this.throwForStatus(res.status, path, code);
    }
    return (await res.json()) as T;
  }

  /**
   * Generic JSON GET helper. Public so future modules (scans, findings)
   * can reuse the same error mapping without duplicating it. Not exported
   * past the package boundary — see ./index.ts.
   */
  async getJson<T = unknown>(path: string): Promise<T> {
    const url = `${this.host}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CloudNetworkError(this.scrub(msg), path);
    }

    if (!res.ok) {
      // The gateway returns a machine code in the body (`{error:{code}}`) — read it
      // so a deliberate 503 gate (`inference_disabled`) is distinguishable from an
      // outage. Best-effort: a missing / non-JSON body leaves the code undefined.
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: { code?: unknown } } | null;
        const raw = body?.error?.code;
        if (typeof raw === "string" && raw.length > 0) code = raw;
      } catch { /* no / malformed body */ }
      this.throwForStatus(res.status, path, code);
    }
    return (await res.json()) as T;
  }

  /** Throw a typed error for a non-2xx status, carrying the gateway's body `code`. */
  throwForStatus(status: number, path: string, code?: string): never {
    if (status === 401) throw new CloudUnauthorizedError(path);
    if (status === 403) throw new CloudForbiddenError(path);
    throw new CloudError(
      `0-cloud request failed (HTTP ${status}${code ? ` ${code}` : ""}) on ${path}.`,
      status,
      path,
      code,
    );
  }

  /**
   * Throw a typed error for non-2xx responses. Public so direct callers
   * (e.g. an integration test driving raw fetch) can reuse the mapping.
   */
  assertOk(res: Response, path: string): void {
    if (res.ok) return;
    if (res.status === 401) throw new CloudUnauthorizedError(path);
    if (res.status === 403) throw new CloudForbiddenError(path);
    throw new CloudError(
      `0-cloud request failed (HTTP ${res.status}) on ${path}.`,
      res.status,
      path,
    );
  }

  // ── internals ──

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": `@0/cli/${VERSION}`,
    };
  }

  /**
   * Strip anything that looks like our own token from a string. The
   * cloud token may be interpolated into a TLS-layer error message in
   * exotic failure modes — we redact it to keep the no-leak invariant
   * local to this module.
   */
  private scrub(s: string): string {
    if (!this.token) return s;
    return s.split(this.token).join("[REDACTED]");
  }
}