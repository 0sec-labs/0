import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = process.argv[2];
if (!entry) throw new Error("Usage: node scripts/smoke-plugin-runtime.mjs <CLI JavaScript entry or standalone binary>");
const cli = realpathSync(resolve(entry));
const command = cli.endsWith(".js") ? process.execPath : cli;
const prefix = cli.endsWith(".js") ? [cli] : [];
const root = mkdtempSync(join(tmpdir(), "0-plugin-runtime-"));
const home = join(root, "home");
const project = join(root, "project");
const emptyPath = join(root, "no-executables");
const pluginId = "release-smoke";
const pluginDir = join(home, ".0", "plugins", pluginId);
for (const dir of [home, project, emptyPath, pluginDir]) mkdirSync(dir, { recursive: true });

// No external Node/Bun executable is discoverable. A standalone CLI must use
// its embedded interpreter; the Node bundle already has an absolute interpreter.
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  PATH: emptyPath,
  "ZERO_REGISTRY_URL": "",
};
function run(args) {
  try {
    return execFileSync(command, [...prefix, ...args], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Plugin runtime smoke failed: ${args.join(" ")}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
  }
}

try {
  run(["hackstore", "init", pluginId, "--dir", root]);
  const source = join(root, pluginId);
  copyFileSync(join(source, "manifest.json"), join(pluginDir, "plugin.json"));
  copyFileSync(join(source, "plugin.js"), join(pluginDir, "plugin.js"));
  run(["plugin", "enable", pluginId]);
  const output = run(["plugin", "run", pluginId, "sha256", "--yes", "input=hello"]);
  assert(output.includes("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"), output);
  console.log("Plugin runtime smoke passed: generated SHA-256 plugin executed without a PATH interpreter.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
