// Content-Security-Policy and companion browser hardening headers for the dashboard HTML.
//
// The page embeds the per-session control token in a <meta>, so script execution
// in the console origin is equivalent to control-API access. The policy therefore
// allows only same-origin module scripts plus the SHA-256 hashes of the inline
// scripts present in the served document (the pre-paint theme script).
//
// ZERO_CSP=report-only downgrades enforcement to a report-only header and
// ZERO_CSP=off omits the policy. Both are escape hatches for debugging.
import { createHash } from "node:crypto";

export type CspMode = "enforce" | "report-only" | "off";

export function cspModeFromEnv(env: NodeJS.ProcessEnv = process.env): CspMode {
  const value = env.ZERO_CSP?.trim().toLowerCase();
  if (value === "off" || value === "0" || value === "false") return "off";
  if (value === "report-only" || value === "report") return "report-only";
  return "enforce";
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    // Non-JS data blocks (type=application/json etc.) are never executed.
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(match[1] ?? "")?.[1]?.toLowerCase();
    if (type && type !== "module" && type !== "text/javascript") continue;
    hashes.add(`'sha256-${createHash("sha256").update(match[2] ?? "", "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

/**
 * The single loopback origin allowed to frame this dashboard. Only the self-edit
 * launcher sets ZERO_PREVIEW_FRAME_ANCESTORS (on the preview child it spawns; the
 * child does not inherit ZERO_SELF_EDIT, so the launcher's variable is the
 * enablement signal). Anything that is not an exact loopback origin is ignored
 * and the page stays unframeable.
 */
export function previewFrameAncestor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ancestor = env["ZERO_PREVIEW_FRAME_ANCESTORS"]?.trim();
  return ancestor && LOOPBACK_ORIGIN.test(ancestor) ? ancestor : undefined;
}

/** frame-src: none, except loopback preview iframes when self-edit is enabled on this dashboard. */
function selfEditFrameSources(env: NodeJS.ProcessEnv): string {
  return env["ZERO_SELF_EDIT"] === "1" ? "http://127.0.0.1:* http://localhost:* http://[::1]:*" : "'none'";
}

/**
 * Build the policy. style-src keeps 'unsafe-inline' because Mermaid, Base UI,
 * dockview and floating-ui inject <style> elements at runtime; script execution
 * stays locked to 'self' and hashes. connect-src is 'self' only: remote backends
 * are reached through same-origin /api proxy routes, never directly from the browser.
 */
export function buildContentSecurityPolicy(html = "", env: NodeJS.ProcessEnv = process.env): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...inlineScriptHashes(html)].join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `frame-src ${selfEditFrameSources(env)}`,
    `frame-ancestors ${previewFrameAncestor(env) ?? "'none'"}`,
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; ");
}

export const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), display-capture=(), interest-cohort=()";

/** Security headers for an HTML document response. */
export function htmlSecurityHeaders(html: string, mode: CspMode = cspModeFromEnv(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  // X-Frame-Options cannot name an origin, so it is dropped only when a loopback
  // preview parent is allowed; frame-ancestors then carries the restriction.
  // With CSP off there is no way to allow framing, so DENY always stays.
  const framable = mode !== "off" && previewFrameAncestor(env) !== undefined;
  if (!framable) headers["X-Frame-Options"] = "DENY";
  if (mode === "enforce") headers["Content-Security-Policy"] = buildContentSecurityPolicy(html, env);
  else if (mode === "report-only") headers["Content-Security-Policy-Report-Only"] = buildContentSecurityPolicy(html, env);
  return headers;
}
