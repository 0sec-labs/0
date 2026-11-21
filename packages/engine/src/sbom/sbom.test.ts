import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBomAgainstOsv, generateSbom, packageUrl, parseCargoLock, parseGoMod, parseNpmLock, parsePipfileLock, parsePnpmLock, parsePoetryLock, parseRequirements, parseYarnLock } from "./index.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "0-sbom-")); dirs.push(dir);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); }
  return dir;
};
const names = (components: Array<{ name: string; version: string }>) => components.map(component => `${component.name}@${component.version}`).sort();

describe("lockfile parsers", () => {
  it("npm: v3 packages (scoped, nested, dev, links) and v1 nested dependencies", () => {
    const v3 = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.20" }, "node_modules/@babel/core": { version: "7.1.0" }, "node_modules/a/node_modules/lodash": { version: "3.0.0" }, "node_modules/vitest": { version: "5.1.0", dev: true }, "node_modules/local": { link: true, resolved: "../local" } } });
    expect(names(parseNpmLock(v3))).toEqual(["@babel/core@7.1.0", "lodash@3.0.0", "lodash@4.17.20", "vitest@5.1.0"]);
    expect(parseNpmLock(v3).find(component => component.name === "vitest")?.dev).toBe(true);
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { express: { version: "4.17.1", dependencies: { qs: { version: "6.7.0" } } }, other: { version: "file:../other" } } });
    expect(names(parseNpmLock(v1))).toEqual(["express@4.17.1", "qs@6.7.0"]);
    expect(parseNpmLock("not json")).toEqual([]);
  });
  it("pnpm: v9 keys with peer suffixes, v6 leading slash, v5 slash versions", () => {
    const lock = "lockfileVersion: '9.0'\npackages:\n  '@scope/name@1.2.3':\n    resolution: {integrity: x}\n  react-dom@18.2.0(react@18.2.0):\n    dev: true\n  /left-pad@1.3.0:\n    resolution: {integrity: y}\n  /old-style/2.0.1:\n    resolution: {integrity: z}\n";
    expect(names(parsePnpmLock(lock))).toEqual(["@scope/name@1.2.3", "left-pad@1.3.0", "old-style@2.0.1", "react-dom@18.2.0"]);
    expect(parsePnpmLock(lock).find(component => component.name === "react-dom")?.dev).toBe(true);
    expect(parsePnpmLock(": : :")).toEqual([]);
  });
  it("yarn: classic and berry headers, grouped specs", () => {
    const classic = '# yarn lockfile v1\n\n"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.8.3":\n  version "7.12.13"\n  resolved "https://x"\n\nlodash@^4.17.0:\n  version "4.17.21"\n';
    expect(names(parseYarnLock(classic))).toEqual(["@babel/code-frame@7.12.13", "lodash@4.17.21"]);
    const berry = '__metadata:\n  version: 6\n\n"chalk@npm:^4.0.0":\n  version: 4.1.2\n  resolution: "chalk@npm:4.1.2"\n';
    expect(names(parseYarnLock(berry))).toContain("chalk@4.1.2");
  });
  it("Cargo: registry crates only, not the workspace's own", () => {
    const lock = '[[package]]\nname = "mine"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.190"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\ndependencies = [\n "serde_derive",\n]\n';
    expect(names(parseCargoLock(lock))).toEqual(["serde@1.0.190"]);
  });
  it("Go: require blocks and single lines, comments ignored", () => {
    const mod = "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/text v0.14.0 // indirect\n)\n\nrequire github.com/stretchr/testify v1.8.4\n";
    expect(names(parseGoMod(mod))).toEqual(["github.com/gin-gonic/gin@v1.9.1", "github.com/stretchr/testify@v1.8.4", "golang.org/x/text@v0.14.0"]);
  });
  it("Python: poetry.lock, Pipfile.lock, and only pinned requirements", () => {
    expect(names(parsePoetryLock('[[package]]\nname = "Django"\nversion = "4.2.7"\ndescription = "x"\n\n[metadata]\nlock-version = "2.0"\n'))).toEqual(["Django@4.2.7"]);
    const pipfile = JSON.stringify({ default: { requests: { version: "==2.31.0" } }, develop: { pytest: { version: "==7.4.0" } } });
    expect(parsePipfileLock(pipfile).map(component => `${component.name}@${component.version}${component.dev ? " dev" : ""}`).sort()).toEqual(["pytest@7.4.0 dev", "requests@2.31.0"]);
    expect(names(parseRequirements("# c\nflask==2.3.2 # web\nrequests[security]==2.31.0 ; python_version > '3'\nnumpy>=1.0\n-r other.txt\ngit+https://x/y.git\n"))).toEqual(["flask@2.3.2", "requests@2.31.0"]);
  });
});

