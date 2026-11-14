/**
 * /api/console/self-edit/* routes. Called from handleWebConsoleApiRequest, so
 * the control token has already been verified by the dashboard server. Here:
 *  - enablement is an operator opt-in (`ZERO_SELF_EDIT=1` on the dashboard process);
 *  - callers must be the browser console (no engine-bearer/agent callers: `team` is absent for those);
 *  - in team mode only workspace owners may use any route.
 */
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { TeamAuth } from "./team-auth.js";
import { WebRequestError } from "./dashboard-http.js";
import { SelfEditError, frameAncestorFor, sharedSelfEditPreview, type SelfEditPreview } from "./self-edit-preview.js";
import { PROTECTED_RULES } from "./self-edit-policy.js";

export const DEVELOP_APP_PRESET = {
  id: "develop-this-app",
  title: "Develop this app",
  skill: "develop-this-app",
  description: "Edit this dashboard's own source inside an isolated self/* worktree with a live preview. Nothing reaches the running instance.",
} as const;

export interface SelfEditReply { status: number; data: unknown }

export async function handleSelfEditRequest(options: {
  method: string;
  path: string;
  input: unknown;
  req: Pick<IncomingMessage, "headers">;
  team?: { auth: Pick<TeamAuth, "enabled" | "resolveSession"> };
  preview?: SelfEditPreview;
  env?: NodeJS.ProcessEnv;
}): Promise<SelfEditReply | undefined> {
  const { method, path, input, req, team } = options;
  if (!path.startsWith("self-edit/")) return undefined;
  const route = path.slice("self-edit/".length);
  const env = options.env ?? process.env;
  if (!team) throw new WebRequestError("Self-edit is available to the dashboard operator only.", 403);
  if (team.auth.enabled && team.auth.resolveSession(req)?.role !== "owner") throw new WebRequestError("Only workspace owners can use self-edit.", 403);
  const enabled = env["ZERO_SELF_EDIT"] === "1";
  const preview = options.preview ?? sharedSelfEditPreview();
  const protectedAreas = PROTECTED_RULES.map(rule => ({ id: rule.id, reason: rule.reason }));
  const ok = (data: unknown, status = 200): SelfEditReply => ({ status, data });

  if (route === "status" && method === "GET") return ok({ enabled, applyAvailable: false, preset: DEVELOP_APP_PRESET, protectedAreas, preview: preview.status() });
  if (route === "preset" && method === "GET") {
    const status = preview.status();
    return ok({ preset: { ...DEVELOP_APP_PRESET, workspaceRoot: status.worktree ?? null, branch: status.branch ?? null } });
  }
  if (!enabled) throw new WebRequestError("Self-edit is disabled. Start the dashboard with ZERO_SELF_EDIT=1 to enable it.", 403);
  try {
    if (route === "start" && method === "POST") {
      const body = z.object({ title: z.string().trim().max(80).optional() }).strict().parse(input ?? {});
      return ok({ preview: await preview.start({ ...body, frameAncestor: frameAncestorFor(String(req.headers.host ?? "")) }) }, 202);
    }
    if (route === "stop" && method === "POST") {
      const body = z.object({ discard: z.boolean().optional() }).strict().parse(input ?? {});
      return ok({ preview: await preview.stop(body) });
    }
    if (route === "diff" && method === "GET") return ok({ diff: await preview.diff() });
    if (route === "gates" && method === "POST") {
      z.object({}).strict().parse(input ?? {});
      return ok({ preview: await preview.runGates() }, 202);
    }
    // Apply stays visible in the panel but is deliberately unimplemented in the preview-only MVP.
    if (route === "apply" && method === "POST") return ok({ error: "Apply is not yet available. This build supports preview only." }, 501);
  } catch (error) {
    if (error instanceof SelfEditError) throw new WebRequestError(error.message, error.statusCode);
    throw error;
  }
  return ok({ error: "Method not allowed." }, 405);
}
