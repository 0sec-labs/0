import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./dashboard-csp.js";
import { BRAND_LOGOS } from "./connector-logo-data.generated.js";

// raw.githubusercontent.com serves install.sh in update commands, never an image.
const REMOTE_AVATAR = /(?<!raw\.)githubusercontent|github\.com\/[A-Za-z0-9_-]+\.png|gravatar|simpleicons\.org|cdn\.simpleicons/i;
const webRoot = fileURLToPath(new URL("../../../web/", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });

describe("logos and avatars stay on this origin", () => {
  it("keeps the CSP's img-src strict (self, data:, blob: only)", () => {
    const directive = /img-src ([^;]+)/.exec(buildContentSecurityPolicy("<html></html>"))?.[1];
    expect(directive).toBe("'self' data: blob:");
  });
  it("bundles brand marks as local path data, never as URLs", () => {
    expect(JSON.stringify(BRAND_LOGOS)).not.toMatch(/https?:|url\(/i);
  });
  it("has no reference to a remote avatar or logo host in the web sources or in a built bundle", () => {
    const files = walk(join(webRoot, "src")).filter(path => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path));
    const dist = join(webRoot, "dist");
    if (existsSync(dist)) files.push(...walk(dist).filter(path => /\.(js|css|html)$/.test(path)));
    expect(files.length).toBeGreaterThan(50);
    for (const path of files) expect(readFileSync(path, "utf8"), path).not.toMatch(REMOTE_AVATAR);
  });
});
