// Guards the build-time handling of ZERO_RELEASE_POSTHOG_KEY: unset/empty is fine,
// a malformed value fails loudly without echoing it. The script under test is the
// validator that scripts/bundle-cli.mjs and scripts/bun-compile.sh both call, so
// the real bundle is not rebuilt here. Mirrors bundle-built-in-sentry-dsn.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildPostHogKey } from "./built-in-posthog-key.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/built-in-posthog-key.mjs");
const FAKE = "phc_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";

function run(value) {
  const env = { ...process.env };
  delete env.ZERO_RELEASE_POSTHOG_KEY;
  if (value !== undefined) env.ZERO_RELEASE_POSTHOG_KEY = value;
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
}

test("unset and empty are treated as unprovisioned", () => {
  for (const value of [undefined, "", "   "]) {
    const result = run(value);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  }
});

test("a valid project key is passed through", () => {
  const result = run(FAKE);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), FAKE);
});

test("a malformed key fails loudly without echoing the value", () => {
  for (const value of ["not a key", "phx_FAKEFAKEFAKEFAKEFAKEFAKEFAKE", "phc_short", "phc_FAKEFAKEFAKEFAKEFAKEFAKE-SECRETISH", "https://phc_FAKEFAKEFAKEFAKEFAKEFAKEFAKE@x"]) {
    const result = run(value);
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /ZERO_RELEASE_POSTHOG_KEY/);
    assert.equal(result.stderr.includes("FAKEFAKE"), false);
    assert.equal(result.stderr.includes("SECRETISH"), false);
    assert.equal(result.stdout, "");
  }
  assert.throws(() => resolveBuildPostHogKey({ ZERO_RELEASE_POSTHOG_KEY: "garbage" }), /not a valid/);
});

test("bundle-cli and bun-compile validate before bundling and embed via define", () => {
  const source = readFileSync(join(ROOT, "scripts/bundle-cli.mjs"), "utf8");
  assert.match(source, /resolveBuildPostHogKey\(\)/);
  assert.match(source, /__ZERO_BUILT_IN_POSTHOG_KEY__: JSON\.stringify\(BUILT_IN_POSTHOG_KEY\)/);
  assert.ok(source.indexOf("resolveBuildPostHogKey()") < source.indexOf("await build("));
  const compile = readFileSync(join(ROOT, "scripts/bun-compile.sh"), "utf8");
  assert.match(compile, /built-in-posthog-key\.mjs/);
  assert.match(compile, /--define "__ZERO_BUILT_IN_POSTHOG_KEY__=/);
});

test("only the release compile step receives the secret", () => {
  const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.equal(release.match(/secrets\.ZERO_RELEASE_POSTHOG_KEY/g)?.length, 1);
  for (const name of ["main.yml", "public-pr.yml", "docs.yml", "install-e2e.yml"]) {
    assert.equal(readFileSync(join(ROOT, ".github/workflows", name), "utf8").includes("ZERO_RELEASE_POSTHOG_KEY"), false, name);
  }
});
