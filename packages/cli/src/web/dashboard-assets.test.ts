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
