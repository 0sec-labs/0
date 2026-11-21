import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck, runGenerate, type SbomDeps } from "../sbom.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const project = (files: Record<string, string>) => { const dir = mkdtempSync(join(tmpdir(), "0-sbomcli-")); dirs.push(dir); for (const [path, content] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); } return dir; };
const deps = (extra: Partial<SbomDeps> = {}) => { const out: string[] = []; const err: string[] = []; const written: Record<string, string> = {}; return { out, err, written, deps: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), write: (p: string, t: string) => { written[p] = t; }, read: (p: string) => written[p] ?? "", ...extra } as SbomDeps }; };

describe("0 sbom generate", () => {
  it("writes the SBOM and says which lockfiles it read", () => {
    const dir = project({ "package-lock.json": JSON.stringify({ packages: { "node_modules/lodash": { version: "4.17.20" } } }) });
    const io = deps();
    runGenerate(dir, {}, io.deps);
    expect(JSON.parse(io.out.join("")).components[0].purl).toBe("pkg:npm/lodash@4.17.20");
    expect(io.err.join("\n")).toContain("1 components from 1 lockfile: package-lock.json (npm, 1)");
  });
  it("is a usage error, with the supported lockfiles and the fallback, when there is nothing to read", () => {
    const io = deps();
    expect(() => runGenerate(project({ "readme.md": "x" }), {}, io.deps)).toThrow(/package-lock\.json.*syft or cdxgen/);
    expect(() => runGenerate("/no/such/folder", {}, io.deps)).toThrow("is not a folder");
  });
});

describe("0 sbom check", () => {
  const bom = JSON.stringify({ components: [{ purl: "pkg:npm/lodash@4.17.20" }] });
  const osv = (vulns: unknown[]) => (async (url: string | URL | Request) => String(url).endsWith("querybatch") ? new Response(JSON.stringify({ results: [{ vulns }] })) : new Response(JSON.stringify({ id: "GHSA-1", aliases: ["CVE-1"], summary: "Bad", database_specific: { severity: "HIGH" }, affected: [{ ranges: [{ events: [{ fixed: "4.17.21" }] }] }] }))) as typeof fetch;
  it("lists advisories per component and returns 1", async () => {
    const io = deps({ read: () => bom, fetch: osv([{ id: "GHSA-1" }]) });
    expect(await runCheck("sbom.json", {}, io.deps)).toBe(1);
    const text = io.out.join("");
    expect(text).toContain("pkg:npm/lodash@4.17.20");
    expect(text).toContain("GHSA-1 (CVE-1)  HIGH  fixed in 4.17.21");
  });
  it("returns 0 for a clean SBOM, and prints JSON on request", async () => {
    const clean = deps({ read: () => bom, fetch: osv([]) });
    expect(await runCheck("sbom.json", {}, clean.deps)).toBe(0);
    expect(clean.out.join("")).toContain("No known advisories for 1 components");
    const json = deps({ read: () => bom, fetch: osv([{ id: "GHSA-1" }]) });
    await runCheck("sbom.json", { format: "json" }, json.deps);
    expect(JSON.parse(json.out.join("")).advisories[0].id).toBe("GHSA-1");
  });
  it("refuses a file that is not an SBOM and says when OSV could not be reached", async () => {
    await expect(runCheck("x", {}, deps({ read: () => "not json" }).deps)).rejects.toThrow("not a JSON SBOM");
    await expect(runCheck("x", {}, deps({ read: () => bom, fetch: vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch }).deps)).rejects.toThrow("Could not check against OSV: offline");
  });
});
