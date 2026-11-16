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

const env = { ...process.env, ZERO_AGENT_SESSION: "", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: emptyPath };
const strip = text => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
function run(args, { expect = 0, extraEnv = {} } = {}) {
  const result = spawnSync(command, [...prefix, ...args], { cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
  const text = strip(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.equal(result.status, expect, `extension smoke: ${args.join(" ")} exited ${result.status}, wanted ${expect}\n${text}`);
  return text;
}
try {
  // The old MCP server file is imported on first use, as a disabled local extension; nothing is started.
  const listed = run(["skills", "extensions", "list"]);
  assert(/scope\s+built-in/.test(listed), listed);
  assert(/old/.test(listed), `the old MCP server was not imported:\n${listed}`);
  // One prompt first; nothing is installed without --yes.
  const review = run(["skills", "extensions", "add", fixture], { expect: 2 });
  assert(review.includes("release-smoke") && review.includes("Re-run with --yes"), review);
  // A flag alone never approves from an agent session.
  const refused = run(["skills", "extensions", "add", fixture, "--yes"], { expect: 2, extraEnv: { ZERO_AGENT_SESSION: "1" } });
  assert(/run by a thread, not by you/.test(refused) && !/ZERO_AGENT_SESSION|agent session/i.test(refused), refused);
  assert(!/release-smoke/.test(run(["skills", "extensions", "list"]).split("\n").find(line => line.includes("release-smoke")) ?? ""), "agent session installed an extension");
  // A person running --yes without a terminal (CI, a script) installs; flags work before and after the source.
  const added = run(["skills", "extensions", "add", fixture, "--yes"]);
  assert(/Installed extension release-smoke/.test(added), added);
  assert(/release-smoke/.test(run(["skills", "extensions", "list"])));
  assert(/Enabled release-smoke/.test(run(["skills", "extensions", "enable", "release-smoke", "--yes"])));
  assert(/enabled/.test(run(["skills", "extensions", "list"]).split("\n").find(line => line.includes("release-smoke")) ?? ""));
  assert(/Disabled release-smoke/.test(run(["skills", "extensions", "disable", "release-smoke"])));
  assert(/release-smoke/.test(run(["skills", "add", "--preview", fixture])) && /release-smoke/.test(run(["skills", "add", fixture, "--preview"])));
  const old = run(["plugin", "list"]);
  assert(/scope/.test(old), old);
  console.log(`Extension smoke passed: review, agent-session refusal, install without a terminal, enable, disable, list, old-data import ran from the built CLI without a PATH interpreter.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
