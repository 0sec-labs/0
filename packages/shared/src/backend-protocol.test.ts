import { describe, expect, it } from "vitest";
import {
  BackendApprovalRefSchema, BackendIdSchema, BackendDescriptorSchema, BackendEventCursorSchema, BackendHandshakeSchema,
  BackendListSchema, BackendRequestContextSchema, assertBackendReference, backendResourceKey,
  backendResourceQueryKey, backendCapabilitiesForApiPath, hasBackendCapability, parseBackendHandshake, requireBackendCapability,
} from "./backend-protocol.js";
const handshake = { protocolVersion: 1, engineId: "engine-a", capabilities: ["sessions", "workflows"], platform: { os: "linux", pathStyle: "posix" } };
const descriptor = { id: "remote-a", name: "Remote workspace", transport: "http", status: "connected", protocolVersion: 1, capabilities: ["sessions", "workflows"] };
describe("backend frontend/engine contract", () => {
  it("negotiates version and preserves future capability names without granting current operations", () => {
    expect(parseBackendHandshake({ ...handshake, capabilities: ["sessions", "future-operation"] }).capabilities).toContain("future-operation");
    expect(BackendHandshakeSchema.parse({ ...handshake, protocolVersion: 2 }).protocolVersion).toBe(2);
    expect(() => parseBackendHandshake({ ...handshake, protocolVersion: 2 })).toThrow("Incompatible");
    const backend = BackendDescriptorSchema.parse(descriptor);
    expect(hasBackendCapability(backend, "workflows")).toBe(true);
    expect(() => requireBackendCapability(backend, "artifacts")).toThrow("does not support");
    expect(() => requireBackendCapability({ ...backend, status: "disconnected" }, "workflows")).toThrow("disconnected");
    expect(() => requireBackendCapability({ ...backend, protocolVersion: 2 }, "workflows")).toThrow("incompatible");
  });
  it("rejects endpoint and credential material in browser descriptors and invalid registry IDs", () => {
    expect(BackendDescriptorSchema.parse(descriptor).id).toBe("remote-a");
    expect(() => BackendDescriptorSchema.parse({ ...descriptor, endpoint: "https://engine.test", token: "secret" })).toThrow();
    expect(() => BackendDescriptorSchema.parse({ ...descriptor, id: "../another" })).toThrow();
    expect(() => BackendDescriptorSchema.parse({ ...descriptor, capabilities: ["sessions", "sessions"] })).toThrow();
    expect(() => BackendListSchema.parse({ backends: [descriptor, descriptor] })).toThrow("unique");
  });
  it("keeps identical resource IDs from different engines out of each other's cache and dispatch", () => {
    const first = { backendId: "a", id: "same-session" };
    const second = { backendId: "b", id: "same-session" };
    expect(backendResourceKey("session", first)).not.toBe(backendResourceKey("session", second));
    expect(backendResourceQueryKey("run", second)).toEqual(["backend", "b", "run", "same-session"]);
    expect(() => assertBackendReference("a", second)).toThrow("another backend");
    expect(() => assertBackendReference("a", first)).not.toThrow();
    expect(backendResourceKey("run", first)).not.toBe(backendResourceKey("session", first));
  });
  it("classifies nested approval, cursor, model, workspace, and host operations consistently", () => {
    expect(backendCapabilitiesForApiPath("/api/console/sessions/same/decisions/request")).toEqual(["sessions", "approvals"]);
    expect(backendCapabilitiesForApiPath("/api/console/sessions/same/events")).toEqual(["sessions", "events"]);
    expect(backendCapabilitiesForApiPath("/api/console/sessions/same/models")).toEqual(["sessions", "model-connections"]);
    expect(backendCapabilitiesForApiPath("/api/console/sessions/same/files")).toEqual(["sessions", "workspaces"]);
    expect(backendCapabilitiesForApiPath("/api/console/fixes/fix1/publish")).toEqual(["workflows", "approvals"]);
    expect(backendCapabilitiesForApiPath("/api/console/fixes/apply")).toEqual(["workflows", "approvals"]);
    expect(backendCapabilitiesForApiPath("/api/console/fixes/publish")).toEqual(["workflows", "approvals"]);
    expect(backendCapabilitiesForApiPath("/api/console/fixes/prepare")).toEqual(["workflows"]);
    expect(backendCapabilitiesForApiPath("/api/console/settings")).toEqual(["operator-services"]);
    expect(backendCapabilitiesForApiPath("/api/console/service-plugins")).toEqual(["operator-services"]);
    expect(backendCapabilitiesForApiPath("/api/console/checks")).toEqual(["operator-services", "workspaces"]);
    expect(backendCapabilitiesForApiPath("/api/control/reset-database")).toEqual(["process-controls"]);
    expect(backendCapabilitiesForApiPath("/api/control/new-arbitrary-effect")).toEqual([]);
    expect(backendCapabilitiesForApiPath("/api/workflow-engine/call")).toEqual(["workflow-engine"]);
    expect(backendCapabilitiesForApiPath("/api/scans/same/events")).toEqual(["artifacts", "events"]);
    expect(backendCapabilitiesForApiPath("/api/console/sessions/decisions")).toEqual(["sessions"]);
    expect(backendCapabilitiesForApiPath("/api/console/unknown")).toEqual([]);
    expect(() => backendCapabilitiesForApiPath("/api/console/../control/reset-database")).toThrow("canonical");
    expect(() => backendCapabilitiesForApiPath("/api/console/models?providerId=api")).toThrow("canonical");
    expect(() => backendCapabilitiesForApiPath("https://other/api/console/models")).toThrow("canonical");
  });
  it("qualifies approval/cursor/request identities and rejects malformed sequence numbers", () => {
    expect(BackendApprovalRefSchema.parse({ backendId: "a", id: "approval-1", sessionId: "same", requestId: "req-1", operationDigest: "exact-scope" }).backendId).toBe("a");
    expect(() => BackendIdSchema.parse("../remote")).toThrow();
    expect(() => BackendRequestContextSchema.parse({ backendId: "a", requestId: "request\r\nAuthorization: secret" })).toThrow();
    expect(() => BackendRequestContextSchema.parse({ backendId: "a", requestId: "constructor" })).toThrow();
    expect(BackendRequestContextSchema.parse({ backendId: "b", requestId: "req-1", idempotencyKey: "retry" }).backendId).toBe("b");
    expect(BackendEventCursorSchema.parse({ backendId: "b", resourceId: "same", sequence: 42, serverInstanceId: "epoch2" }).sequence).toBe(42);
    expect(() => BackendEventCursorSchema.parse({ backendId: "b", resourceId: "same", sequence: -1 })).toThrow();
    expect(() => BackendEventCursorSchema.parse({ backendId: "b", resourceId: "same", sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});
