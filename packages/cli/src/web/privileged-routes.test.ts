import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_ALLOWED_API_MUTATIONS, ENGINE_ALLOWED_MUTATIONS, isBrowserOnlyRoute, isPrivilegedOperatorRoute, privilegedRouteDenial } from "./privileged-routes.js";

const browser = { engineRequest: false, teamEnabled: false };
const engine = { engineRequest: true, teamEnabled: false };

/** Every mutating /api/console route. `engine` = reachable with the engine bearer. `owner` = team-mode owner gate. */
const TABLE: Array<{ method: string; path: string; engine: boolean; owner?: boolean; why: string }> = [
  { method: "POST", path: "sessions", engine: true, why: "engine creates chat sessions" },
  { method: "POST", path: "sessions/s1/messages", engine: true, why: "session message" },
  { method: "PATCH", path: "sessions/s1/configuration", engine: true, why: "per-session runtime selection" },
  { method: "POST", path: "sessions/s1/decisions/d1", engine: true, why: "session approval decision" },
  { method: "DELETE", path: "sessions/s1", engine: true, why: "close session" },
  { method: "POST", path: "saved/s1/resume", engine: true, why: "resume saved chat" },
  { method: "DELETE", path: "saved/s1", engine: true, why: "delete saved chat" },
  { method: "POST", path: "remote-sessions", engine: true, why: "provider-session transport" },
  { method: "PATCH", path: "remote-sessions/s1/configuration", engine: true, why: "provider-session transport" },
  { method: "POST", path: "provider-relays", engine: true, why: "relay transport is engine-only" },
  { method: "POST", path: "workflows", engine: true, why: "session-scoped workflow launch" },
  { method: "POST", path: "workflows/w1/cancel", engine: true, why: "cancel job" },
  { method: "POST", path: "workflow-definitions/d1/run", engine: true, why: "run an existing operator-approved definition" },
  { method: "POST", path: "workflow-executions/e1/cancel", engine: true, why: "cancel execution" },
  { method: "POST", path: "project/directories", engine: true, why: "read-only directory listing" },
  // Browser-only: credentials and connections
  { method: "POST", path: "connections", engine: false, owner: true, why: "configure/connect rewrites provider credentials and base URLs" },
  { method: "PUT", path: "connections/order", engine: false, owner: true, why: "connection metadata" },
  { method: "PUT", path: "connections/spread", engine: false, owner: true, why: "connection metadata" },
  { method: "PATCH", path: "connections/openai%3Adefault", engine: false, owner: true, why: "label" },
  { method: "PUT", path: "connections/openai%3Adefault/models", engine: false, owner: true, why: "model gating" },
  { method: "POST", path: "providers/openai/device-auth", engine: false, owner: true, why: "starts credential flow" },
  { method: "DELETE", path: "providers/openai/device-auth", engine: false, owner: true, why: "cancels credential flow" },
  { method: "POST", path: "github/connect", engine: false, why: "GitHub credential" },
  { method: "POST", path: "github/device-auth", engine: false, why: "GitHub credential flow" },
  { method: "DELETE", path: "github/device-auth", engine: false, why: "GitHub credential flow" },
  { method: "POST", path: "service-plugins/slack/connect", engine: false, owner: true, why: "stores service credentials" },
  { method: "PATCH", path: "service-plugins/slack", engine: false, owner: true, why: "enables service plugin" },
  { method: "DELETE", path: "service-plugins/slack", engine: false, owner: true, why: "forgets credentials" },
  // Operator-global settings
  { method: "PATCH", path: "settings", engine: false, owner: true, why: "executionProfile, consent, privacy and update policy" },
  { method: "POST", path: "settings/reset", engine: false, owner: true, why: "resets operator settings" },
  // Code execution
  { method: "POST", path: "mcp-servers", engine: false, owner: true, why: "custom MCP runs a command" },
  { method: "POST", path: "mcp-servers/preview", engine: false, owner: true, why: "MCP" },
  { method: "PATCH", path: "mcp-servers/a", engine: false, owner: true, why: "MCP" },
  { method: "DELETE", path: "mcp-servers/a", engine: false, owner: true, why: "MCP" },
  { method: "POST", path: "mcp-servers/a/test", engine: false, owner: true, why: "spawns the server" },
  { method: "POST", path: "plugins/install-github", engine: false, owner: true, why: "installs code" },
  { method: "POST", path: "plugins/install-github/approve", engine: false, owner: true, why: "installs code" },
  { method: "POST", path: "plugins/install", engine: false, owner: true, why: "installs code" },
  { method: "POST", path: "plugins/enable", engine: false, owner: true, why: "enables code" },
  { method: "POST", path: "plugins/disable", engine: false, owner: true, why: "plugin state" },
  { method: "POST", path: "plugins/run", engine: false, owner: true, why: "runs plugin code" },
  { method: "POST", path: "self-edit/start", engine: false, why: "self-edit worktree (owner checked by the route)" },
  { method: "POST", path: "self-edit/stop", engine: false, why: "self-edit" },
  { method: "POST", path: "self-edit/gates", engine: false, why: "runs commands" },
  { method: "POST", path: "self-edit/apply", engine: false, why: "self-edit" },
  { method: "PUT", path: "instructions/global", engine: false, owner: true, why: "operator instructions enter every mission system prompt (prompt authority); an attached engine must not rewrite them" },
  { method: "PUT", path: "instructions/workspace", engine: false, owner: true, why: "operator instructions enter every mission system prompt (prompt authority); an attached engine must not rewrite them" },
  // Automations, Sentinels, fixes, project policy
  { method: "POST", path: "workflow-definitions", engine: false, why: "creates automation definitions" },
  { method: "PATCH", path: "workflow-definitions/d1", engine: false, why: "edits automation" },
  { method: "DELETE", path: "workflow-definitions/d1", engine: false, why: "deletes automation" },
  { method: "POST", path: "workflow-definitions/d1/rollback", engine: false, why: "changes automation" },
  { method: "POST", path: "workflow-triggers", engine: false, why: "schedules launch runs" },
  { method: "PATCH", path: "workflow-triggers/t1", engine: false, why: "schedules launch runs" },
  { method: "DELETE", path: "workflow-triggers/t1", engine: false, why: "schedules" },
  { method: "POST", path: "sentinels", engine: false, why: "Sentinel mutation" },
  { method: "PATCH", path: "sentinels/s1", engine: false, why: "Sentinel mutation" },
  { method: "DELETE", path: "sentinels/s1", engine: false, why: "Sentinel mutation" },
  { method: "POST", path: "sentinels/s1/run", engine: false, why: "launches a run" },
  { method: "POST", path: "sentinels/s1/resume", engine: false, why: "Sentinel mutation" },
  { method: "POST", path: "sentinels/s1/triggers", engine: false, why: "Sentinel triggers launch runs" },
  { method: "PUT", path: "sentinels/s1/files/notes.md", engine: false, why: "Sentinel instructions" },
  { method: "POST", path: "fixes/prepare", engine: false, why: "source fix" },
  { method: "POST", path: "fixes/apply", engine: false, why: "modifies source" },
  { method: "POST", path: "fixes/publish", engine: false, why: "publishes" },
  { method: "POST", path: "checks", engine: false, why: "project review check policy" },
  { method: "POST", path: "project/choose-directory", engine: false, why: "native picker" },
  { method: "POST", path: "feedback", engine: false, why: "external submission" },
  { method: "POST", path: "learning/import", engine: false, why: "imports learning data" },
  { method: "POST", path: "some-future-route", engine: false, why: "unclassified mutating routes default to browser-only" },
];

