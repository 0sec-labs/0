import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homeStateDir, VERSION } from "@0/shared"
import { z } from "zod";
import { analyticsOptedOut } from "./analytics-level.js";
import { redactRecordStrings } from "./analytics-pipeline.js";
import { loadCloudCredentials } from "../cloud/credentials.js";
import type { NativeRuntime } from "../runtime/types.js";

export const CONTRIBUTION_ENDPOINT = "/api/run-contributions";
export const contributionPurposeSchema = z.enum(["operational", "internal_evaluation", "harness_improvement", "model_training", "licensing", "public_release"]);
export type ContributionPurpose = z.infer<typeof contributionPurposeSchema>;
const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:-]+$/);
const date = z.string().datetime({ offset: true });
const amount = z.number().finite().nonnegative().nullable();
export const contributionReceiptSchema = z.object({
  schemaVersion: z.literal(1), id, orgId: id, authorizedBy: z.string().min(1), authority: z.literal("organization_admin"),
  termsId: z.string().min(1), issuedAt: date, expiresAt: date, status: z.enum(["active", "blocked", "withdrawn"]),
  purposes: z.array(contributionPurposeSchema).min(1).max(6).refine(values => new Set(values).size === values.length),
  capture: z.object({ modelContent: z.boolean(), toolContent: z.boolean(), scopeContent: z.boolean() }).strict(),
  policyId: z.string().min(1),
}).strict();
export type ContributionReceipt = z.infer<typeof contributionReceiptSchema>;
export const contributionManifestSchema = z.object({
  schemaVersion: z.literal(1), runId: id, attemptId: id, orgId: id, receiptId: id,
  startedAt: date, endedAt: date.nullable(), engineVersion: z.string(), model: z.string(), scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  objective: z.string().nullable(), scope: z.unknown().nullable(),
  execution: z.enum(["not_started", "running", "completed", "interrupted", "failed"]),
  termination: z.enum(["objective_met", "plan_exhausted", "no_progress", "operator_cancelled", "scope_blocked", "safety_blocked", "model_refused", "prerequisite_missing", "target_unavailable", "target_changed", "timeout", "run_resource_limit", "provider_rate_limited", "provider_error", "tool_error", "harness_error", "unknown"]),
  securityOutcome: z.enum(["not_tested", "hypothesis_only", "attempted_unverified", "partial_impact_verified", "objective_impact_verified", "no_effect_observed", "control_block_verified", "claim_refuted", "inconclusive", "conflicting_evidence"]),
  verification: z.enum(["not_run", "reproduced", "not_reproduced", "flaky", "invalid_evidence", "verifier_error", "inconclusive"]),
  remediation: z.enum(["not_requested", "proposed", "applied_unverified", "verified_fixed", "still_reproduces", "regressed", "retest_inconclusive"]),
  quality: z.array(z.enum(["complete", "partial", "redacted", "truncated", "corrupt", "untrusted_submission"])),
  usage: z.object({ inputTokens: amount, outputTokens: amount, costUsd: amount, durationMs: amount }).strict(),
  versions: z.record(z.string().min(1).max(256), z.string().max(512)),
}).strict();
export type RunManifest = z.infer<typeof contributionManifestSchema>;
export const contributionTransitionSchema = z.object({
  schemaVersion: z.literal(1), runId: id, attemptId: id, agentId: id, parentAgentId: id.nullable(),
  sequence: z.number().int().nonnegative(), timestamp: date,
  kind: z.enum(["model_input", "model_output", "tool_call", "tool_result", "compaction", "truncation", "checkpoint", "resume", "correction", "verification", "remediation", "graph", "termination", "routing"]),
  data: z.record(z.string(), z.unknown()),
}).strict();
export type RunTransition = z.infer<typeof contributionTransitionSchema>;
export const contributionChunkSchema = z.object({
  schemaVersion: z.literal(1), manifest: contributionManifestSchema, receipt: contributionReceiptSchema,
  chunkIndex: z.number().int().nonnegative(), transitions: z.array(contributionTransitionSchema), final: z.boolean(), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ContributionChunk = z.infer<typeof contributionChunkSchema>;
export const contributionClientPolicySchema = z.object({
  policyId: z.string().min(1), adoptedTermsIds: z.array(z.string().min(1)).min(1), region: z.string().min(1),
  spoolRetentionMs: z.number().int().positive(), maxSpoolBytes: z.number().int().min(65536),
  maxChunkBytes: z.number().int().min(8192), maxTransitionsPerChunk: z.number().int().positive(),
}).strict();
export type ContributionClientPolicy = z.infer<typeof contributionClientPolicySchema>;
export interface RunContributionClientConfig {
  policy: ContributionClientPolicy;
  spoolDir: string;
  orgId: string;
  /** A current receipt from explicit authoritative enrollment, never analytics or billing. */
  enrollment: () => unknown;
  credentials: () => { host: string; token: string };
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Additional configured target credentials. Never persisted. */
  authSecretValues?: readonly string[];
}
export interface BeginContribution {
  runId: string; attemptId?: string; model: string; scope: unknown; objective?: string | null; versions?: Record<string, string>;
  authSecretValues?: readonly string[];
}
export type ContributionUploadResult = { status: "uploaded"; nextChunkIndex: number } | { status: "denied" | "offline" | "pending"; reason: string };
const PROCESS_INSTANCE = randomUUID();
const context = new AsyncLocalStorage<{ capture: RunCapture; agentId: string; parentAgentId: string | null }>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function atomic(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
/** Remove only opaque provider material in the COPY. The live provider roundtrip is untouched. */
function exportable(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(item => !(item && typeof item === "object" && (item as Record<string, unknown>).type === "redacted_thinking")).map(exportable);
  if (value && typeof value === "object") {
    if ((value as Record<string, unknown>).type === "redacted_thinking") return { type: "opaque_provider_block_omitted" };
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      if (/^(encrypted_content|encryptedContent|signature|thinking|reasoning_content|reasoning)$/i.test(key)) continue;
      out[key] = exportable(item);
    }
    return out;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" ? null : value;
}
function scrub(value: unknown, authSecretValues: readonly string[] = []): unknown {
  try { return redactRecordStrings(exportable(value), { authSecretValues, maxChars: Number.MAX_SAFE_INTEGER }); }
  catch { return null; }
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Contribution spool must be a private owned directory");
}
function claimSpool(path: string): void {
  privateDirectory(path);
  const lock = join(path, "writer.json");
  if (existsSync(lock)) {
    const owner = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(readFileSync(lock, "utf8")));
    if (owner.pid === process.pid) return;
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error("Contribution spool is owned by another running process");
    rmSync(lock);
  }
  const fd = openSync(lock, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(path);
}

export class RunContributionClient {
  readonly policy: ContributionClientPolicy;
  private readonly uploads = new Map<string, Promise<ContributionUploadResult>>();
  private readonly withdrawn = new Set<string>();
  constructor(readonly config: RunContributionClientConfig) {
    this.policy = contributionClientPolicySchema.parse(config.policy);
    id.parse(config.orgId);
    if (!isAbsolute(config.spoolDir)) throw new Error("Contribution spool path must be absolute");
    // Enrollment absent or invalid stays unavailable; constructing does not create a spool.
  }
  permission(receipt?: ContributionReceipt, purpose: ContributionPurpose = "operational"): ContributionReceipt | null {
    if (analyticsOptedOut(this.config.env ?? process.env)) return null;
    try {
      const current = contributionReceiptSchema.parse(this.config.enrollment());
      if (this.withdrawn.has(current.id)) return null;
      const now = Date.now();
      if (current.status !== "active" || current.orgId !== this.config.orgId || current.policyId !== this.policy.policyId
        || !this.policy.adoptedTermsIds.includes(current.termsId) || !current.purposes.includes(purpose)
        || Date.parse(current.issuedAt) > now || Date.parse(current.expiresAt) <= now
        || Date.parse(current.expiresAt) <= Date.parse(current.issuedAt)
        || (receipt && JSON.stringify(current) !== JSON.stringify(receipt))) return null;
      return current;
    } catch { return null; }
  }
  begin(input: BeginContribution): RunCapture | null {
    const receipt = this.permission();
    if (!receipt) return null;
    claimSpool(this.config.spoolDir);
    this.expire();
    if (this.spoolBytes(true) + this.policy.maxChunkBytes + 16384 >= this.policy.maxSpoolBytes) return null;
    const secrets = [...(this.config.authSecretValues ?? []), ...(input.authSecretValues ?? [])];
    const scope = receipt.capture.scopeContent ? scrub(input.scope, secrets) ?? null : null;
    const manifest = contributionManifestSchema.parse({
      schemaVersion: 1, runId: input.runId, attemptId: input.attemptId ?? randomUUID(), orgId: receipt.orgId, receiptId: receipt.id,
      startedAt: new Date().toISOString(), endedAt: null, engineVersion: VERSION, model: input.model,
      scopeHash: hash(JSON.stringify(scope)), scope, objective: receipt.capture.scopeContent ? scrub(input.objective ?? null, secrets) : null,
      execution: "running", termination: "unknown", securityOutcome: "not_tested", verification: "not_run", remediation: "not_requested",
      quality: ["partial", "redacted", "untrusted_submission"], usage: { inputTokens: null, outputTokens: null, costUsd: null, durationMs: null },
      versions: scrub({ engine: VERSION, contribution: "1", ...input.versions }),
    });
    if (Buffer.byteLength(JSON.stringify({ manifest, receipt })) > this.policy.maxChunkBytes / 4) return null;
    const directory = this.path(manifest.runId, manifest.attemptId);
    mkdirSync(directory, { mode: 0o700 }); // Exclusive attempt ownership; no accidental concurrent append.
    const capture = new RunCapture(this, directory, manifest, receipt, 0);
    capture.protectSecrets(secrets);
    capture.persist();
    if (capture.failure) return null;
    syncDirectory(this.config.spoolDir);
    return capture;
  }
  path(runId: string, attemptId: string): string { return join(this.config.spoolDir, hash(`${id.parse(runId)}\0${id.parse(attemptId)}`)); }
  spoolBytes(includeReservations = false): number {
    let bytes = 0;
    for (const name of readdirSync(this.config.spoolDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const directory = join(this.config.spoolDir, name);
      if (!lstatSync(directory).isDirectory()) continue;
      for (const file of readdirSync(directory)) bytes += lstatSync(join(directory, file)).size;
      if (includeReservations && !existsSync(join(directory, "chunks.json"))) {
        const metadata = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
        bytes += typeof metadata.reservedSealBytes === "number" ? metadata.reservedSealBytes : this.policy.maxChunkBytes;
      }
    }
    return bytes;
  }
  /** Reopen after a crash; executing tools is NEVER replayed by the uploader. */
  recover(runId: string, attemptId: string): RunCapture {
    claimSpool(this.config.spoolDir);
    const directory = this.path(runId, attemptId);
    if (!existsSync(directory)) throw new Error("Contribution attempt not found");
    privateDirectory(directory);
    const raw = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    const manifest = contributionManifestSchema.parse(raw.manifest);
    const receipt = contributionReceiptSchema.parse(raw.receipt);
    if (manifest.orgId !== this.config.orgId || manifest.runId !== runId || manifest.attemptId !== attemptId) throw new Error("Contribution identity mismatch");
    const transitions = RunCapture.readTransitions(directory);
    const capture = new RunCapture(this, directory, manifest, receipt, transitions.length, raw.reservedSealBytes);
    capture.protectSecrets(this.config.authSecretValues ?? []);
    if (manifest.endedAt === null) {
      capture.finish("interrupted", "unknown");
    }
    return capture;
  }
  expire(now = Date.now()): string[] {
    const removed: string[] = [];
    if (!existsSync(this.config.spoolDir)) return removed;
    claimSpool(this.config.spoolDir);
    for (const name of readdirSync(this.config.spoolDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const path = join(this.config.spoolDir, name);
      const value = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
      if (now >= Math.min(Date.parse(value.manifest.startedAt) + this.policy.spoolRetentionMs, Date.parse(value.receipt.expiresAt))) {
        rmSync(path, { recursive: true }); removed.push(name);
      }
    }
    return removed;
  }
  /** Explicit local withdrawal; authoritative service withdrawal must also be performed. */
  withdraw(receiptId: string): string[] {
    this.withdrawn.add(receiptId);
    const removed: string[] = [];
    if (!existsSync(this.config.spoolDir)) return removed;
    claimSpool(this.config.spoolDir);
    for (const name of readdirSync(this.config.spoolDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const path = join(this.config.spoolDir, name);
      const value = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
      if (value.receipt.id === receiptId && value.receipt.orgId === this.config.orgId) { rmSync(path, { recursive: true }); removed.push(name); }
    }
    return removed;
  }
  /** Recover dead-owner attempts, then retry upload; never replay tools or finalize a live owner. */
  async flush(): Promise<ContributionUploadResult[]> {
    if (!existsSync(this.config.spoolDir)) return [];
    claimSpool(this.config.spoolDir);
    const results: ContributionUploadResult[] = [];
    for (const name of readdirSync(this.config.spoolDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      try {
        const value = JSON.parse(readFileSync(join(this.config.spoolDir, name, "manifest.json"), "utf8"));
        let abandoned = value.ownerPid === process.pid && value.ownerInstance !== PROCESS_INSTANCE;
        if (Number.isSafeInteger(value.ownerPid) && value.ownerPid > 0 && value.ownerPid !== process.pid) {
          try { process.kill(value.ownerPid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") abandoned = true; }
        }
        if (value.manifest.endedAt !== null || abandoned) results.push(await this.upload(this.recover(value.manifest.runId, value.manifest.attemptId)));
      } catch { results.push({ status: "pending", reason: "corrupt_spool" }); }
    }
    return results;
  }
  upload(capture: RunCapture): Promise<ContributionUploadResult> {
    const key = capture.directory;
    const existing = this.uploads.get(key);
    if (existing) return existing;
    const pending = this.transmit(capture).finally(() => this.uploads.delete(key));
    this.uploads.set(key, pending);
    return pending;
  }
  private async transmit(capture: RunCapture): Promise<ContributionUploadResult> {
    const denied = (): ContributionUploadResult | null => {
      if (analyticsOptedOut(this.config.env ?? process.env)) return { status: "offline", reason: "environment_opt_out" };
      if (!this.permission(capture.receipt) || Date.now() >= Date.parse(capture.manifest.startedAt) + this.policy.spoolRetentionMs) return { status: "denied", reason: "permission_or_retention" };
      return null;
    };
    const gate = denied(); if (gate) return gate;
    try {
      if (capture.client !== this) throw new Error("Wrong contribution client");
      const chunks = capture.seal();
      const { host, token } = this.config.credentials();
      const url = new URL(host);
      if (!token || url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Invalid contribution transport configuration");
      const base = `${host.replace(/\/$/, "")}${CONTRIBUTION_ENDPOINT}/${encodeURIComponent(capture.manifest.runId)}/${encodeURIComponent(capture.manifest.attemptId)}`;
      const request = this.config.fetch ?? fetch;
      const options = { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, redirect: "error" as const, signal: AbortSignal.timeout(10000) };
      const beforeStatus = denied(); if (beforeStatus) return beforeStatus;
      const status = await request(base, options);
      let next = 0;
      if (status.ok) {
        const remote = z.object({ nextChunkIndex: z.number().int().nonnegative(), complete: z.boolean() }).parse(await status.json());
        next = remote.nextChunkIndex;
        if (next > chunks.length || remote.complete !== (next === chunks.length)) throw new Error("Invalid contribution resume cursor");
      } else if (status.status !== 404) {
        return { status: status.status === 401 || status.status === 403 ? "denied" : "pending", reason: `http_${status.status}` };
      }
      for (; next < chunks.length;) {
        const permission = denied(); if (permission) return permission;
        const response = await request(`${base}/chunks/${next}`, { ...options, signal: AbortSignal.timeout(10000), method: "POST", body: JSON.stringify(chunks[next]) });
        if (!response.ok) return { status: response.status === 401 || response.status === 403 ? "denied" : "pending", reason: `http_${response.status}` };
        const ack = z.object({ accepted: z.literal(true), nextChunkIndex: z.number().int() }).parse(await response.json());
        if (ack.nextChunkIndex !== next + 1) throw new Error("Invalid contribution acknowledgement");
        next = ack.nextChunkIndex;
        atomic(join(capture.directory, "upload.json"), { nextChunkIndex: next });
      }
      return { status: "uploaded", nextChunkIndex: next };
    } catch { return { status: "pending", reason: "transport_or_spool_failure" }; }
  }
}

export class RunCapture {
  private sealed = false;
  private exhausted = false;
  private missingUsage = false;
  private captureGap = false;
  private lastKind: RunTransition["kind"] | undefined;
  private readonly secrets = new Set<string>();
  /** An explicit capture failure, distinct from a target/model failure. */
  failure: "spool_io" | null = null;
  constructor(readonly client: RunContributionClient, readonly directory: string, readonly manifest: RunManifest, readonly receipt: ContributionReceipt, private sequence: number, private reservedSealBytes = client.policy.maxChunkBytes) {
    this.sealed = existsSync(join(directory, "chunks.json"));
  }
  /** Bind the real executor controls before the first transition; later changes are transitions. */
  setInitialScope(scope: unknown): void {
    if (this.sequence !== 0 || this.sealed || !this.client.permission(this.receipt)) return;
    const value = this.receipt.capture.scopeContent ? scrub(scope, [...this.secrets]) ?? null : null;
    if (Buffer.byteLength(JSON.stringify(value)) > this.client.policy.maxChunkBytes / 8) {
      this.markPartial("truncated");
      this.manifest.scope = null;
    } else this.manifest.scope = value;
    this.manifest.scopeHash = hash(JSON.stringify(this.manifest.scope));
    this.persist();
  }
  /** Add exact configured credential values before any content reaches the spool. */
  protectSecrets(values: readonly string[]): void { for (const value of values) if (value) this.secrets.add(value); }
  persist(): void {
    try {
      atomic(join(this.directory, "manifest.json"), { manifest: this.manifest, receipt: this.receipt, reservedSealBytes: this.reservedSealBytes, ownerPid: process.pid, ownerInstance: PROCESS_INSTANCE });
      syncDirectory(this.directory);
    } catch { this.failCapture(); }
  }
  private failCapture(): void {
    this.captureGap = true;
    this.manifest.quality = this.manifest.quality.filter(value => value !== "complete");
    if (!this.manifest.quality.includes("partial")) this.manifest.quality.push("partial");
    if (!this.failure) process.stderr.write("[0sec] Run contribution incomplete: private spool write failed; upload withheld.\n");
    this.failure = "spool_io";
  }
  static readTransitions(directory: string): RunTransition[] {
    let text: string;
    try { text = readFileSync(join(directory, "transitions.jsonl"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return text.split("\n").filter(Boolean).map((line, sequence) => {
      const transition = contributionTransitionSchema.parse(JSON.parse(line));
      if (transition.sequence !== sequence) throw new Error("Corrupt contribution ordering");
      return transition;
    });
  }
  load(): { manifest: RunManifest; receipt: ContributionReceipt; transitions: RunTransition[] } {
    return { manifest: structuredClone(this.manifest), receipt: structuredClone(this.receipt), transitions: RunCapture.readTransitions(this.directory) };
  }
  record(kind: RunTransition["kind"], data: Record<string, unknown>, agentId?: string, parentAgentId?: string | null): void {
    if (this.failure) return;
    if (this.sealed) throw new Error("Contribution is sealed");
    if (this.exhausted) return;
    try {
    if (!this.client.permission(this.receipt)) { this.captureGap = true; this.markPartial(); return; }
    const current = context.getStore();
    let safe = scrub(data, [...this.secrets]) as Record<string, unknown> | null;
    if (!safe) { safe = { contentOmitted: "serialization" }; this.markPartial("corrupt"); }
    if (!this.receipt.capture.scopeContent) { delete safe.effectiveScope; delete safe.scope; }
    // Native model history embeds tool results and scope. Without all content rights
    // it cannot safely be decomposed, so withhold it rather than leak through another kind.
    if ((kind === "model_input" || kind === "model_output") && (!this.receipt.capture.modelContent || !this.receipt.capture.toolContent || !this.receipt.capture.scopeContent)) safe = { contentOmitted: "permission" };
    if ((kind === "tool_call" || kind === "tool_result") && (!this.receipt.capture.toolContent || !this.receipt.capture.scopeContent)) safe = { contentOmitted: "permission" };
    if (safe.contentOmitted) { this.captureGap = true; this.markPartial(); }
    if (kind === "termination" && (!this.receipt.capture.modelContent || !this.receipt.capture.toolContent || !this.receipt.capture.scopeContent)) delete safe.error;
    if (kind === "truncation") this.markPartial("truncated");
    const transition = contributionTransitionSchema.parse({ schemaVersion: 1, runId: this.manifest.runId, attemptId: this.manifest.attemptId,
      agentId: agentId ?? current?.agentId ?? "root", parentAgentId: parentAgentId ?? current?.parentAgentId ?? null,
      sequence: this.sequence, timestamp: new Date().toISOString(), kind, data: safe });
    const allowance = Math.floor(this.client.policy.maxChunkBytes / 2);
    if (Buffer.byteLength(JSON.stringify(transition)) > allowance) {
      transition.kind = "truncation";
      transition.data = { reason: "transition_size", originalKind: kind, originalBytes: Buffer.byteLength(JSON.stringify(transition)) };
      this.markPartial("truncated");
    }
    const bytes = Buffer.byteLength(JSON.stringify(transition));
    const reserve = bytes + Buffer.byteLength(JSON.stringify({ manifest: this.manifest, receipt: this.receipt })) + 1024;
    if (this.client.spoolBytes(true) + bytes + reserve + 16384 >= this.client.policy.maxSpoolBytes) {
      transition.kind = "truncation"; transition.data = { reason: "spool_capacity", originalKind: kind };
      this.exhausted = true; this.markPartial("truncated");
    } else {
      this.reservedSealBytes += reserve;
      this.persist();
    }
    try {
      const fd = openSync(join(this.directory, "transitions.jsonl"), "a", 0o600);
      try { appendFileSync(fd, `${JSON.stringify(transition)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      this.sequence++;
      this.lastKind = transition.kind;
    } catch { this.failCapture(); }
    } catch { this.failCapture(); }
  }
  markPartial(flag: "partial" | "truncated" | "corrupt" = "partial"): void {
    this.manifest.quality = this.manifest.quality.filter(value => value !== "complete");
    for (const value of ["partial" as const, flag]) if (!this.manifest.quality.includes(value)) this.manifest.quality.push(value);
    this.persist();
  }
  /** Independently adjudicated signals; recording data never installs trusted guidance. */
  recordSignal(kind: "correction" | "verification" | "remediation" | "graph", data: Record<string, unknown>, outcomes: Partial<Pick<RunManifest, "securityOutcome" | "verification" | "remediation">> = {}): void {
    if (this.sealed || this.failure || !this.client.permission(this.receipt) || !Object.values(this.receipt.capture).every(Boolean)) throw new Error("Contribution signals unavailable");
    if (typeof data.adjudicator !== "string" || !data.adjudicator || typeof data.evidenceRef !== "string" || !data.evidenceRef) throw new Error("Independent adjudicator and evidenceRef required");
    const updated = contributionManifestSchema.parse({ ...this.manifest, ...outcomes });
    const before = this.sequence;
    this.record(kind, { ...data, trust: "untrusted_submission" });
    if (this.exhausted || before === this.sequence || this.lastKind !== kind) throw new Error("Contribution signal was not captured");
    this.manifest.securityOutcome = updated.securityOutcome;
    this.manifest.verification = updated.verification;
    this.manifest.remediation = updated.remediation;
    this.persist();
  }
  addUsage(usage?: { inputTokens: number; outputTokens: number }): void {
    if (!this.client.permission(this.receipt)) { this.captureGap = true; return; }
    if (!usage) this.missingUsage = true;
    if (this.missingUsage) { this.manifest.usage.inputTokens = null; this.manifest.usage.outputTokens = null; }
    else if (usage) {
      this.manifest.usage.inputTokens = (this.manifest.usage.inputTokens ?? 0) + usage.inputTokens;
      this.manifest.usage.outputTokens = (this.manifest.usage.outputTokens ?? 0) + usage.outputTokens;
    }
    this.persist();
  }
  finish(execution: RunManifest["execution"], termination: RunManifest["termination"]): void {
    if (this.manifest.endedAt !== null) return;
    this.record("termination", { execution, termination });
    this.manifest.execution = execution; this.manifest.termination = termination;
    this.manifest.endedAt = new Date().toISOString();
    this.manifest.usage.durationMs = Date.parse(this.manifest.endedAt) - Date.parse(this.manifest.startedAt);
    if (execution === "completed" && !this.captureGap && !this.manifest.quality.includes("truncated") && !this.manifest.quality.includes("corrupt") && this.client.permission(this.receipt)) {
      this.manifest.quality = this.manifest.quality.filter(value => value !== "partial"); this.manifest.quality.push("complete");
    }
    this.persist();
  }
  seal(): ContributionChunk[] {
    if (this.failure) throw new Error("Contribution spool failure");
    const path = join(this.directory, "chunks.json");
    try {
      const chunks = z.array(contributionChunkSchema).parse(JSON.parse(readFileSync(path, "utf8")));
      let sequence = 0;
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.chunkIndex !== index || chunk.final !== (index === chunks.length - 1)
          || chunk.digest !== hash(JSON.stringify(chunk.transitions))
          || JSON.stringify(chunk.manifest) !== JSON.stringify(this.manifest)
          || JSON.stringify(chunk.receipt) !== JSON.stringify(this.receipt)) throw new Error("Corrupt sealed contribution");
        for (const transition of chunk.transitions) {
          if (transition.sequence !== sequence++ || transition.runId !== this.manifest.runId || transition.attemptId !== this.manifest.attemptId) throw new Error("Corrupt sealed ordering");
        }
      }
      if (!chunks.length) throw new Error("Missing sealed contribution");
      this.sealed = true; return chunks;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!this.manifest.endedAt) throw new Error("Finish contribution before upload");
    const transitions = this.load().transitions;
    const chunks: ContributionChunk[] = [];
    let batch: RunTransition[] = [];
    let batchBytes = 0;
    const chunk = (items: RunTransition[], final: boolean): ContributionChunk => ({ schemaVersion: 1, manifest: this.manifest, receipt: this.receipt, chunkIndex: chunks.length, transitions: items, final, digest: hash(JSON.stringify(items)) });
    const overhead = Buffer.byteLength(JSON.stringify(chunk([], false))) + 32;
    for (const transition of transitions) {
      const bytes = Buffer.byteLength(JSON.stringify(transition)) + 1;
      if (batch.length && (batch.length === this.client.policy.maxTransitionsPerChunk || batchBytes + bytes + overhead > this.client.policy.maxChunkBytes)) {
        chunks.push(chunk(batch, false)); batch = []; batchBytes = 0;
      }
      batch.push(transition); batchBytes += bytes;
      if (batchBytes + overhead > this.client.policy.maxChunkBytes) throw new Error("Contribution metadata exceeds chunk limit");
    }
    chunks.push(chunk(batch, true));
    if (this.client.spoolBytes() + Buffer.byteLength(JSON.stringify(chunks)) > this.client.policy.maxSpoolBytes) throw new Error("Contribution spool capacity prevents sealing");
    atomic(path, chunks); syncDirectory(this.directory); this.sealed = true;
    this.reservedSealBytes = 0;
    this.persist();
    return chunks;
  }
}

export function currentRunContribution(): RunCapture | undefined { return context.getStore()?.capture; }
export function withRunContribution<T>(capture: RunCapture, agentId: string, parentAgentId: string | null, fn: () => T): T { return context.run({ capture, agentId, parentAgentId }, fn); }
export function currentContributionAgent(): string | undefined { return context.getStore()?.agentId; }
/** Capture the actual native runtime boundary, including summary/plugin requests. No live value is rewritten. */
export function captureNativeRuntime(runtime: NativeRuntime, capture: RunCapture): NativeRuntime {
  return new Proxy(runtime, {
    get(target, key) {
      if (key === "executeNative") return async (...args: Parameters<NativeRuntime["executeNative"]>) => {
        const requestId = randomUUID(); const started = Date.now();
        let partialText = "";
        let partialTruncated = false;
        const callbacks = args[3];
        let streamedUsage: { inputTokens: number; outputTokens: number } | undefined;
        const forwarded: Parameters<NativeRuntime["executeNative"]>[3] = {
          ...callbacks,
          onUsage: usage => { streamedUsage = usage; callbacks?.onUsage?.(usage); },
          onDelta: (scope, text) => {
            if (scope === "assistant_response") {
              const remaining = Math.max(0, Math.floor(capture.client.policy.maxChunkBytes / 8) - partialText.length);
              partialText += text.slice(0, remaining);
              if (text.length > remaining) partialTruncated = true;
            }
            callbacks?.onDelta?.(scope, text);
          },
        };
        capture.record("model_input", { requestId, model: target.resolvedModel?.() ?? "unknown", system: args[0], messages: args[1], tools: args[2], boundary: "native_runtime" });
        try {
          const result = await target.executeNative(args[0], args[1], args[2], forwarded, args[4]);
          capture.record("model_output", { requestId, ...result, ...(result.stopReason === "error" ? { partialText } : {}), costUsd: null, durationMs: Date.now() - started });
          capture.addUsage(result.usage ?? streamedUsage);
          if (partialTruncated && result.stopReason === "error") capture.record("truncation", { reason: "interrupted_stream_limit", requestId });
          if (result.stopReason === "max_tokens") capture.record("truncation", { reason: "model_max_tokens", requestId });
          return result;
        } catch (error) {
          capture.record("model_output", { requestId, error: error instanceof Error ? error.message : String(error), cancelled: args[4]?.aborted ?? false, partialText, durationMs: Date.now() - started, costUsd: null });
          if (partialTruncated) capture.record("truncation", { reason: "interrupted_stream_limit", requestId });
          capture.addUsage(streamedUsage);
          throw error;
        }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
let configuredClient: RunContributionClient | undefined;
export function getConfiguredRunContributionClient(): RunContributionClient | undefined { return configuredClient; }
/** Explicit private configuration only. Analytics level and a paid wallet never enroll a run. */
export function configureRunContributionsFromEnvironment(): void {
  const file = process.env["ZERO_RUN_CONTRIBUTION_CONFIG"];
  configuredClient = undefined;
  if (!file || analyticsOptedOut()) return;
  const load = () => {
    const info = lstatSync(file);
    if (!isAbsolute(file) || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("Contribution enrollment file must be private and operator-owned");
    return z.object({ policy: contributionClientPolicySchema, orgId: id, receipt: contributionReceiptSchema, spoolDir: z.string().optional() }).strict().parse(JSON.parse(readFileSync(file, "utf8")));
  };
  const config = load();
  configuredClient = new RunContributionClient({ policy: config.policy, orgId: config.orgId, spoolDir: config.spoolDir ?? join(homeStateDir(), "run-contributions"), enrollment: () => load().receipt, credentials: () => loadCloudCredentials() });
  void configuredClient.flush().catch(() => { process.stderr.write("[0sec] Run contribution upload pending: private spool unavailable.\n"); });
}
export function reportUnsupportedContributionMode(mode: string): void {
  if (configuredClient?.permission() || currentRunContribution()) process.stderr.write(`[0sec] Run contribution unavailable for ${mode}; no complete native transcript.\n`);
}
