import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { TeamAuth, TeamAuthError, getSessionId, type TeamIdentity } from "./team-auth.js";
import { CollaborationService, type CollaborationResourceKind } from "./collaboration.js";
import type { ConsoleGateway } from "./console-gateway.js";

type Reply = { status: number; data?: unknown; headers?: Record<string, string | string[]>; redirect?: string };
const readOnly = (method: string) => method === "GET" || method === "HEAD";

/** The browser control token authorizes the transport, never a team identity. */
export function authorizeTeamApi(auth: TeamAuth, req: IncomingMessage, path: string): TeamIdentity | null {
  if (!auth.enabled) return null;
  const actor = auth.resolveSession(req);
  if (!actor) throw new TeamAuthError("Sign in to this workspace.");
  const method = req.method ?? "GET";
  // Registered remote engines carry machine credentials rather than browser account credentials.
  // Until a delegated team bridge exists, only the workspace owner may use them.
  if (/^\/api\/backends\/[^/]+\/proxy/.test(path) && !path.startsWith("/api/backends/local/proxy") && actor.role !== "owner") throw new TeamAuthError("Remote engine access requires a workspace owner.", 403);
  const ownerResource = /^\/api\/(?:control|workflow-engine|backends\/[^/]+\/proxy|console\/(?:checks|connections|credentials|auth|github|settings|plugins|mcp|services|processes|environment|execution|themes|models|project|doctor|tools|learning))(?:\/|$)/;
  if (!readOnly(method) && actor.role === "viewer") throw new TeamAuthError("This account has read-only workspace access.", 403);
  if (!readOnly(method) && ownerResource.test(path) && actor.role !== "owner") throw new TeamAuthError("Only workspace owners can change engine settings.", 403);
  const editorResource = /^\/api\/(?:engagements|findings|finding-family|console\/(?:sessions|workflows|workflow-definitions|workflow-executions|workflow-triggers))(?:\/|$)/;
  const resumeRead = method === "POST" && /^\/api\/console\/saved\/[^/]+\/resume$/.test(path);
  if (!readOnly(method) && actor.role !== "owner" && !editorResource.test(path) && !resumeRead) throw new TeamAuthError("This action requires a workspace owner.", 403);
  return actor;
}

export async function handleTeamRequest(req: IncomingMessage, url: URL, auth: TeamAuth, collaboration: CollaborationService | undefined, gateway: ConsoleGateway, readBody: () => Promise<unknown>, validateResource?: (kind: CollaborationResourceKind, id: string) => void | Promise<void>): Promise<Reply | undefined> {
  if (!url.pathname.startsWith("/api/team/")) return;
  const method = req.method ?? "GET";
  const path = url.pathname.slice("/api/team/".length);
  if (path === "session" && method === "GET") return { status: 200, data: auth.status(req) };
  if (!auth.enabled) throw new TeamAuthError("Team mode is not configured.", 404);
  if (path === "auth/login" && method === "POST") {
    const login = await auth.login(await readBody(), req.socket.remoteAddress ?? "loopback");
    return { status: 200, data: { user: login.user }, headers: { "Set-Cookie": login.setCookie } };
  }
  if (path === "auth/sso" && method === "GET") {
    const sso = await auth.beginSSO();
    return { status: 302, redirect: sso.url, headers: { "Set-Cookie": sso.setCookie } };
  }
  if (path === "auth/callback" && method === "GET") {
    const login = await auth.callback(url.searchParams, req);
    return { status: 302, redirect: login.redirect, headers: { "Set-Cookie": login.setCookies } };
  }
  if (path === "auth/logout" && method === "POST") return { status: 200, data: { ok: true }, headers: { "Set-Cookie": auth.logout(req).setCookie } };
  if (!auth.resolveSession(req)) throw new TeamAuthError("Sign in to this workspace.");
  if (!collaboration) throw new TeamAuthError("Team resource not found.", 404);
  const session = getSessionId(req)!;
  if (path === "presence" && method === "GET") return { status: 200, data: collaboration.overview(session) };
  const resource = /^rooms\/(conversation|report|workflow)\/([A-Za-z0-9_.:-]+)\/presence$/.exec(path);
  if (resource) {
    if (method !== "POST") throw new TeamAuthError("Method not allowed.", 405);
    const kind = resource[1] as CollaborationResourceKind; const id = resource[2]!;
    if (kind === "conversation") gateway.get(id);
    else if (validateResource) await validateResource(kind, id);
    else throw new TeamAuthError("Resource presence is not configured for this engine.", 404);
    collaboration.registerRoom(kind, id, session);
    return { status: 200, data: collaboration.heartbeatRoom(kind, id, session, await readBody()) };
  }
  const match = /^conversations\/([A-Za-z0-9_.:-]+)(?:\/(presence))?$/.exec(path);
  if (!match) throw new TeamAuthError("Team resource not found.", 404);
  const id = match[1]!;
  gateway.get(id);
  if (!collaboration.hasConversation(id)) collaboration.register(id, session);
  if (!match[2] && method === "GET") return { status: 200, data: collaboration.snapshot(id, session) };
  if (match[2] === "presence" && method === "POST") return { status: 200, data: collaboration.heartbeat(id, session, await readBody()) };
  throw new TeamAuthError("Method not allowed.", 405);
}

export function assertTeamConsoleMutation(req: IncomingMessage, id: string, auth: TeamAuth, collaboration: CollaborationService | undefined, gateway: ConsoleGateway): void {
  if (!auth.enabled) return;
  gateway.get(id);
  const session = getSessionId(req);
  if (!session || !collaboration) throw new TeamAuthError("Sign in to this workspace.");
  if (!collaboration.hasConversation(id)) collaboration.register(id, session);
  collaboration.assertWriter(id, session);
}