describe("privileged operator routes", () => {
  it("classifies every mutating /api/console route (table-driven)", () => {
    for (const row of TABLE) {
      const url = `/api/console/${row.path}`;
      expect(isBrowserOnlyRoute(url, row.method), `${row.method} ${row.path}: ${row.why}`).toBe(!row.engine);
      expect(isPrivilegedOperatorRoute(url, row.method), `owner ${row.method} ${row.path}`).toBe(row.owner === true);
      expect(privilegedRouteDenial(url, row.method, engine)?.data.code ?? null, `engine ${row.method} ${row.path}`).toBe(row.engine && !row.owner ? null : "browser_only");
      expect(privilegedRouteDenial(url, row.method, browser), `browser ${row.method} ${row.path}`).toBeNull();
    }
  });
  it("lets the engine bearer read everything and nothing else is silently allowed", () => {
    for (const path of ["connections", "settings", "mcp-servers", "sentinels", "workflow-definitions", "plugins"]) expect(privilegedRouteDenial(`/api/console/${path}`, "GET", engine)).toBeNull();
    // Every allowlist entry is exercised by the table and carries a justification.
    for (const entry of ENGINE_ALLOWED_MUTATIONS) {
      expect(entry.why.length).toBeGreaterThan(10);
      expect(TABLE.some(row => row.engine && row.method !== "GET" && entry.methods.includes(row.method) && entry.pattern.test(row.path)), String(entry.pattern)).toBe(true);
    }
  });
  it("fails when a handler adds a top-level mutating route segment that is not classified", () => {
    const known = new Set(TABLE.map(row => row.path.split("/")[0]!));
    const sources = ["dashboard-api.ts", "workflows.ts", "workflow-triggers.ts", "sentinels.ts", "operator-services.ts", "custom-mcp.ts", "github-plugin-install.ts", "connection-meta.ts", "service-plugins.ts", "self-edit-routes.ts", "learning.ts"];
    const found = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      for (const match of text.matchAll(/(?:PREFIX \+ "|"\/api\/console\/|\bpath === "|\bpath\.startsWith\("|route === ")([a-z][a-z-]+)/g)) found.add(match[1]!);
      for (const match of text.matchAll(/\/\^\(?((?:[a-z]+-?[a-z]*)(?:\|[a-z-]+)*)/g)) for (const name of match[1]!.split("|")) if (/^[a-z-]{4,}$/.test(name)) found.add(name);
    }
    const READ_ONLY_OR_SUBROUTE = new Set(["search", "execution", "github", "providers", "models", "doctor", "tools", "workflow-tool-catalog", "sentinel-presets", "saved", "start", "stop", "diff", "gates", "apply", "status", "preset", "learning"]);
    const unclassified = [...found].filter(name => !known.has(name) && !READ_ONLY_OR_SUBROUTE.has(name) && ["sessions", "saved", "settings"].indexOf(name) < 0);
    // Heuristic guard: new top-level segments must be added to TABLE (or listed as read-only above) deliberately.
    expect(unclassified.filter(name => /^(?:workflow|sentinel|plugin|connection|mcp|fix|check|project|feedback|learning|self|service|remote|provider|setting|session)/.test(name))).toEqual([]);
  });
  it("denies engine bearer callers and non-owners in team mode", () => {
    const url = "/api/console/mcp-servers";
    expect(privilegedRouteDenial(url, "POST", engine)).toMatchObject({ status: 403, data: { code: "browser_only" } });
    expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true, role: "member" })).toMatchObject({ status: 403, data: { code: "owner_required" } });
    expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true })).toMatchObject({ status: 403 });
    expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true, role: "owner" })).toBeNull();
    expect(privilegedRouteDenial(url, "POST", browser)).toBeNull();
    expect(privilegedRouteDenial(url, "GET", engine)).toBeNull();
    // Team members keep non-privileged mutations (sessions, workflows) without owner role.
    expect(privilegedRouteDenial("/api/console/sessions/s1/messages", "POST", { engineRequest: false, teamEnabled: true, role: "editor" })).toBeNull();
  });
});