describe("package URLs", () => {
  it("encodes scoped npm names, normalises Python names, and keeps Go paths", () => {
    expect(packageUrl({ ecosystem: "npm", name: "@Babel/Core", version: "7.1.0" })).toBe("pkg:npm/%40babel/core@7.1.0");
    expect(packageUrl({ ecosystem: "pypi", name: "My_Package.X", version: "1.0" })).toBe("pkg:pypi/my-package-x@1.0");
    expect(packageUrl({ ecosystem: "golang", name: "github.com/a/b", version: "v1.0.0" })).toBe("pkg:golang/github.com/a/b@v1.0.0");
    expect(packageUrl({ ecosystem: "cargo", name: "serde", version: "1.0.0" })).toBe("pkg:cargo/serde@1.0.0");
  });
});

describe("generateSbom", () => {
  it("writes a sorted CycloneDX 1.5 document from every lockfile it finds, skipping dependency folders", () => {
    const dir = folder({
      "package-lock.json": JSON.stringify({ packages: { "node_modules/lodash": { version: "4.17.20" }, "node_modules/vitest": { version: "5.1.0", dev: true } } }),
      "services/api/go.mod": "module x\nrequire github.com/gin-gonic/gin v1.9.1\n",
      "node_modules/leftover/package-lock.json": JSON.stringify({ packages: { "node_modules/ignored": { version: "1.0.0" } } }),
    });
    const { bom, lockfiles } = generateSbom(dir, { name: "app", toolVersion: "0.0.0", now: new Date("2026-01-01T00:00:00Z") });
    expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { timestamp: "2026-01-01T00:00:00.000Z", component: { name: "app" } } });
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bom.components.map(component => component.purl)).toEqual(["pkg:golang/github.com/gin-gonic/gin@v1.9.1", "pkg:npm/lodash@4.17.20", "pkg:npm/vitest@5.1.0"]);
    expect(bom.components.find(component => component.name === "vitest")?.scope).toBe("excluded");
    expect(lockfiles.map(lock => lock.path)).toEqual(["package-lock.json", "services/api/go.mod"]);
  });
  it("is the same SBOM for the same lockfiles, and a component is development-only only when every lockfile says so", () => {
    const dir = folder({ "package-lock.json": JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0", dev: true } } }), "sub/package-lock.json": JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" } } }) });
    const one = generateSbom(dir, { toolVersion: "0", now: new Date(0) }); const two = generateSbom(dir, { toolVersion: "0", now: new Date(0) });
    expect(JSON.stringify(one.bom)).toBe(JSON.stringify(two.bom));
    expect(one.bom.components).toHaveLength(1);
    expect(one.bom.components[0]!.scope).toBeUndefined();
  });
  it("finds nothing in a folder with no supported lockfile", () => {
    expect(generateSbom(folder({ "readme.md": "hi" }), { toolVersion: "0" }).bom.components).toEqual([]);
  });
});

describe("checkBomAgainstOsv", () => {
  const bom = { components: [{ purl: "pkg:npm/lodash@4.17.20" }, { purl: "pkg:npm/safe@1.0.0" }, { purl: "not a purl" }, { name: "no purl" }] };
  const fakeFetch = (calls: string[]) => (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url); calls.push(`${init?.method ?? "GET"} ${href}`);
    if (href.endsWith("/v1/querybatch")) {
      const queries = JSON.parse(String(init?.body)).queries as Array<{ package: { purl: string } }>;
      return new Response(JSON.stringify({ results: queries.map(query => query.package.purl.includes("lodash") ? { vulns: [{ id: "GHSA-1", modified: "x" }, { id: "GHSA-2" }] } : {}) }));
    }
    if (href.endsWith("/GHSA-1")) return new Response(JSON.stringify({ id: "GHSA-1", aliases: ["CVE-2021-23337"], summary: "Command injection in lodash\u0007", database_specific: { severity: "HIGH" }, affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }] }));
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  it("asks once for the valid package URLs, then reads each advisory", async () => {
    const calls: string[] = [];
    const result = await checkBomAgainstOsv(bom, { fetch: fakeFetch(calls), baseUrl: "https://osv.test" });
    expect(result.checked).toBe(2);
    expect(calls.filter(call => call.includes("querybatch"))).toHaveLength(1);
    expect(result.advisories).toEqual([
      { purl: "pkg:npm/lodash@4.17.20", id: "GHSA-1", aliases: ["CVE-2021-23337"], summary: "Command injection in lodash", severity: "HIGH", fixed: ["4.17.21"] },
      { purl: "pkg:npm/lodash@4.17.20", id: "GHSA-2", aliases: [], summary: "", fixed: [] },
    ]);
    expect(result.withoutDetails).toBe(1);
  });
  it("refuses an SBOM with nothing to check, and reports a failed lookup", async () => {
    await expect(checkBomAgainstOsv({ components: [] })).rejects.toThrow("no components");
    await expect(checkBomAgainstOsv(bom, { fetch: (async () => new Response("x", { status: 503 })) as typeof fetch })).rejects.toThrow("503");
  });
});
