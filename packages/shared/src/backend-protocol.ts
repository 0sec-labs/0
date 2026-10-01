import { z } from "zod";

/** Version of 0's frontend/engine HTTP and event contract, independent of model APIs. */
export const BACKEND_PROTOCOL_VERSION = 1 as const;
export const BACKEND_CAPABILITIES = [
  "sessions", "workflows", "workflow-engine", "schedules", "approvals", "events", "workspaces", "artifacts", "model-connections", "process-controls", "operator-services",
] as const;
export type BackendCapability = typeof BACKEND_CAPABILITIES[number];
export const BackendCapabilitySchema = z.enum(BACKEND_CAPABILITIES);
export const BackendIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Reserved backend identifier.");
const backendId = BackendIdSchema;
export const BackendRequestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
  .refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Reserved request identifier.");
const resourceId = z.string().min(1).max(4096);
const capabilityList = z.array(z.string().min(1).max(128).regex(/^[a-z][a-z0-9.-]*$/)).max(128)
  .refine(values => new Set(values).size === values.length, "Backend capabilities must be unique.");
export const BackendConnectionStatusSchema = z.enum(["connecting", "connected", "disconnected", "incompatible", "error"]);
export type BackendConnectionStatus = z.infer<typeof BackendConnectionStatusSchema>;
export const BackendPlatformSchema = z.object({ os: z.string().min(1).max(64), pathStyle: z.enum(["posix", "windows"]) }).strict();
export type BackendPlatform = z.infer<typeof BackendPlatformSchema>;

