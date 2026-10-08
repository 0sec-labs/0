import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("assessment milestone surfaces load without Node-only shared modules", async () => {
  // Vite production builds can prune unused barrel exports. Development
  // modules still evaluate them, so browser imports must stand on their own.
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [
      "packages/dashboard/src/components/access-milestone.tsx",
      "packages/dashboard/src/components/event-timeline.tsx",
      "packages/dashboard/src/lib/hunt-stream.ts",
      "packages/dashboard/src/pages/engagements-page.tsx",
      "packages/dashboard/src/console/chat-findings.tsx",
      "packages/dashboard/src/console/team-collaboration.tsx",
      "packages/dashboard/src/lib/team-client.ts",
    ],
    outdir: "/tmp/0-dashboard-boundary-test",
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    loader: { ".svg": "dataurl" },
    treeShaking: false,
    alias: { "@": resolve(repoRoot, "packages/dashboard/src") },
    logLevel: "silent",
  });
});

test("team controls require a live lease in this browser and owning backend", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".team-client-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ entryPoints: [resolve(dashboard, "src/lib/team-client.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { createTeamClient, getTeamLeaseToken, clearTeamLeaseTokens } = await import(pathToFileURL(output).href);
    const calls = [];
    let denied = false;
    let expiresAt = Date.now() + 30000;
    const transport = async (path, init) => {
      calls.push({ path, init });
      if (denied) return Response.json({ error: "Membership revoked" }, { status: 403 });
      if (path.endsWith("/control")) return Response.json({ leaseToken: "only-in-memory", expiresAt });
      return Response.json({ conversationId: "chat", canControl: true, revision: 1 });
    };
    const client = createTeamClient("owner-engine", transport);
    assert.equal((await client.snapshot("chat")).canControl, false, "same cookie in another tab is insufficient without its lease");
    await client.control("chat", { action: "claim", expectedRevision: 0 });
    assert.equal(getTeamLeaseToken("owner-engine", "chat"), "only-in-memory");
    assert.equal(getTeamLeaseToken("other-engine", "chat"), undefined);
    assert.equal(getTeamLeaseToken("owner-engine", "other-chat"), undefined);
    const start = calls.length;
    await client.presence("chat", { viewing: true, typing: true });
    assert.equal(calls[start].path, "/api/team/conversations/chat/control");
    assert.equal(calls[start].init.headers.get("X-0-Team-Lease"), "only-in-memory");
    assert.deepEqual(JSON.parse(calls[start].init.body), { action: "renew" });
    await client.decide("chat", "proposal/id", { action: "accept", expectedRevision: 1 });
    assert.equal(calls.at(-2).path, "/api/team/conversations/chat/proposals/proposal%2Fid");
    assert.deepEqual(JSON.parse(calls.at(-2).init.body), { action: "accept" });
    await client.control("chat", { action: "release", expectedRevision: 1 });
    assert.equal(getTeamLeaseToken("owner-engine", "chat"), undefined);
    await client.control("chat", { action: "claim", expectedRevision: 1 });
    denied = true;
    await assert.rejects(client.presence("chat", { viewing: true, typing: false }), /Membership revoked/);
    assert.equal(getTeamLeaseToken("owner-engine", "chat"), undefined);
    denied = false;
    expiresAt = Date.now() - 1;
    await assert.rejects(client.control("chat", { action: "claim", expectedRevision: 1 }), /controller lease/);
    clearTeamLeaseTokens("owner-engine");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("live tool activity survives assistant text, tool completions and cancellation", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".tool-activity-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({
      stdin: { contents: `
        import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { ToolActivity } from "./src/console/tool-activity";
        export { reduceTurns, reduceConversation } from "./src/console/transcript";
        export const render = props => renderToStaticMarkup(React.createElement(ToolActivity, props));
      `, resolveDir: dashboard, loader: "tsx" },
      outfile: output, bundle: true, platform: "node", format: "esm",
      packages: "external", loader: { ".css": "empty" }, logLevel: "silent",
      jsx: "automatic",
    });
    const { render, reduceTurns, reduceConversation } = await import(pathToFileURL(output).href);
    const events = [
      { type: "user", sequence: 1, text: "Review the fixture" },
      { type: "reasoning-delta", sequence: 2, text: "**Check files**" },
      { type: "assistant-delta", sequence: 3, text: "I'll inspect the files." },
      { type: "tool-start", sequence: 4, call: { id: "read", name: "read_file", arguments: {} } },
      { type: "tool-start", sequence: 5, call: { id: "search", name: "search_files", arguments: {} } },
    ];
    const view = (status = "working") => {
      const [turn] = reduceTurns(events, status);
      return { turn, html: render({ calls: turn.toolCalls, reasoning: turn.reasoningText, working: turn.isWorking }) };
    };
    let { turn, html } = view();
    assert.ok(turn.assistantText);
    assert.match(html, /Used 0 tools · 2 running/);
    assert.match(html, /Using read_file/);
    assert.match(html, /Using search_files/);
    assert.match(html, /aria-label="Live tools"/);
    assert.match(html, /data-running="true"/);
    assert.match(html, /<strong>Check files<\/strong>/);
    events.push({ type: "tool-result", sequence: 6, call: { id: "read", name: "read_file" }, result: "fixture" });
    html = view().html;
    assert.match(html, /Used 1 tool · 1 running/);
    assert.match(html, /Using search_files/);
    events.push({ type: "tool-result", sequence: 7, call: { id: "search", name: "search_files" }, result: { success: false, error: "fixture failure" } });
    html = view().html;
    assert.match(html, /Used 2 tools · Thinking/);
    assert.match(html, /1 failed/);
    events.push({ type: "reasoning-delta", sequence: 8, text: "**Summarize findings**" });
    assert.equal(view().turn.reasoningText, "**Check files**\n\n**Summarize findings**");
    html = view("idle").html;
    assert.match(html, /Used 2 tools/);
    assert.doesNotMatch(html, /Thinking|aria-label="Live tools"|data-active=/);
    html = render({ calls: [{ id: "stopped", name: "read_file", arguments: {}, isRunning: false }], working: false });
    assert.match(html, /Used 0 tools/);
    assert.match(html, /Stopped/);
    const calls = ["provider-1", "provider-2"].map(id => ({ type: "tool_use", id, name: "read_file", input: { path: "package.json" } }));
    const journal = [
      { type: "user", sequence: 1, text: "Check files" },
      ...["gateway-1", "gateway-2"].map((id, index) => ({ type: "tool-start", sequence: index + 2, call: { id, name: "read_file", arguments: { path: "package.json" } } })),
    ];
    const snapshot = { session: { status: "working" }, messages: [{ role: "user", content: [{ type: "text", text: "Check files" }] }, { role: "assistant", content: calls }], events: journal, pendingDecisions: [], cursor: 3 };
    assert.equal(reduceConversation(snapshot)[0].toolCalls.length, 2, "two genuine repeated calls survive, without doubling history and live events");
    snapshot.events = [journal[0], journal[2], { type: "tool-result", sequence: 4, call: journal[2].call, result: "latest" }];
    const merged = reduceConversation(snapshot)[0].toolCalls;
    assert.equal(merged.length, 2);
    assert.equal(merged[0].result, undefined);
    assert.equal(merged[1].result, "latest", "a truncated journal matches the latest identical call");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