/** Every mutating route outside /api/console. `engine` = reachable with the engine bearer. */
const API_TABLE: Array<{ method: string; path: string; engine: boolean; why: string }> = [
  { method: "POST", path: "/api/workflow-engine/call", engine: true, why: "remote workflow runtime / MCP engine operations" },
  { method: "POST", path: "/api/control/launch-run", engine: true, why: "equivalent to session create + start_assessment" },
  { method: "POST", path: "/api/scans/s1/resume", engine: true, why: "equivalent to resume_scan" },
  { method: "POST", path: "/api/finding-family/fp1/triage", engine: true, why: "remote artifacts triage" },
  { method: "POST", path: "/api/finding-family/fp1/workflow", engine: true, why: "remote artifacts workflow state" },
  { method: "POST", path: "/api/findings/f1/impact-assessment", engine: true, why: "remote artifacts impact note" },
  { method: "DELETE", path: "/api/findings/f1/impact-assessment", engine: true, why: "remote artifacts impact note" },
  { method: "POST", path: "/api/control/reset-database", engine: false, why: "wipes the database" },
  { method: "POST", path: "/api/control/recover-stale-workers", engine: false, why: "process control" },
  { method: "POST", path: "/api/control/prune-stopped-workers", engine: false, why: "deletes worker rows" },
  { method: "POST", path: "/api/control/start-daemon", engine: false, why: "spawns a process" },
  { method: "POST", path: "/api/control/stop-daemon", engine: false, why: "kills processes" },
  { method: "POST", path: "/api/control/repair-worker", engine: false, why: "ssh reconnect/redeploy" },
  { method: "POST", path: "/api/workers/deploy", engine: false, why: "ssh/lima deployment executes remote commands" },
  { method: "POST", path: "/api/workers/b1/stop", engine: false, why: "stops a managed worker" },
  { method: "POST", path: "/api/skills", engine: false, why: "writes skills" },
  { method: "POST", path: "/api/skills/import", engine: false, why: "imports skills" },
  { method: "POST", path: "/api/skills/mounts", engine: false, why: "mounts host folders" },
  { method: "DELETE", path: "/api/skills/mounts/m1", engine: false, why: "unmounts" },
  { method: "POST", path: "/api/skills/k1/copy", engine: false, why: "writes skills" },
  { method: "PUT", path: "/api/skills/k1", engine: false, why: "writes skills" },
  { method: "POST", path: "/api/engagements", engine: false, why: "engagement records" },
  { method: "PATCH", path: "/api/engagements/e1", engine: false, why: "engagement records" },
  { method: "POST", path: "/api/findings-access", engine: false, why: "mints findings API keys" },
  { method: "DELETE", path: "/api/findings-access/00000000-0000-0000-0000-000000000000", engine: false, why: "revokes keys" },
  { method: "DELETE", path: "/api/backends/b1", engine: false, why: "removes a registration" },
  { method: "POST", path: "/api/backends", engine: false, why: "registry" },
  { method: "POST", path: "/api/backends/local/proxy/api/console/mcp-servers", engine: false, why: "local proxy re-enters routes after the gate" },
  { method: "GET", path: "/api/backends/b1/proxy/api/console/sessions", engine: false, why: "would borrow the stored credential of another backend" },
  { method: "POST", path: "/api/team/setup", engine: false, why: "creates the workspace owner" },
  { method: "POST", path: "/api/team/users", engine: false, why: "adds members" },
  { method: "POST", path: "/api/team/auth/login", engine: false, why: "session issuance" },
  { method: "POST", path: "/api/team/auth/logout", engine: false, why: "session" },
  { method: "POST", path: "/api/team/rooms/report/e1/presence", engine: false, why: "presence" },
  { method: "POST", path: "/api/team/conversations/c1/title", engine: false, why: "team state" },
  { method: "POST", path: "/api/some-future-route", engine: false, why: "unclassified mutating routes default to browser-only" },
];
const READS = ["/api/dashboard", "/api/scans", "/api/scans/s1", "/api/scans/s1/export", "/api/findings/export", "/api/events/recent", "/api/v1/presentation/events", "/api/work", "/api/work/w1", "/api/backends", "/api/backend/handshake", "/api/backends/b1/handshake", "/api/skills", "/api/engagements", "/api/workers/hosts", "/api/workers/managed", "/api/team/session", "/api/team/users", "/api/team/setup", "/api/team/presence", "/api/team/events", "/api/findings-access"];

