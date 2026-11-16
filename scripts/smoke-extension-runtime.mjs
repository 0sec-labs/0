import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Extension smoke for a release binary: a fixture local extension is reviewed, installed, listed, enabled and disabled
// through the real CLI, and an old-format MCP server file is imported as a disabled extension. No interpreter is on PATH.
const entry = process.argv[2];
if (!entry) throw new Error("Usage: node scripts/smoke-extension-runtime.mjs <CLI JavaScript entry or standalone binary>");
const cli = realpathSync(resolve(entry));
const command = cli.endsWith(".js") ? process.execPath : cli;
const prefix = cli.endsWith(".js") ? [cli] : [];
const root = mkdtempSync(join(tmpdir(), "0-extension-runtime-"));
const home = join(root, "home");
const project = join(root, "project");
const emptyPath = join(root, "no-executables");
const fixture = join(root, "fixture-ext");
for (const dir of [home, project, emptyPath, join(fixture, "skills", "hello"), join(home, ".0")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(fixture, "extension.json"), JSON.stringify({ name: "release-smoke", version: "1.0.0", description: "Release smoke fixture" }));
writeFileSync(join(fixture, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Say hello\n---\nSay hello.\n");
writeFileSync(join(home, ".0", "mcp-servers.json"), JSON.stringify([{ id: "custom-old", name: "old", transport: "stdio", command: "echo", args: ["hi"], enabled: true }]));

const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: emptyPath };
const strip = text => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
function run(args, { expect = 0 } = {}) {
  const result = spawnSync(command, [...prefix, ...args], { cwd: project, env, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
  const text = strip(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.equal(result.status, expect, `extension smoke: ${args.join(" ")} exited ${result.status}, wanted ${expect}\n${text}`);
  return text;
}
/** Approvals need a terminal. Where the platform has `script`, play the operator at one; elsewhere only the refusal is asserted. */
function operator(args) {
  const quoted = [command, ...prefix, ...args].map(part => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
  const argv = process.platform === "darwin" ? ["-q", "/dev/null", "/bin/sh", "-c", quoted] : ["-qec", quoted, "/dev/null"];
  const result = spawnSync("script", argv, { cwd: project, env: { ...env, PATH: `${emptyPath}:/usr/bin:/bin` }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  return { code: result.status, text: strip(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
}
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"], { encoding: "utf8" }).error === undefined;

try {
  // The old MCP server file is imported on first use, as a disabled local extension; nothing is started.
  const listed = run(["skills", "extensions", "list"]);
  assert(/scope\s+built-in/.test(listed), listed);
  assert(/old/.test(listed), `the old MCP server was not imported:\n${listed}`);
  // One prompt first; nothing is installed without --yes.
  const review = run(["skills", "extensions", "add", fixture], { expect: 2 });
  assert(review.includes("release-smoke") && review.includes("Re-run with --yes"), review);
  // A flag alone never approves: without a terminal the install is refused.
  const refused = run(["skills", "extensions", "add", fixture, "--yes"], { expect: 2 });
  assert(/without a terminal/.test(refused), refused);
  let lifecycle = false;
  if (hasScript) {
    const added = operator(["skills", "extensions", "add", fixture, "--yes"]);
    // A runner that cannot give `script` a terminal is not a failure of the extension code: say so and skip.
    if (/tcgetattr|ioctl|not a terminal/i.test(added.text)) console.log("note: this runner cannot allocate a terminal; install, enable and disable are covered by the unit tests.");
    else {
      assert(/Installed extension release-smoke/.test(added.text), added.text);
      assert(/release-smoke/.test(run(["skills", "extensions", "list"])));
      assert(/Enabled release-smoke/.test(operator(["skills", "extensions", "enable", "release-smoke", "--yes"]).text));
      assert(/enabled/.test(run(["skills", "extensions", "list"]).split("\n").find(line => line.includes("release-smoke")) ?? ""));
      assert(/Disabled release-smoke/.test(operator(["skills", "extensions", "disable", "release-smoke"]).text));
      lifecycle = true;
    }
  } else console.log("note: no pseudo-terminal on this platform; install, enable and disable are covered by the unit tests, the terminal refusal was asserted.");
  const old = run(["plugin", "list"]);
  assert(/scope/.test(old), old);
  console.log(`Extension smoke passed: review, terminal refusal, list, old-data import${lifecycle ? ", install, enable and disable" : ""} ran from the built CLI without a PATH interpreter.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
