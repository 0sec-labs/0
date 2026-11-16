/**
 * /api/console/extensions/*: the Extensions page over the engine's extension service. Thin on purpose: parse the
 * body, call the service, map the typed result to a status. Pin, diff, approval, tamper and env rules live in the
 * engine. Every mutating route is browser-only and owner-only (privileged-routes.ts) and audited (audit.ts).
 *
 *   GET  extensions                  overview rows + import report
 *   GET  extensions/info/<name>      install prompt for what is installed now
 *   POST extensions/preview          { source }                              -> install prompt, installs nothing
 *   POST extensions/install          { source, approvedRevision, confirm }   -> installs the exact revision shown
 *   POST extensions/update/preview   { name, to? }                           -> prompt with diff, or upToDate
 *   POST extensions/update           { name, to, approvedRevision, confirm } -> moves to the revision shown
 *   POST extensions/enable|disable   { name, approve? | confirm? }
 *   POST extensions/remove           { name, confirm }
 */
import { approvalFor, createExtensionService, type ExtensionService, type ExtensionErrorCode, type PreparedInstall, type ExtensionResult as Result } from "@0/engine";
import { z } from "zod";

export interface ExtensionReply { status: number; data: unknown }
const STATUS: Partial<Record<ExtensionErrorCode, number>> = {
  bad_source: 400, invalid_manifest: 400, legacy_executable: 400, unsafe_content: 400, reserved_name: 400, builtin: 400,
  not_installed: 404, sha_not_found: 404,
  review_mismatch: 409, needs_approval: 409, needs_confirmation: 409, name_taken: 409, name_changed: 409, content_mismatch: 409, tampered: 409, legacy: 409,
  fetch_failed: 502,
};
const FULL_SHA = /^[0-9a-f]{40}$/;
const revision = z.string().regex(/^(?:[0-9a-f]{40}|local-[0-9a-f]{16})$/);
const name = z.string().min(1).max(64);
const source = z.string().min(1).max(2048);
const schemas = {
  preview: z.object({ source }).strict(),
  install: z.object({ source, approvedRevision: revision, confirm: z.literal(true), enable: z.boolean().optional() }).strict(),
  updatePreview: z.object({ name, to: z.string().regex(FULL_SHA).optional() }).strict(),
  update: z.object({ name, to: z.string().regex(FULL_SHA).optional(), approvedRevision: revision, confirm: z.literal(true) }).strict(),
  enable: z.object({ name, approve: z.boolean().optional() }).strict(),
  disable: z.object({ name, confirm: z.boolean().optional() }).strict(),
  remove: z.object({ name, confirm: z.literal(true) }).strict(),
};

const fail = (code: ExtensionErrorCode | "bad_request", message: string, status?: number): ExtensionReply => ({ status: status ?? (code === "bad_request" ? 400 : STATUS[code as ExtensionErrorCode] ?? 500), data: { error: message, code } });
const fromResult = <T>(result: Result<T>, success: (value: T) => ExtensionReply): ExtensionReply => result.ok ? success(result.value) : fail(result.error.code, result.error.message);
const prompt = (p: PreparedInstall) => ({ prompt: p.prompt, installed: false });

/** Fetch the same revision again and require it to be the one the operator reviewed. Unpinned git input is pinned to the reviewed commit. */
async function prepareExactly(svc: ExtensionService, input: string, approved: string): Promise<Result<PreparedInstall>> {
  const text = input.trim();
  const prepared = await svc.installer.prepare(FULL_SHA.test(approved) && !/@[0-9a-f]{40}$/.test(text) ? `${text}@${approved}` : text);
  if (prepared.ok && prepared.value.prompt.revision !== approved) return { ok: false, error: { code: "review_mismatch", message: "This changed since you reviewed it. Review it again." } };
  return prepared;
}

/** `path` is relative to /api/console/. Returns null when the route is not an extensions route. */
export async function handleExtensionRequest(svc: ExtensionService, path: string, method: string, input: unknown, query: URLSearchParams = new URLSearchParams()): Promise<ExtensionReply | null> {
  if (!/^extensions(?:\/|$)/.test(path)) return null;
  const parse = <S extends z.ZodTypeAny>(schema: S): { value: z.output<S> } | ExtensionReply => {
    const r = schema.safeParse(input ?? {});
    return r.success ? { value: r.data } : fail("bad_request", "Invalid extension request.");
  };
  const body = <S extends z.ZodTypeAny>(schema: S, run: (value: z.output<S>) => Promise<ExtensionReply> | ExtensionReply): Promise<ExtensionReply> | ExtensionReply => {
    const parsed = parse(schema); return "value" in parsed ? run(parsed.value) : parsed;
  };
  try {
    if (path === "extensions" && method === "GET") {
      const project = query.get("project");
      return { status: 200, data: svc.overview(project ?? undefined) };
    }
    const info = /^extensions\/info\/([^/]+)$/.exec(path);
    if (info && method === "GET") return fromResult(svc.info(decodeURIComponent(info[1]!)), v => ({ status: 200, data: { prompt: v.prompt, enabled: v.entry.enabled } }));
    if (method !== "POST") return fail("bad_request", "Method not allowed.", 405);
    switch (path) {
      case "extensions/preview": return await body(schemas.preview, async v => fromResult(await svc.installer.prepare(v.source), p => ({ status: 200, data: prompt(p) })));
      case "extensions/install": return await body(schemas.install, async v => {
        const prepared = await prepareExactly(svc, v.source, v.approvedRevision);
        return fromResult(prepared, p => fromResult(svc.installer.commit(p, approvalFor(p, v.enable ? { scope: "global" as const } : undefined)), done => ({ status: 201, data: { installed: true, ...done, enabled: v.enable === true } })));
      });
      case "extensions/update/preview": return await body(schemas.updatePreview, async v => fromResult(await svc.installer.prepareUpdate(v.name, v.to), r => ({ status: 200, data: "upToDate" in r ? r : prompt(r) })));
      case "extensions/update": return await body(schemas.update, async v => {
        const prepared = await svc.installer.prepareUpdate(v.name, v.to ?? v.approvedRevision);
        return fromResult(prepared, r => {
          if ("upToDate" in r) return { status: 200, data: r };
          if (r.prompt.revision !== v.approvedRevision) return fail("review_mismatch", "This changed since you reviewed it. Review it again.");
          return fromResult(svc.installer.commit(r, approvalFor(r)), done => ({ status: 200, data: { updated: true, ...done } }));
        });
      });
      case "extensions/enable": return body(schemas.enable, v => fromResult(svc.installer.enable(v.name, { approve: v.approve === true }), done => ({ status: 200, data: done })));
      case "extensions/disable": return body(schemas.disable, v => fromResult(svc.installer.disable(v.name, { confirm: v.confirm === true }), done => ({ status: 200, data: done })));
      case "extensions/remove": return body(schemas.remove, v => fromResult(svc.installer.remove(v.name), done => ({ status: 200, data: done })));
      default: return fail("bad_request", "Route not found.", 404);
    }
  } catch (cause) {
    return fail("io", cause instanceof Error ? cause.message : "Extension request failed.", 500);
  }
}