describe("engine bearer on routes outside /api/console", () => {
  it("is default-deny for every mutating /api route except the justified allowlist", () => {
    for (const row of API_TABLE) {
      expect(isBrowserOnlyRoute(row.path, row.method), `${row.method} ${row.path}: ${row.why}`).toBe(!row.engine);
      expect(privilegedRouteDenial(row.path, row.method, engine)?.data.code ?? null, `engine ${row.method} ${row.path}`).toBe(row.engine ? null : "browser_only");
      expect(privilegedRouteDenial(row.path, row.method, engine)?.status ?? 200, `status ${row.path}`).toBe(row.engine ? 200 : 403);
    }
    for (const entry of ENGINE_ALLOWED_API_MUTATIONS) {
      expect(entry.why.length).toBeGreaterThan(10);
      expect(API_TABLE.some(row => row.engine && entry.methods.includes(row.method) && entry.pattern.test(row.path)), String(entry.pattern)).toBe(true);
    }
  });
  it("keeps reads open to the engine bearer and non-API paths untouched", () => {
    for (const path of READS) expect(privilegedRouteDenial(path, "GET", engine), path).toBeNull();
    expect(privilegedRouteDenial("/assets/app.js", "POST", engine)).toBeNull();
  });
  it("lets browser callers through the engine gate", () => {
    for (const row of API_TABLE) expect(privilegedRouteDenial(row.path, row.method, browser), `${row.method} ${row.path}`).toBeNull();
  });
  it("fails when a handler exposes a top-level /api segment that is not classified", () => {
    const classified = new Set(["console", "dashboard", "scans", "findings", "finding-family", "events", "v1", "work", "workflow-engine", "control", "workers", "skills", "engagements", "findings-access", "backends", "backend", "team"]);
    const files = ["../commands/dashboard.ts", "dashboard-api.ts", "team-web.ts", "team-setup.ts", "team-presence-stream.ts", "backend-connections.ts", "findings-access-tokens.ts", "finding-impact.ts", "browser-live-routes.ts"];
    const found = new Set<string>();
    for (const file of files) {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      for (const match of text.matchAll(/\/api\/([a-z][a-z0-9-]*)/g)) found.add(match[1]!);
    }
    expect([...found].filter(name => !classified.has(name))).toEqual([]);
    // Every classified mutating family has at least one row in the table (or is read-only).
    const READ_ONLY = new Set(["dashboard", "events", "v1", "work", "backend", "console"]);
    for (const name of classified) if (!READ_ONLY.has(name)) expect(API_TABLE.some(row => row.path.startsWith(`/api/${name}`)) || READS.some(path => path.startsWith(`/api/${name}`)), name).toBe(true);
  });
});
