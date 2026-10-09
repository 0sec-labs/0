import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Uses only disposable named workspace state. Never changes HOME or starts an LLM turn.
const repo = resolve(process.argv[2] ?? process.cwd());
const { osecDB } = await import(pathToFileURL(join(repo, "packages/db/dist/index.js")));
const { defaultTeamConfigPath, isolatedTeamPaths } = await import(pathToFileURL(join(repo, "packages/cli/dist/web/team-setup.js")));
const directory = await mkdtemp(join(tmpdir(), "zero-team-workspace-smoke-"));
const workspace = join(directory, "workspace"); await mkdir(workspace);
const mountFixture = join(workspace, "qa-skill-folder");
await mkdir(join(mountFixture, "disposable-host-review"), { recursive: true });
await writeFile(join(mountFixture, "disposable-host-review", "SKILL.md"), "---\nname: disposable-host-review\ndescription: Disposable owner mount QA fixture.\n---\n\nReview retained local evidence without executing commands.\n");
const personalDB = join(directory, "personal.db");
const registry = join(directory, "backends.json"); await writeFile(registry, JSON.stringify({ schemaVersion: 1, backends: [] }));
const configPath = defaultTeamConfigPath(workspace);
const seedId = `qa-private-${randomUUID()}`;
const privateFindingId = `qa-private-finding-${randomUUID()}`;
const qaFinding = id => ({ id, templateId: "qa", title: "Disposable retained evidence", description: "Synthetic evidence for API isolation QA.", severity: "high", category: "path-traversal", status: "verified", timestamp: Date.now(), evidence: { request: "disposable fixture", response: "synthetic fixture response" } });
const db = new osecDB(personalDB);
try { db.createScan({ target: "disposable-private-row", depth: "quick", format: "json" }, seedId); db.saveFinding(seedId, qaFinding(privateFindingId)); } finally { db.close(); }
let child; let origin; let token; let teamPaths; let createdWorkspaceId;
const streams = [];
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function start(port = "0") {
  child = spawn(process.execPath, [join(repo, "packages/cli/dist/index.js"), "dashboard", "--port", port, "--db-path", personalDB, "--engine-workspace", workspace, "--engine-token-env", "ZERO_TEAM_SMOKE_ENGINE_KEY", "--backends-config", registry, "--asset-dir", join(repo, "packages/dashboard/dist"), "--ready-json", "--no-open"], {
    cwd: workspace, env: { ...process.env, ZERO_TEAM_SMOKE_ENGINE_KEY: randomUUID(), ZERO_TEAM_CONFIG: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  let output = "";
  child.stdout.on("data", bytes => { output = (output + bytes.toString()).slice(-32000); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Disposable server exited during startup.");
    const match = /ZERO_DASHBOARD_READY (\{[^\n]+\})/.exec(output);
    if (match) { origin = JSON.parse(match[1]).url.replace(/\/$/, ""); break; }
    await wait(50);
  }
  if (!origin) throw new Error("Disposable server did not become ready.");
  const html = await (await fetch(origin)).text();
  token = /<meta name="0-control-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("Disposable server bootstrap did not supply a control token.");
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const deadline = Date.now() + 8000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(50);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolveStop => child.once("exit", resolveStop)); }
}
function jar() {
  let cookie = "";
  return {
    async request(path, method = "GET", input, expected = 200) {
      const response = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, "X-0-Control-Token": token, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10000) });
      const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const data = await response.json().catch(() => null);
      if (expected !== null) check(response.status === expected, `${method} ${path}: expected ${expected}, received ${response.status}.`);
      return { status: response.status, data };
    },
    async stream() {
      const controller = new AbortController();
      const response = await fetch(`${origin}/api/team/events`, { headers: { Origin: origin, "X-0-Control-Token": token, Cookie: cookie, Accept: "text/event-stream" }, signal: controller.signal });
      check(response.ok && response.body && response.headers.get("content-type")?.includes("text/event-stream"), "Authenticated presence stream opened.");
      const reader = response.body.getReader();
      const feed = { events: [], close() { controller.abort(); void reader.cancel().catch(() => {}); } };
      streams.push(feed);
      void (async () => {
        const decoder = new TextDecoder(); let buffer = "";
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 1024 * 1024) throw new Error("Presence frame exceeds smoke limit.");
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const type = /^event: ?(.+)$/m.exec(frame)?.[1];
              const data = /^data: ?(.+)$/m.exec(frame)?.[1];
              if (data) { try { feed.events.push({ type, data: JSON.parse(data) }); if (feed.events.length > 200) feed.events.shift(); } catch { /* Ignore malformed frames. */ } }
            }
          }
        } catch { /* Stream closure is expected during logout and restart. */ }
      })();
      return feed;
    },
  };
}
async function eventually(predicate, message) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await wait(25);
  check(predicate(), message);
}

