import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { TeamAuth, TeamAuthError, getSessionId, type TeamIdentity } from "./team-auth.js";
import { CollaborationService } from "./collaboration.js";
import type { ConsoleGateway } from "./console-gateway.js";

type Reply = { status: number; data?: unknown; headers?: Record<string, string | string[]>; redirect?: string };
const readOnly = (method: string) => method === "GET" || method === "HEAD";

/** The browser control token authorizes the transport, never a team identity. */
export function authorizeTeamApi(auth: TeamAuth, req: IncomingMessage, path: string): TeamIdentity | null {
  if (!auth.enabled) return null;
  const actor = auth.resolveSession(req);
  if (!actor) throw new TeamAuthError("Sign in to this workspace.");
  const method = req.method ?? "GET";
  // Registered remote engines carry machine credentials rather than human leases.
  // Until a delegated team bridge exists, only the workspace owner may use them.
  if (/^\/api\/backends\/[^/]+\/proxy/.test(path) && !path.startsWith("/api/backends/local/proxy") && actor.role !== "owner") throw new TeamAuthError("Remote engine access requires a workspace owner.", 403);
  const ownerResource = /^\/api\/(?:control|workflow-engine|backends\/[^/]+\/proxy|console\/(?:checks|connections|credentials|auth|github|settings|plugins|mcp|services|processes|environment|execution|themes|models|project|doctor|tools|learning))(?:\/|$)/;
  if (!readOnly(method) && actor.role === "viewer") throw new TeamAuthError("This account has read-only workspace access.", 403);
  if (!readOnly(method) && ownerResource.test(path) && actor.role !== "owner") throw new TeamAuthError("Only workspace owners can change engine settings.", 403);
  const editorResource = /^\/api\/(?:engagements|findings|finding-family|console\/(?:sessions|workflows|workflow-triggers))(?:\/|$)/;
  const resumeRead = method === "POST" && /^\/api\/console\/saved\/[^/]+\/resume$/.test(path);
  if (!readOnly(method) && actor.role !== "owner" && !editorResource.test(path) && !resumeRead) throw new TeamAuthError("This action requires a workspace owner.", 403);
  return actor;
}

export async function handleTeamRequest(req: IncomingMessage, url: URL, auth: TeamAuth, collaboration: CollaborationService | undefined, gateway: ConsoleGateway, readBody: () => Promise<unknown>): Promise<Reply | undefined> {
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
  const match = /^conversations\/([A-Za-z0-9_.:-]+)(?:\/(presence|control|proposals)(?:\/([A-Za-z0-9-]+))?)?$/.exec(path);
  if (!match || !collaboration) throw new TeamAuthError("Team resource not found.", 404);
  const id = match[1]!;
  gateway.get(id); // Validate existence before creating any collaboration record.
  const session = getSessionId(req)!;
  if (!collaboration.hasConversation(id)) collaboration.register(id, session);
  const action = match[2];
  const lease = typeof req.headers["x-0-team-lease"] === "string" ? req.headers["x-0-team-lease"] : undefined;
  if (!action && method === "GET") return { status: 200, data: collaboration.snapshot(id, session) };
  if (method !== "POST") throw new TeamAuthError("Method not allowed.", 405);
  const input = await readBody();
  if (action === "presence" && !match[3]) return { status: 200, data: collaboration.heartbeat(id, session, input) };
  if (action === "control" && !match[3]) {
    const body = z.object({ action: z.enum(["claim", "renew", "release"]) }).strict().parse(input);
    if (body.action === "claim") return { status: 200, data: collaboration.acquireController(id, session) };
    if (body.action === "renew") return { status: 200, data: collaboration.renewController(id, session, lease ?? "") };
    collaboration.releaseController(id, session, lease ?? "");
    return { status: 200, data: collaboration.snapshot(id, session) };
  }
  if (action === "proposals") {
    if (!match[3]) return { status: 201, data: collaboration.propose(id, session, input) };
    const body = z.object({ action: z.enum(["accept", "reject"]) }).strict().parse(input);
    if (body.action === "reject") collaboration.rejectProposal(id, session, match[3], lease ?? "");
    else await collaboration.acceptProposal(id, session, match[3], lease ?? "", async (text, submittedBy, proposalId) => { await gateway.send(id, { text, mode: "queue" }, { ...submittedBy, proposalId }); });
    return { status: 200, data: collaboration.snapshot(id, session) };
  }
  throw new TeamAuthError("Method not allowed.", 405);
}

export function assertTeamConsoleMutation(req: IncomingMessage, id: string, auth: TeamAuth, collaboration: CollaborationService | undefined, gateway: ConsoleGateway): void {
  if (!auth.enabled) return;
  gateway.get(id);
  const session = getSessionId(req);
  if (!session || !collaboration) throw new TeamAuthError("Sign in to this workspace.");
  if (!collaboration.hasConversation(id)) collaboration.register(id, session);
  const lease = req.headers["x-0-team-lease"];
  collaboration.assertController(id, session, typeof lease === "string" ? lease : "");
}
