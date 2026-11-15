import { TeamAuthError, type TeamIdentity } from "./team-auth.js";

/**
 * Named permissions behind the team API. Route access used to be decided by role checks
 * scattered through one function; routing now maps a request to the permissions it needs,
 * and a policy decides whether an identity holds them. The default policy reproduces the
 * owner / editor / viewer rules exactly, so behavior is unchanged. A different policy (for
 * example custom roles) can be installed with {@link setTeamPermissionPolicy}.
 */
export type TeamPermission = "engine.remote" | "write" | "engine.settings" | "skills.mount" | "owner.actions";

export interface TeamPermissionPolicy {
  allows(identity: TeamIdentity, permission: TeamPermission): boolean;
}

/** owner holds everything; editor may write content; viewer is read-only. */
export const defaultTeamPermissionPolicy: TeamPermissionPolicy = {
  allows(identity, permission) {
    if (identity.role === "owner") return true;
    if (identity.role === "editor") return permission === "write";
    return false;
  },
};

const DENIAL: Record<TeamPermission, string> = {
  "engine.remote": "Remote engine access requires a workspace owner.",
  write: "This account has read-only workspace access.",
  "engine.settings": "Only workspace owners can change engine settings.",
  "skills.mount": "Only workspace owners can mount host folders.",
  "owner.actions": "This action requires a workspace owner.",
};

const OWNER_RESOURCE = /^\/api\/(?:control|workflow-engine|backends\/[^/]+\/proxy|console\/(?:checks|connections|credentials|auth|github|settings|plugins|mcp|services|processes|environment|execution|models|project|doctor|tools|learning))(?:\/|$)/;
const EDITOR_RESOURCE = /^\/api\/(?:skills|engagements|findings|finding-family|console\/(?:sessions|workflows|workflow-definitions|workflow-executions|workflow-triggers))(?:\/|$)/;
const REMOTE_PROXY = /^\/api\/backends\/[^/]+\/proxy/;
const SKILL_MOUNTS = /^\/api\/skills\/mounts(?:\/|$)/;
const RESUME_READ = /^\/api\/console\/saved\/[^/]+\/resume$/;
const isRead = (method: string) => method === "GET" || method === "HEAD";

/** Permissions a request needs, in the order they are checked; the first unmet one is reported. */
export function requiredTeamPermissions(method: string, path: string): TeamPermission[] {
  const needed: TeamPermission[] = [];
  // Registered remote engines carry machine credentials rather than browser account credentials.
  // Until a delegated team bridge exists, only the workspace owner may use them.
  if (REMOTE_PROXY.test(path) && !path.startsWith("/api/backends/local/proxy")) needed.push("engine.remote");
  if (!isRead(method)) {
    needed.push("write");
    if (OWNER_RESOURCE.test(path)) needed.push("engine.settings");
    if (SKILL_MOUNTS.test(path)) needed.push("skills.mount");
    if (!EDITOR_RESOURCE.test(path) && !(method === "POST" && RESUME_READ.test(path))) needed.push("owner.actions");
  }
  return needed;
}

let activePolicy: TeamPermissionPolicy = defaultTeamPermissionPolicy;
/** Install a policy (for example from an enterprise plugin). Pass nothing to restore the default. */
export function setTeamPermissionPolicy(policy: TeamPermissionPolicy = defaultTeamPermissionPolicy): void { activePolicy = policy; }
export function getTeamPermissionPolicy(): TeamPermissionPolicy { return activePolicy; }

/** Throws a 403 for the first permission the identity lacks. */
export function assertTeamPermissions(identity: TeamIdentity, method: string, path: string, policy: TeamPermissionPolicy = activePolicy): void {
  for (const permission of requiredTeamPermissions(method, path)) {
    if (!policy.allows(identity, permission)) throw new TeamAuthError(DENIAL[permission], 403);
  }
}
