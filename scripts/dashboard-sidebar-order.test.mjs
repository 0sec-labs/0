import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
test("sidebar rank survives opening, saved/live transitions and renames; new messages move it", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "0-sidebar-order-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ entryPoints: [resolve(root, "packages/dashboard/src/console/sidebar-chat-order.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { rememberSidebarActivity, sidebarChatDetails, sortSidebarChats } = await import(pathToFileURL(output).href);
    const activity = new Map();
    const collisions = [
      { kind: "live", key: "current-transcript", session: { title: "Review", status: "working", messageCount: 774 } },
      { kind: "live", key: "earlier-transcript", session: { title: "Review", status: "failed", messageCount: 262 } },
      { kind: "saved", key: "saved-transcript", session: { summary: " review ", messageCount: 20 } },
      { kind: "live", key: "unique", session: { title: "Other", status: "ready" } },
    ];
    const details = sidebarChatDetails(collisions);
    assert.equal(details.get("current-transcript"), "Responding · 774 messages · current-");
    assert.equal(details.get("earlier-transcript"), "Needs attention · 262 messages · earlier-");
    assert.equal(details.get("saved-transcript"), "Saved · 20 messages · saved-tr");
    assert.equal(details.has("unique"), false);
    assert.equal(collisions.length, 4, "distinct transcripts with matching titles stay accessible");

    const saved = (key, timestamp, count, title = key) => ({ kind: "saved", key, timestamp, session: { id: key, savedAt: timestamp, messageCount: count, summary: title } });
    const live = (key, timestamp, count, id = "new-runtime", title = key) => ({ kind: "live", key, timestamp, session: { id, savedId: key, messageCount: count, title, updatedAt: new Date(timestamp).toISOString() } });
    const order = rows => sortSidebarChats(rememberSidebarActivity(rows, activity), "updated").map(row => row.key);
    const original = [saved("recent", 2000, 4), saved("older", 1000, 8)];
    const copy = structuredClone(original);
    assert.deepEqual(order(original), ["recent", "older"]);
    assert.deepEqual(original, copy, "query cache rows stay immutable");
    assert.deepEqual(order([saved("recent", 2000, 4), live("older", 9000, 8)]), ["recent", "older"], "resuming an older chat cannot promote it");
    assert.deepEqual(order([saved("recent", 2000, 4), live("older", 12000, 8, "another-runtime", "Renamed")]), ["recent", "older"], "handle and title changes preserve rank");
    assert.deepEqual(order([saved("recent", 2000, 4), saved("older", 15000, 8, "Renamed")]), ["recent", "older"], "saving without a new message preserves rank");
    assert.deepEqual(order([saved("recent", 2000, 4), live("older", 16000, 9)]), ["older", "recent"], "a real message increases activity");
    assert.deepEqual(order([saved("recent", 2000, 4), live("older", 17000, 2)]), ["older", "recent"]);
    assert.equal(activity.get("older").messageCount, 9, "shortened runtime metadata cannot lower the count baseline");
    assert.deepEqual(order([saved("recent", 2000, 4), live("older", 19000, 9)]), ["older", "recent"]);
    assert.equal(activity.get("older").timestamp, 16000, "restoring the old count is not another new message");
    const remembered = rememberSidebarActivity([saved("z", 1, 1, "Zebra"), saved("a", 2, 1, "Apple")], new Map());
    assert.deepEqual(sortSidebarChats(remembered, "name").map(row => row.key), ["a", "z"]);
    assert.deepEqual(sortSidebarChats(remembered, "updated", "  zebra ").map(row => row.key), ["z"]);
    assert.equal(rememberSidebarActivity([saved("older", 22000, 9)], new Map())[0].timestamp, 22000, "a separate host/account owns its independent history");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
