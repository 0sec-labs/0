import { afterEach, describe, expect, it } from "vitest";
import { TeamAuthError, type TeamIdentity } from "./team-auth.js";
import { assertTeamPermissions, defaultTeamPermissionPolicy, getTeamPermissionPolicy, requiredTeamPermissions, setTeamPermissionPolicy } from "./team-permissions.js";

/** The authorization logic as it was before the policy refactor, kept verbatim as the oracle. */
function legacy(role: TeamIdentity["role"], method: string, path: string): string | null {
  const readOnly = (m: string) => m === "GET" || m === "HEAD";
  if (/^\/api\/backends\/[^/]+\/proxy/.test(path) && !path.startsWith("/api/backends/local/proxy") && role !== "owner") return "Remote engine access requires a workspace owner.";
  const ownerResource = /^\/api\/(?:control|workflow-engine|backends\/[^/]+\/proxy|console\/(?:checks|connections|credentials|auth|github|settings|plugins|mcp|services|processes|environment|execution|models|project|doctor|tools|learning))(?:\/|$)/;
  if (!readOnly(method) && role === "viewer") return "This account has read-only workspace access.";
  if (!readOnly(method) && ownerResource.test(path) && role !== "owner") return "Only workspace owners can change engine settings.";
  if (!readOnly(method) && /^\/api\/skills\/mounts(?:\/|$)/.test(path) && role !== "owner") return "Only workspace owners can mount host folders.";
  const editorResource = /^\/api\/(?:skills|engagements|findings|finding-family|console\/(?:sessions|workflows|workflow-definitions|workflow-executions|workflow-triggers))(?:\/|$)/;
  const resumeRead = method === "POST" && /^\/api\/console\/saved\/[^/]+\/resume$/.test(path);
  if (!readOnly(method) && role !== "owner" && !editorResource.test(path) && !resumeRead) return "This action requires a workspace owner.";
  return null;
}

const identity = (role: TeamIdentity["role"]): TeamIdentity => ({ workspaceId: "w", userId: "u", displayName: "U", role });
const roles: TeamIdentity["role"][] = ["owner", "editor", "viewer"];
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const paths = [
  "/api/control/x", "/api/workflow-engine/run", "/api/backends/local/proxy/api/findings", "/api/backends/remote-1/proxy/api/findings", "/api/backends/remote-1/proxy",
  "/api/console/settings", "/api/console/credentials/1", "/api/console/models", "/api/console/learning/x", "/api/console/sessions/1", "/api/console/workflows",
  "/api/console/workflow-definitions/1", "/api/console/workflow-executions", "/api/console/workflow-triggers/1", "/api/console/saved/abc/resume", "/api/console/saved/abc/other",
  "/api/skills", "/api/skills/mounts", "/api/skills/mounts/1", "/api/skills/other", "/api/engagements/1", "/api/findings/1", "/api/finding-family/1",
  "/api/team/users", "/api/unknown", "/api/v1/findings", "/", "/api/controlx", "/api/backends/local/proxyx", "/api/console/sessionsx",
];

describe("team permission policy", () => {
  afterEach(() => setTeamPermissionPolicy());

  it("matches the previous authorization for every role, method and path", () => {
    for (const role of roles) for (const method of methods) for (const path of paths) {
      let actual: string | null = null;
      try { assertTeamPermissions(identity(role), method, path); } catch (error) {
        expect(error).toBeInstanceOf(TeamAuthError);
        expect((error as TeamAuthError).statusCode).toBe(403);
        actual = (error as Error).message;
      }
      expect(actual, `${role} ${method} ${path}`).toBe(legacy(role, method, path));
    }
  });

  it("reports the first unmet permission in order", () => {
    expect(requiredTeamPermissions("POST", "/api/backends/r/proxy/x")).toEqual(["engine.remote", "write", "engine.settings", "owner.actions"]);
    expect(requiredTeamPermissions("GET", "/api/console/settings")).toEqual([]);
  });

  it("lets a custom policy decide, and restores the default", () => {
    const only = (permission: string) => ({ allows: (_: TeamIdentity, p: string) => p === permission });
    setTeamPermissionPolicy(only("write"));
    expect(() => assertTeamPermissions(identity("viewer"), "POST", "/api/findings/1")).not.toThrow();
    expect(() => assertTeamPermissions(identity("viewer"), "POST", "/api/console/settings")).toThrow("engine settings");
    setTeamPermissionPolicy();
    expect(getTeamPermissionPolicy()).toBe(defaultTeamPermissionPolicy);
    expect(() => assertTeamPermissions(identity("viewer"), "POST", "/api/findings/1")).toThrow("read-only");
  });
});
