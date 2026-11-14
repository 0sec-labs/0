import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAssetPath } from "./dashboard-assets.js";
import { sendFile } from "./dashboard-http.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function assetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "0-assets-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html><head></head></html>");
  writeFileSync(join(dir, "assets", "app.js"), "1");
  return dir;
}

describe("dashboard asset resolution", () => {
  it("resolves files but never directories", () => {
    const dir = assetDir();
    expect(resolveAssetPath(dir, "/assets/app.js")).toBe(join(dir, "assets", "app.js"));
    expect(resolveAssetPath(dir, "/")).toBe(join(dir, "index.html"));
    expect(resolveAssetPath(dir, "/assets")).toBeNull();
    expect(resolveAssetPath(dir, "/assets/")).toBeNull();
  });

  it("does not send response headers before the file is readable", () => {
    const dir = assetDir();
    let headWritten = false;
    const res = { writeHead: () => { headWritten = true; }, end: () => undefined } as never;
    expect(() => sendFile(res, join(dir, "assets"))).toThrow();
    expect(headWritten).toBe(false);
  });
});

describe("static asset delivery", () => {
  function send(file: string, headers: Record<string, string> = {}) {
    let status = 0; let out: Record<string, string | number> = {}; let body: Buffer | undefined;
    const res = { req: { headers, method: "GET" }, writeHead: (s: number, h: Record<string, string | number>) => { status = s; out = h; }, end: (b?: Buffer) => { body = b; } } as never;
    sendFile(res, file);
    return { status, headers: out, body };
  }
  it("compresses text assets, validates with ETag and marks hashed files immutable", () => {
    const dir = assetDir();
    const file = join(dir, "assets", "chunk-ABCDEFGH.js");
    writeFileSync(file, "const a = 1;\n".repeat(500));
    const plain = send(file);
    expect(plain.headers["Content-Encoding"]).toBeUndefined();
    expect(plain.headers["Cache-Control"]).toContain("immutable");
    const br = send(file, { "accept-encoding": "gzip, br" });
    expect(br.headers["Content-Encoding"]).toBe("br");
    expect(br.body!.length).toBeLessThan(plain.body!.length / 5);
    expect(br.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(send(file, { "accept-encoding": "gzip" }).headers["Content-Encoding"]).toBe("gzip");
    const revalidated = send(file, { "accept-encoding": "br", "if-none-match": String(br.headers["ETag"]) });
    expect(revalidated.status).toBe(304);
    expect(send(file, { "accept-encoding": "br", "if-none-match": String(plain.headers["ETag"]) }).status).toBe(200);
  });
  it("keeps short-lived caching for unhashed names and picks up edits", () => {
    const dir = assetDir();
    const file = join(dir, "assets", "app.js");
    expect(send(file).headers["Cache-Control"]).toBe("public, max-age=300");
    const first = String(send(file).headers["ETag"]);
    writeFileSync(file, "22");
    expect(String(send(file).headers["ETag"])).not.toBe(first);
  });
});