/** Safe for browser persistence. Authentication and endpoint routing stay with the trusted host. */
export const BackendDescriptorSchema = z.object({
  id: backendId,
  name: z.string().trim().min(1).max(160),
  transport: z.enum(["local", "http"]),
  status: BackendConnectionStatusSchema,
  protocolVersion: z.number().int().positive().optional(),
  /** Unknown advertised names are retained for forward compatibility, never implicitly dispatched. */
  capabilities: capabilityList.default([]),
  platform: BackendPlatformSchema.optional(),
  error: z.string().max(4096).optional(),
}).strict();
export type BackendDescriptor = z.infer<typeof BackendDescriptorSchema>;
export const BackendListSchema = z.object({ backends: z.array(BackendDescriptorSchema).min(1).max(64) }).strict()
  .superRefine((value, context) => {
    if (new Set(value.backends.map(backend => backend.id)).size !== value.backends.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Backend IDs must be unique." });
  });

/** Engine identity is server-owned; descriptor ID is the frontend's registered connection namespace. */
export const BackendHandshakeSchema = z.object({
  protocolVersion: z.number().int().positive(),
  engineId: backendId,
  capabilities: capabilityList,
  platform: BackendPlatformSchema,
  /** Connection epoch for detecting restarted event streams; does not replace retained run identity. */
  serverInstanceId: backendId.optional(),
}).strict();
export type BackendHandshake = z.infer<typeof BackendHandshakeSchema>;
export function parseBackendHandshake(value: unknown): BackendHandshake {
  const handshake = BackendHandshakeSchema.parse(value);
  if (handshake.protocolVersion !== BACKEND_PROTOCOL_VERSION) throw new Error(`Incompatible backend protocol ${handshake.protocolVersion}; this client supports ${BACKEND_PROTOCOL_VERSION}.`);
  return handshake;
}
export function hasBackendCapability(backend: Pick<BackendDescriptor, "capabilities">, capability: BackendCapability): boolean {
  return backend.capabilities.includes(capability);
}
export function requireBackendCapability(backend: Pick<BackendDescriptor, "id" | "status" | "capabilities" | "protocolVersion">, capability: BackendCapability): void {
  if (backend.status !== "connected") throw new Error(`Backend ${backend.id} is ${backend.status}.`);
  if (backend.protocolVersion !== BACKEND_PROTOCOL_VERSION) throw new Error(`Backend ${backend.id} uses an incompatible protocol.`);
  if (!hasBackendCapability(backend, capability)) throw new Error(`Backend ${backend.id} does not support ${capability}.`);
}

export const BackendResourceRefSchema = z.object({ backendId, id: resourceId }).strict();
export type BackendResourceRef = z.infer<typeof BackendResourceRefSchema>;
export type BackendResourceKind = "session" | "workspace" | "run" | "schedule" | "artifact" | "approval" | "model-connection";
export function backendResourceKey(kind: BackendResourceKind, reference: BackendResourceRef): string {
  const ref = BackendResourceRefSchema.parse(reference);
  return JSON.stringify(["backend", ref.backendId, kind, ref.id]);
}
export function backendResourceQueryKey(kind: BackendResourceKind, reference: BackendResourceRef): readonly ["backend", string, BackendResourceKind, string] {
  const ref = BackendResourceRefSchema.parse(reference);
  return ["backend", ref.backendId, kind, ref.id] as const;
}
/** Correlation and retries belong to one backend; a request ID is never portable approval. */
export const BackendRequestContextSchema = z.object({
  backendId, requestId: BackendRequestIdSchema, idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
export type BackendRequestContext = z.infer<typeof BackendRequestContextSchema>;
export const BackendEventCursorSchema = z.object({
  backendId, resourceId, sequence: z.number().int().nonnegative().safe(), serverInstanceId: backendId.optional(),
}).strict();
export type BackendEventCursor = z.infer<typeof BackendEventCursorSchema>;
/** UI routing metadata; the engine still checks the current operation and scope digest. */
export const BackendApprovalRefSchema = z.object({
  backendId, id: resourceId, sessionId: resourceId, runId: resourceId.optional(),
  requestId: BackendRequestIdSchema, operationDigest: z.string().min(1).max(256),
}).strict();
export type BackendApprovalRef = z.infer<typeof BackendApprovalRefSchema>;
export function assertBackendReference(backendIdValue: string, reference: BackendResourceRef): void {
  backendId.parse(backendIdValue);
  const ref = BackendResourceRefSchema.parse(reference);
  if (ref.backendId !== backendIdValue) throw new Error("Resource belongs to another backend.");
}

/** Capabilities for a canonical engine API pathname. Unknown routes return no
 * classification; the trusted proxy must separately reject unadmitted routes.
 * A capability never substitutes for the engine's authorization checks.
 */
export function backendCapabilitiesForApiPath(pathname: string): BackendCapability[] {
  if (!pathname.startsWith("/api/") || /[?#\\\x00-\x20]/.test(pathname) || new URL(pathname, "http://backend.invalid").pathname !== pathname) throw new Error("Backend capability classification requires a canonical API pathname.");
  const parts = pathname.slice("/api/".length).split("/");
  const capabilities = new Set<BackendCapability>();
  const add = (capability: BackendCapability) => { capabilities.add(capability); };
  if (pathname === "/api/backend/handshake") return [];
  if (pathname === "/api/workflow-engine/call") return ["workflow-engine"];
  if (parts[0] === "control" && parts.length === 2 && ["recover-stale-workers", "prune-stopped-workers", "reset-database", "start-daemon", "stop-daemon", "launch-run"].includes(parts[1]!)) return ["process-controls"];
  if (pathname === "/api/dashboard" || parts[0] === "scans" || parts[0] === "finding-family") add("artifacts");
  else if (parts[0] === "events" || pathname === "/api/v1/presentation/events") add("events");
  else if (parts[0] === "console") {
    const family = parts[1];
    if (["sessions", "saved"].includes(family ?? "")) {
      add("sessions");
      // Inspect operation segments after the resource ID, not resource ID text.
      const operation = parts[3];
      if (operation === "decisions" || operation === "approvals") add("approvals");
      if (operation === "events") add("events");
      if (["models", "providers", "connections", "accounts", "runtime"].includes(operation ?? "")) add("model-connections");
      if (["files", "directories", "paths", "workspace", "project"].includes(operation ?? "")) add("workspaces");
    } else if (["workflow-triggers", "workflow-schedules"].includes(family ?? "")) add("schedules");
    else if (["workflows", "workflow-definitions", "workflow-executions", "workflow-tool-catalog", "fixes"].includes(family ?? "")) {
      add("workflows");
      if (family === "fixes" && (["apply", "publish"].includes(parts[2] ?? "") || ["apply", "publish"].includes(parts[3] ?? ""))) add("approvals");
      if (parts[3] === "events") add("events");
    } else if (["connections", "providers", "accounts", "runtime", "models", "auth"].includes(family ?? "")) add("model-connections");
    else if (["files", "directories", "paths", "workspace", "project"].includes(family ?? "")) add("workspaces");
    else if (["settings", "themes", "plugins", "service-plugins", "doctor", "tools", "checks", "feedback", "github", "execution"].includes(family ?? "")) {
      add("operator-services");
      if (family === "checks") add("workspaces");
    }
  }
  if (capabilities.has("artifacts") && parts[0] === "scans" && parts[2] === "events") add("events");
  return [...capabilities];
}
