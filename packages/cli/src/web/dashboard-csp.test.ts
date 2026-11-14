import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, cspModeFromEnv, htmlSecurityHeaders, inlineScriptHashes } from "./dashboard-csp.js";
import { sendFile } from "./dashboard-http.js";

const script = "(() => { document.documentElement.dataset.mode = 'dark'; })();";
const hash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
const html = `<html><head><script>${script}</script><script type="module" src="/a.js"></script><script type="application/json">{"x":1}</script></head></html>`;

describe("dashboard CSP", () => {
  it("hashes only executable inline scripts", () => {
    expect(inlineScriptHashes(html)).toEqual([hash]);
  });

  it("builds a strict policy", () => {
    const csp = buildContentSecurityPolicy(html);
    expect(csp).toContain(`script-src 'self' ${hash}`);
    for (const directive of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'", "img-src 'self' data: blob:"]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toMatch(/script-src[^;]*('unsafe-inline'|'unsafe-eval'|\*)/);
    expect(csp).not.toMatch(/(default|connect|script)-src[^;]*https?:/);
  });

  it("honours ZERO_CSP", () => {
    expect(cspModeFromEnv({})).toBe("enforce");
    expect(cspModeFromEnv({ ZERO_CSP: "report-only" })).toBe("report-only");
    expect(cspModeFromEnv({ ZERO_CSP: "OFF" })).toBe("off");
    expect(htmlSecurityHeaders(html, "report-only")["Content-Security-Policy-Report-Only"]).toBeTruthy();
    expect(htmlSecurityHeaders(html, "report-only")["Content-Security-Policy"]).toBeUndefined();
    const off = htmlSecurityHeaders(html, "off");
    expect(off["Content-Security-Policy"]).toBeUndefined();
    expect(off["Permissions-Policy"]).toContain("camera=()");
    expect(off["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  describe("sendFile", () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const serve = (name: string, body: string, token?: string) => {
      const dir = mkdtempSync(join(tmpdir(), "csp-"));
      dirs.push(dir);
      const file = join(dir, name);
      writeFileSync(file, body);
      let status = 0; let headers: Record<string, string> = {}; let out = "";
      sendFile({ writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h; }, end: (b: Buffer | string) => { out = b.toString(); } } as never, file, token);
      return { status, headers, out };
    };

    it("sets CSP on HTML and keeps the token meta outside script", () => {
      const r = serve("index.html", html, "tok123");
      expect(r.headers["Content-Security-Policy"]).toContain(hash);
      expect(r.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
      expect(r.out).toContain('<meta name="0-control-token" content="tok123">');
    });

    it("does not put CSP on assets", () => {
      expect(serve("a.js", "1").headers["Content-Security-Policy"]).toBeUndefined();
    });
  });
});

describe("framing policy with self-edit preview", () => {
  it("denies framing by default", () => {
    const h = htmlSecurityHeaders(html, "enforce", {});
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).toContain("frame-src 'none'");
  });

  it("allows only a loopback ancestor, and drops X-Frame-Options so it can apply", () => {
    const h = htmlSecurityHeaders(html, "enforce", { ZERO_PREVIEW_FRAME_ANCESTORS: "http://127.0.0.1:4567" });
    expect(h["X-Frame-Options"]).toBeUndefined();
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors http://127.0.0.1:4567");
  });

  it("ignores non-loopback ancestors and never frames when CSP is off", () => {
    const evil = htmlSecurityHeaders(html, "enforce", { ZERO_PREVIEW_FRAME_ANCESTORS: "https://evil.example" });
    expect(evil["X-Frame-Options"]).toBe("DENY");
    expect(evil["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(htmlSecurityHeaders(html, "off", { ZERO_PREVIEW_FRAME_ANCESTORS: "http://127.0.0.1:4567" })["X-Frame-Options"]).toBe("DENY");
  });

  it("allows loopback frame-src only when self-edit is enabled", () => {
    expect(buildContentSecurityPolicy(html, { ZERO_SELF_EDIT: "1" })).toContain("frame-src http://127.0.0.1:* http://localhost:*")
    expect(buildContentSecurityPolicy(html, { ZERO_SELF_EDIT: "1" })).not.toContain("[::1]");
    expect(buildContentSecurityPolicy(html, {})).toContain("frame-src 'none'");
  });
});
