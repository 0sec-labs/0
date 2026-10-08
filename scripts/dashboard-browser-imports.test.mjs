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
      "packages/dashboard/src/console/session-rail.tsx",
      "packages/dashboard/src/components/workflow-definition-editor.tsx",
      "packages/dashboard/src/components/workflow-phase-editor.tsx",
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

test("team presence preserves direct writes and authenticated read-only access", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".team-client-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ entryPoints: [resolve(dashboard, "src/lib/team-client.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { createTeamClient } = await import(pathToFileURL(output).href);
    const calls = [];
    let denied = false;
    let canWrite = true;
    const transport = async (path, init) => {
      calls.push({ path, init });
      if (denied) return Response.json({ error: "Membership revoked" }, { status: 403 });
      if (path === "/api/team/presence") return Response.json({ workspaceId: "workspace", viewer: { userId: "alice", displayName: "Alice", role: canWrite ? "editor" : "viewer" }, rooms: [{ kind: "conversation", id: "chat", presence: [{ userId: "alice", displayName: "Alice", viewing: true, typing: true, updatedAt: Date.now() }] }] });
      return Response.json({ conversationId: "chat", canWrite, revision: 1, presence: [] });
    };
    const client = createTeamClient("owner-engine", transport);
    assert.equal((await client.snapshot("chat")).canWrite, true, "editors can write directly without reserving a chat");
    const start = calls.length;
    await client.presence("chat", { viewing: true, typing: true });
    assert.equal(calls[start].path, "/api/team/conversations/chat/presence");
    assert.deepEqual(JSON.parse(calls[start].init.body), { viewing: true, typing: true, clientId: client.clientId });
    assert.match(client.clientId, /^[0-9a-f-]{36}$/);
    assert.equal(new Headers(calls[start].init.headers).has("X-0-Team-Lease"), false);
    assert.ok(!calls.some(call => /control|proposal/.test(call.path)));
    const overview = await client.overview();
    assert.equal(overview.rooms[0].presence[0].displayName, "Alice");
    await client.roomPresence("report", "report/id", { viewing: true, typing: false });
    assert.equal(calls.at(-2).path, "/api/team/rooms/report/report%2Fid/presence");
    assert.equal(JSON.parse(calls.at(-2).init.body).clientId, client.clientId, "widgets sharing one backend client share its tab identity");
    const secondTab = createTeamClient("owner-engine", transport);
    assert.notEqual(secondTab.clientId, client.clientId, "same backend and cookie in another tab gets distinct presence identity");
    await secondTab.presence("chat", { viewing: true, typing: false });
    assert.equal(JSON.parse(calls.at(-2).init.body).clientId, secondTab.clientId);
    await client.leavePresence("conversation", "chat");
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { viewing: false, typing: false, clientId: client.clientId });
    assert.equal(calls.at(-1).init.signal.aborted, false, "leaving is independent from the disposed heartbeat's signal");
    canWrite = false;
    assert.equal((await client.snapshot("chat")).canWrite, false, "server viewers remain read-only");
    denied = true;
    await assert.rejects(client.presence("chat", { viewing: true, typing: false }), /Membership revoked/);
    assert.equal(typeof client.control, "undefined");
    assert.equal(typeof client.propose, "undefined");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("chat presence avatars show real viewing and typing without control actions", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".team-presence-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { TeamPresenceAvatars } from "./src/console/team-collaboration";
      export const render = props => renderToStaticMarkup(React.createElement(TeamPresenceAvatars, props));
    `, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, logLevel: "silent" });
    const { render } = await import(pathToFileURL(output).href);
    const html = render({ compact: true, presence: [{ userId: "alice", displayName: "Alice Tester", viewing: true, typing: true, updatedAt: Date.now() }, { userId: "bob", displayName: "Bob", viewing: true, typing: false, updatedAt: Date.now() }, { userId: "hidden", displayName: "Hidden user", viewing: false, typing: false, updatedAt: Date.now() }] });
    assert.match(html, /Alice Tester typing/);
    assert.match(html, /Bob viewing/);
    assert.match(html, /2 viewing/);
    assert.doesNotMatch(html, /Hidden user|Take control|Release control|Propose|controller/i);
    assert.equal(render({ presence: [] }), "");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("authenticated team SSE frames reconnect safely and stop on abort", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".team-stream-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ entryPoints: [resolve(dashboard, "src/lib/team-client.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { createTeamClient, TeamPresenceEventParser } = await import(pathToFileURL(output).href);
    const overview = { workspaceId: "workspace", viewer: { userId: "alice", displayName: "Alice", role: "editor" }, rooms: [] };
    const parser = new TeamPresenceEventParser();
    assert.deepEqual(parser.push(": keepalive\r\nevent:presence\r\ndata:" + JSON.stringify(overview) + "\r"), []);
    const events = parser.push("\n\r\nevent:presence\ndata:{invalid}\n\nevent:changed\ndata:{\"kind\":\"report\",\"id\":\"report-a\"}\n\nevent:changed\ndata:{\"all\":true}\n\n");
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], { type: "presence", overview });
    assert.deepEqual(events[1], { type: "changed", change: { kind: "report", id: "report-a" } });
    assert.deepEqual(events[2], { type: "changed", change: { all: true } });
    assert.throws(() => new TeamPresenceEventParser().push("data:" + "😃".repeat(300000)), /1 MiB/);
    const controller = new AbortController();
    const calls = []; const changes = []; const failures = [];
    let streams = 0;
    const authenticatedTransport = async (path, init) => {
      assert.ok(init.signal, "all requests stay cancellable within the authenticated facade");
      assert.ok(path === "/api/team/presence" || path === "/api/team/events", "no anonymous URLs or query credentials");
      calls.push(path);
      if (path === "/api/team/presence") return Response.json(overview);
      assert.equal(init.headers.Accept, "text/event-stream");
      streams++;
      const body = new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode("event:presence\ndata:" + JSON.stringify(overview) + "\n\n"));
        if (streams === 1) stream.close();
        else stream.enqueue(new TextEncoder().encode("event:changed\ndata:{\"kind\":\"workflow\",\"id\":\"workflow-a\"}\n\n"));
      } });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
    const client = createTeamClient("engine", authenticatedTransport);
    await client.subscribeOverview(() => {}, { signal: controller.signal, onError: error => failures.push(error.message), onChanged: change => { changes.push(change); if ("kind" in change && change.kind === "workflow") controller.abort(); } });
    assert.deepEqual(calls, ["/api/team/presence", "/api/team/events", "/api/team/presence", "/api/team/events"]);
    assert.equal(failures.length, 1, "a closed connection reports an error before reconciling and reconnecting");
    assert.equal(changes.filter(change => "all" in change).length, 2, "missed content is invalidated after each reconnect snapshot");
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await client.subscribeOverview(() => assert.fail("late update"), { signal: alreadyAborted.signal });
    assert.equal(calls.length, 4);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("workflow draft bases retain their version when peers edit and advance only submitted saves", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".workflow-draft-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ entryPoints: [resolve(dashboard, "src/components/workflow-definition-editor.tsx")], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, logLevel: "silent" });
    const { workflowDraftHasConflict, advanceWorkflowDraftBase } = await import(pathToFileURL(output).href);
    const base = { id: "workflow", revision: 3, name: "Original", instructions: "Original scope", target: "./repo", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", nodes: [{ id: "review", type: "audit", label: "Review", enabled: true }], edges: [] };
    const peer = { ...base, revision: 4, name: "Peer name" };
    assert.equal(workflowDraftHasConflict(base, peer), true);
    assert.equal(base.revision, 3, "the held draft is not rebased merely because a newer peer revision arrives");
    const submitted = { ...base, instructions: "My retained draft" };
    const advanced = advanceWorkflowDraftBase(base, submitted);
    assert.equal(advanced.revision, 4);
    assert.equal(advanced.name, "Original", "a submitted draft does not silently merge peer properties");
    assert.equal(advanced.instructions, "My retained draft");
    assert.equal(workflowDraftHasConflict(advanced, { ...peer, revision: 5 }), true, "a second peer save remains a conflict after our own save");
    assert.throws(() => advanceWorkflowDraftBase(base, { ...submitted, revision: 4 }), /draft revision/);
    advanced.nodes[0].label = "Changed after save";
    assert.equal(base.nodes[0].label, "Review");
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

test("streaming word fades preserve Markdown text, links, and code", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".streaming-text-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import ReactMarkdown from "react-markdown";
      import { streamWordFade } from "./src/console/streaming-text";
      export const render = text => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [streamWordFade], children: text }));
    `, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", logLevel: "silent" });
    const { render } = await import(pathToFileURL(output).href);
    const html = render("Hello **world** 👋 café.\n\n[Docs](https://example.com) and `literal code`.\n\n```js\nconst n = 1;\n```");
    assert.match(html, /<strong><span class="console-stream-word">world<\/span><\/strong>/);
    assert.match(html, /👋/);
    assert.match(html, /café/);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.match(html, /<code>literal code<\/code>/);
    assert.match(html, /<pre><code class="language-js">const n = 1;\n<\/code><\/pre>/);
    assert.match(render("Hello world"), /<span class="console-stream-word">Hello <\/span>/);
    assert.match(render("Hello world again"), /<span class="console-stream-word">Hello <\/span>/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
