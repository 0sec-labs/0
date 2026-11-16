import assert from "node:assert/strict";
import { test } from "node:test";
import { GROUPS, runGroup } from "./run-checks.mjs";

test("a failing check does not hide the checks after it", () => {
  const seen = [];
  const quiet = console.log;
  const quietErr = console.error;
  console.log = () => {};
  console.error = () => {};
  let result;
  try {
    result = runGroup("packages", (cmd) => (seen.push(cmd), seen.length === 1 ? 1 : 0));
  } finally {
    console.log = quiet;
    console.error = quietErr;
  }
  assert.equal(seen.length, GROUPS.packages.length);
  assert.deepEqual(result.failed, [GROUPS.packages[0]]);
});

test("an unknown group is an error", () => assert.throws(() => runGroup("nope"), /unknown check group/));