try {
  await start();
  const port = new URL(origin).port;
  const personal = jar();
  const before = await personal.request("/api/dashboard");
  check(before.data.scans.some(scan => scan.id === seedId), "Personal seed is visible before team setup.");
  const password = `Disposable-qa-${randomUUID()}`;
  const owner = jar(), editor = jar(), viewer = jar();
  const setup = await owner.request("/api/team/setup", "POST", { workspaceName: "Disposable API smoke", displayName: "QA Owner", userId: "qa-owner", password }, 201);
  createdWorkspaceId = setup.data.workspace.id;
  check(/^[a-f0-9-]{36}$/.test(createdWorkspaceId), "Setup returns its unique workspace ID.");
  teamPaths = isolatedTeamPaths(createdWorkspaceId);
  const sharedFindingId = `qa-team-finding-${randomUUID()}`;
  const teamDB = new osecDB(teamPaths.dbPath);
  try { teamDB.createScan({ target: "disposable-team-row", depth: "quick", format: "json" }, "qa-team-scan"); teamDB.saveFinding("qa-team-scan", qaFinding(sharedFindingId)); } finally { teamDB.close(); }
  await owner.request("/api/team/users", "POST", { userId: "qa-editor", displayName: "QA Editor", password, role: "editor" }, 201);
  await owner.request("/api/team/users", "POST", { userId: "qa-viewer", displayName: "QA Viewer", password, role: "viewer" }, 201);
  await Promise.all([editor.request("/api/team/auth/login", "POST", { userId: "qa-editor", password }), viewer.request("/api/team/auth/login", "POST", { userId: "qa-viewer", password })]);
  const after = await owner.request("/api/dashboard");
  await personal.request("/api/dashboard", "GET", undefined, 401);
  check(!after.data.scans.some(scan => scan.id === seedId), "Personal evidence is excluded from the team database.");
  const retained = new osecDB(personalDB); try { check(Boolean(retained.getScan(seedId)), "Personal evidence remains intact after transition."); } finally { retained.close(); }
  const [first, second] = await Promise.all([owner.request("/api/console/sessions", "POST", { title: "Owner independent chat" }, 201), editor.request("/api/console/sessions", "POST", { title: "Editor independent chat" }, 201)]);
  const firstId = first.data.session.id, secondId = second.data.session.id;
  check(firstId !== secondId, "Parallel actors receive independent conversations.");
  await Promise.all([editor.request(`/api/console/sessions/${firstId}/save`, "POST", {}), owner.request(`/api/console/sessions/${secondId}/save`, "POST", {})]);
  const ownerFeed = await owner.stream(), editorFeed = await editor.stream();
  const ownerTab = randomUUID(), editorTab = randomUUID(), otherOwnerTab = randomUUID();
  await Promise.all([owner.request(`/api/team/conversations/${firstId}/presence`, "POST", { viewing: true, typing: true, clientId: ownerTab }), editor.request(`/api/team/conversations/${secondId}/presence`, "POST", { viewing: true, typing: true, clientId: editorTab })]);
  await eventually(() => ownerFeed.events.some(event => event.type === "presence" && event.data.rooms.some(room => room.id === secondId && room.presence.some(member => member.userId === "qa-editor" && member.typing))), "Owner stream receives the other actor's real live presence.");
  await eventually(() => editorFeed.events.some(event => event.type === "presence" && event.data.rooms.some(room => room.id === firstId && room.presence.some(member => member.userId === "qa-owner" && member.typing))), "Editor stream receives owner's real live presence.");
  await owner.request(`/api/team/conversations/${firstId}/presence`, "POST", { viewing: true, typing: false, clientId: otherOwnerTab });
  await owner.request(`/api/team/conversations/${firstId}/presence`, "POST", { viewing: false, typing: false, clientId: ownerTab });
  const tabs = await editor.request("/api/team/presence");
  check(tabs.data.rooms.some(room => room.id === firstId && room.presence.some(member => member.userId === "qa-owner" && member.viewing)), "Leaving one same-cookie tab preserves its other tab's presence.");
  await viewer.request(`/api/console/sessions/${firstId}`);
  await viewer.request(`/api/console/sessions/${firstId}/save`, "POST", {}, 403);
  const content = "---\nname: disposable-team-review\ndescription: Disposable QA shared review skill.\n---\n\nReview retained evidence without executing commands.\n";
  const skill = (await editor.request("/api/skills", "POST", { content }, 201)).data.skill;
  const skillPath = `/api/skills/${encodeURIComponent(skill.id)}`;
  await owner.request(skillPath); await viewer.request(skillPath);
  const edits = await Promise.all([owner.request(skillPath, "PUT", { expectedRevision: skill.revision, content: content + "\nOwner reviewed scope.\n" }, null), editor.request(skillPath, "PUT", { expectedRevision: skill.revision, content: content + "\nEditor reviewed scope.\n" }, null)]);
  check(edits.map(result => result.status).sort().join(",") === "200,409", "Concurrent shared skill edits preserve one winner and reject the stale revision.");
  const winner = edits.find(result => result.status === 200).data.skill;
  check((await viewer.request(skillPath)).data.skill.revision === winner.revision, "Viewer sees the winning shared skill revision.");
  await viewer.request(skillPath, "PUT", { expectedRevision: winner.revision, content }, 403);
  await viewer.request("/api/skills/mounts", "POST", { path: workspace }, 403);
  await editor.request("/api/skills/mounts", "POST", { path: workspace }, 403);
  await owner.request("/api/skills/mounts", "POST", { path: mountFixture }, 201);
  await editor.request("/api/console/settings", "PATCH", { qaUnknownSetting: true }, 403);
  await viewer.request("/api/console/settings", "PATCH", { qaUnknownSetting: true }, 403);
  await owner.request("/api/console/settings", "PATCH", { qaUnknownSetting: true }, 400); // Reaches validation without changing global settings.
  await editor.request("/api/team/users", "POST", { userId: "forbidden", displayName: "Forbidden", password, role: "viewer" }, 403);
  const apiCredential = (await owner.request("/api/findings-access", "POST", { name: "Disposable findings read access" }, 201)).data;
  const listedCredentials = (await owner.request("/api/findings-access")).data.credentials;
  check(listedCredentials.some(record => record.id === apiCredential.credential.id) && !JSON.stringify(listedCredentials).includes(apiCredential.token), "Credential listings redact the one-time secret.");
  await editor.request("/api/findings-access", "POST", { name: "Forbidden" }, 403);
  await viewer.request("/api/findings-access", "GET", undefined, 403);
  const readKey = async (path, expected, method = "GET") => {
    const response = await fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${apiCredential.token}` }, signal: AbortSignal.timeout(10000) });
    check(response.status === expected, `${method} ${path}: scoped API expected ${expected}, received ${response.status}.`);
    return response.json();
  };
  const findingList = await readKey("/api/v1/findings", 200);
  check(findingList.workspaceId === createdWorkspaceId && findingList.findings.some(item => item.finding.id === sharedFindingId) && !findingList.findings.some(item => item.finding.id === privateFindingId), "Findings key reads exact team evidence and excludes private findings.");
  await readKey(`/api/v1/findings/${sharedFindingId}`, 200);
  await readKey(`/api/v1/findings/${privateFindingId}`, 404);
  await readKey("/api/console/sessions", 403);
  await readKey("/api/v1/findings", 403, "POST");
  await owner.request(`/api/findings-access/${apiCredential.credential.id}`, "DELETE");
  await readKey("/api/v1/findings", 401);
  await owner.request("/api/team/auth/logout", "POST", {});
  check(!(await owner.request("/api/team/session")).data.user, "Logging out invalidates only the owner's cookie jar.");
  check((await editor.request("/api/team/session")).data.user.userId === "qa-editor", "Editor remains signed in after owner's logout.");
  check((await viewer.request("/api/team/session")).data.user.userId === "qa-viewer", "Viewer remains signed in after owner's logout.");
  for (const stream of streams) stream.close();
  await stop(); origin = undefined;
  await start(port);
  await Promise.all([owner.request("/api/team/auth/login", "POST", { userId: "qa-owner", password }), editor.request("/api/team/auth/login", "POST", { userId: "qa-editor", password }), viewer.request("/api/team/auth/login", "POST", { userId: "qa-viewer", password })]);
  check((await owner.request("/api/team/session")).data.workspace.id === createdWorkspaceId, "Restart reopens the same team workspace.");
  check((await editor.request(skillPath)).data.skill.revision === winner.revision, "Shared skill content survives restart.");
  const saved = (await viewer.request("/api/console/saved")).data.sessions;
  check(saved.some(session => session.id === firstId) && saved.some(session => session.id === secondId), "Both actors' conversations survive restart in shared history.");
  check(!(await owner.request("/api/dashboard")).data.scans.some(scan => scan.id === seedId), "Restart preserves personal/team evidence isolation.");
  await readKey("/api/v1/findings", 401);
  console.log(`Team workspace API smoke: ${checks} checks passed; 3 independent account sessions; concurrent chats, SSE, skill CAS and restart verified; 0 LLM turns.`);
} catch (cause) {
  console.error(`Team workspace API smoke failed: ${cause instanceof Error ? cause.message : "unknown failure"}`);
  process.exitCode = 1;
} finally {
  for (const stream of streams) stream.close();
  await stop();
  // Cleanup only this run's generated config, UUID-owned team directory, and temp workspace.
  if (createdWorkspaceId && teamPaths) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (config.workspace.id === createdWorkspaceId) { await rm(configPath, { force: true }); await rm(teamPaths.stateDir, { recursive: true, force: true }); }
  }
  await rm(directory, { recursive: true, force: true });
}
