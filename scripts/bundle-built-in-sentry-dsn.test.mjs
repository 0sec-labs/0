// Guards the build-time handling of ZERO_RELEASE_SENTRY_DSN: unset/empty is fine,
// a malformed value fails loudly without echoing it. The script under test is the
// validator that scripts/bundle-cli.mjs and scripts/bun-compile.sh both call, so
// the real bundle is not rebuilt here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildSentryDsn } from "./built-in-sentry-dsn.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/built-in-sentry-dsn.mjs");
const FAKE = "https://abc123@o0.ingest.sentry.io/1";

function run(value) {
  const env = { ...process.env };
  delete env.ZERO_RELEASE_SENTRY_DSN;
  if (value !== undefined) env.ZERO_RELEASE_SENTRY_DSN = value;
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
}

test("unset and empty are treated as unprovisioned", () => {
  for (const value of [undefined, "", "   "]) {
    const result = run(value);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  }
});

test("a valid https DSN is passed through", () => {
  const result = run(FAKE);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), FAKE);
});

test("a malformed DSN fails loudly without echoing the value", () => {
  for (const value of ["not a dsn", "http://abc123@o0.ingest.sentry.io/1", "https://k:secret@o0.ingest.sentry.io/1", "https://abc123@o0.ingest.sentry.io/x", "https://o0.ingest.sentry.io/1", "https://abc123@o0.ingest.sentry.io/1?q=1"]) {
    const result = run(value);
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /ZERO_RELEASE_SENTRY_DSN/);
    assert.equal(result.stderr.includes("secret"), false);
    assert.equal(result.stdout, "");
  }
  assert.throws(() => resolveBuildSentryDsn({ ZERO_RELEASE_SENTRY_DSN: "garbage" }), /not a valid/);
});

test("bundle-cli validates before bundling and embeds via define", () => {
  const source = readFileSync(join(ROOT, "scripts/bundle-cli.mjs"), "utf8");
  assert.match(source, /resolveBuildSentryDsn\(\)/);
  assert.match(source, /__ZERO_BUILT_IN_SENTRY_DSN__: JSON\.stringify\(BUILT_IN_SENTRY_DSN\)/);
  assert.ok(source.indexOf("resolveBuildSentryDsn()") < source.indexOf("await build("));
});
