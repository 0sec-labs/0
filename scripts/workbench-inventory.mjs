import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { manifest, resolveWorkbenchProfile, immutableImageReference } from "./workbench-profile.mjs";

function probe(name, args, expected = [0]) {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || !expected.includes(result.status) || !output) throw new Error(`Required tool startup failed: ${name} (exit ${result.status}, ${result.error?.code ?? "no version output"})`);
  return { exitCode: result.status, versionOutput: output.slice(0, 4096) };
}
if (process.platform !== "linux" || process.arch !== "arm64" || process.getuid?.() !== 1000) throw new Error("Workbench inventory must run as Linux ARM64 UID 1000");
const profile = resolveWorkbenchProfile(process.env.ZERO_WORKBENCH_PROFILE);
const sourceRevision = process.env.ZERO_WORKBENCH_SOURCE_REVISION;
const baseImage = process.env.ZERO_WORKBENCH_BASE_IMAGE;
if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "") || !immutableImageReference(baseImage)) throw new Error("Build receipt requires a source commit and immutable base identity");
const tools = profile.probes.map(([name, args, accepted]) => {
  const lookup = spawnSync("sh", ["-c", 'command -v "$1"', "tool-lookup", name], { encoding: "utf8", timeout: 5000 });
  if (lookup.status !== 0 || !lookup.stdout.trim()) throw new Error(`Required tool missing: ${name}`);
  return { name, path: realpathSync(lookup.stdout.trim()), ...probe(name, args, accepted) };
});
const python = probe("python3", ["-c", `import importlib,json; names=${JSON.stringify(profile.pythonModules)}; print(json.dumps([{'name': n, 'version': str(getattr(importlib.import_module(n), '__version__', 'recorded in OS packages'))} for n in names]))`]);
// Capture the complete package inventory separately; versionOutput truncation is only for tool help.
const allPackages = spawnSync("dpkg-query", ["-W", "-f=${Package}\t${Version}\t${Architecture}\n"], { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
if (allPackages.status !== 0 || allPackages.error) throw new Error("OS package inventory unavailable");
const require = createRequire(import.meta.url);
const parserRequire = createRequire("/opt/0/package.json");
const Parser = parserRequire("tree-sitter");
const parser = new Parser(); parser.setLanguage(parserRequire("tree-sitter-c"));
if (parser.parse("int inventory(void) { return 0; }").rootNode.hasError) throw new Error("Native parser startup failed");
const { chromium } = require("/opt/0/node_modules/playwright");
const browser = await chromium.launch({ headless: true });
let browserVersion;
try { const page = await browser.newPage(); await page.setContent("<title>Workbench inventory</title>"); if (await page.title() !== "Workbench inventory") throw new Error("Browser startup failed"); browserVersion = browser.version(); } finally { await browser.close(); }
const cliVersion = tools.find(tool => tool.name === "0").versionOutput;
const cliPackage = JSON.parse(readFileSync("/opt/0/package.json", "utf8"));
if (!cliVersion.includes(cliPackage.version)) throw new Error("CLI build version differs from bundled package");
const osRelease = readFileSync("/etc/os-release", "utf8");
const osId = /^ID=(?:"([^"\n]+)"|([^\n]+))$/m.exec(osRelease);
if ((osId?.[1] ?? osId?.[2]) !== (profile.name === "kali" ? "kali" : "debian")) throw new Error("Profile OS identity does not match the installed image");
const expectedTools = JSON.parse(readFileSync(new URL("./workbench-tools.json", import.meta.url), "utf8"));
for (const [name, expected] of Object.entries({ node: expectedTools.runtimes.node, bun: expectedTools.runtimes.bun, ...expectedTools.agentProviders })) {
  if (!tools.find(tool => tool.name === name)?.versionOutput.includes(expected)) throw new Error(`Pinned runtime version mismatch: ${name}`);
}
const receipt = {
  schemaVersion: 1, phase: "image-build", profile: profile.name, platform: manifest.platform,
  sourceRevision, baseImage, aptSnapshot: profile.name === "kali" ? null : manifest.aptSnapshot,
  profileManifestSha256: createHash("sha256").update(readFileSync(new URL("./workbench-profiles.json", import.meta.url))).digest("hex"),
  cliVersion, osRelease, user: { uid: 1000, gid: process.getgid(), home: process.env.HOME }, tools,
  packages: allPackages.stdout.trim().split("\n").map(line => { const [name, version, architecture] = line.split("\t"); return { name, version, architecture }; }),
  pythonModules: JSON.parse(python.versionOutput), nativeParser: "passed", browser: { version: browserVersion, localStartup: "passed" },
};
writeFileSync(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o444 });
console.log(JSON.stringify({ profile: profile.name, tools: tools.length, packages: receipt.packages.length, browserVersion }));
