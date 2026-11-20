import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkScriptQuotes, hasSingleQuotedArgument } from "./check-script-quotes.mjs";

function repo(scripts) {
  const root = mkdtempSync(join(tmpdir(), "script-quotes-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", private: true, scripts }));
  return root;
}

test("double-quoted arguments pass", () => {
  assert.deepEqual(checkScriptQuotes(repo({ build: 'pnpm --filter "!@0/docs" -r build' })), []);
});
test("a single quote inside double quotes passes", () => {
  assert.equal(hasSingleQuotedArgument(`node -e "console.log('ok')"`), false);
});
test("the single-quoted filter that broke pnpm build on Windows is rejected", () => {
  const e = checkScriptQuotes(repo({ build: "pnpm --filter '!@0/docs' -r build", ok: "pnpm test" }));
  assert.equal(e.length, 1);
  assert.match(e[0], /package\.json: script "build" uses single quotes/);
});
test("this repository passes", () => {
  assert.deepEqual(checkScriptQuotes(join(import.meta.dirname, "..")), []);
});
