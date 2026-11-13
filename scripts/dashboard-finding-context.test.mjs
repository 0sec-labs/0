import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
test("finding provenance survives later occurrences, saved aliases, and older engines", async () => {
  const directory = await mkdtemp("/tmp/0-finding-context-");
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ entryPoints: [resolve(root, "packages/dashboard/src/console/finding-context.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { findingsForChat, existingFindingsForChat, findingSourceScanIds } = await import(pathToFileURL(output).href);
    const repeated = { fingerprint: "issue", latest: { id: "new", scanId: "later-chat", timestamp: 20, title: "Issue", triageStatus: "new" }, sourceScanIds: ["original-chat", "later-chat"] };
    const legacy = { fingerprint: "legacy", latest: { id: "legacy", scanId: "legacy-chat", timestamp: 10, title: "Legacy", triageStatus: "new" } };
    const groups = [legacy, repeated];
    assert.deepEqual(findingsForChat(groups, "original-chat"), [repeated]);
    assert.deepEqual(findingsForChat(groups, "live-id", "original-chat"), [repeated]);
    assert.deepEqual(existingFindingsForChat(groups, "original-chat"), [legacy]);
    assert.deepEqual(existingFindingsForChat(groups, "unrelated-chat", undefined, "original-chat"), [repeated]);
    assert.deepEqual(findingsForChat(groups, "legacy-chat"), [legacy]);
    assert.deepEqual(findingSourceScanIds({ ...repeated, sourceScanIds: ["original-chat", "original-chat"] }), ["original-chat", "later-chat"]);
    assert.deepEqual(findingsForChat([{ ...repeated, latest: { ...repeated.latest, triageStatus: "suppressed" } }], "original-chat"), []);
    assert.deepEqual(findingsForChat(groups, "unrelated-chat"), []);
    const child = { fingerprint: "child-issue", latest: { id: "child-new", scanId: "later-scan", timestamp: 30, title: "Child issue", triageStatus: "new" }, sourceScanIds: ["child-scan", "later-scan"] };
    const runs = [
      { id: "workflow-one", conversation: { sessionId: "original-chat" }, native: { scanIds: ["child-scan"] } },
      { id: "unrelated", conversation: { sessionId: "other-chat" }, native: { scanIds: ["legacy-chat"] } },
      { id: "standalone", conversation: null, native: { scanIds: ["later-scan"] } },
    ];
    assert.deepEqual(findingsForChat([...groups, child], "original-chat", undefined, runs), [child, repeated]);
    assert.deepEqual(findingsForChat([...groups, child], "live-id", "original-chat", runs), [child, repeated]);
    assert.deepEqual(existingFindingsForChat([...groups, child], "original-chat", undefined, "", runs), [legacy]);
    assert.deepEqual(findingsForChat([child], "other-chat", undefined, runs), []);
    assert.deepEqual(findingsForChat([child], "workflow-one", undefined, runs), [], "workflow IDs are not conversation IDs");
    assert.deepEqual(findingsForChat([child], "original-chat"), [], "missing provenance never invents a relationship");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
