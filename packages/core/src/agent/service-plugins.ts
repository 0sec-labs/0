/** Vendor integrations exposed through MCP, so existing MCP tool gates apply. */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpHost } from "./mcp-host.js";

export interface ServicePluginConnection {
  id: string;
  enabled: boolean;
  fields: Record<string, string>;
}

type Args = Record<string, unknown>;
type Schema = Record<string, z.ZodTypeAny>;
interface Action { name: string; description: string; schema: Schema; run: (args: Args) => Promise<unknown>; }
interface Adapter { probe: () => Promise<unknown>; actions: Action[]; }
const MAX_BYTES = 1_048_576;
const text = z.string().min(1).max(10_000);
const key = z.string().min(1).max(200).refine(v => v !== "." && v !== "..", "Invalid identifier");
const limit = z.number().int().min(1).max(100).default(25);
const enc = (value: unknown) => encodeURIComponent(String(value));

function required(c: ServicePluginConnection, name: string): string {
  const value = c.fields[name]?.trim();
  if (!value || /[\r\n]/.test(value)) throw new Error(`${c.id}: ${name} is required`);
  return value;
}
function endpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid HTTPS service URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Service URL requires HTTPS without credentials, query or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function redact(value: unknown, secrets: readonly string[], depth = 0): unknown {
  const clean = (s: string) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), s);
  if (typeof value === "string") return clean(value);
  if (depth > 32) return "[truncated]";
  if (Array.isArray(value)) return value.map(item => redact(item, secrets, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), redact(v, secrets, depth + 1)]));
  return value;
}

/** Bound reads, never forward credentials on redirects or expose server error bodies. */
function requester(c: ServicePluginConnection, base: string, authorization: string, extra: Record<string, string> = {}) {
  const secret = required(c, "token");
  return async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const url = new URL(`${base}${path}`);
    if (url.origin !== new URL(base).origin) throw new Error("Service request origin changed");
    let response: Response;
    try {
      response = await fetch(url, {
        method, headers: { Authorization: authorization, Accept: "application/json", ...extra,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new Error(`${c.id}: connection failed or timed out`); }
    if (!response.ok) {
      await response.body?.cancel();
      const reason = response.status === 401 ? "credentials expired or invalid; reconnect" :
        response.status === 403 ? "token lacks permission for this action" :
        response.status === 429 ? "rate limit reached; retry later" : `service returned HTTP ${response.status}`;
      throw new Error(`${c.id}: ${reason}`);
    }
    if (!response.body) return {};
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error(`${c.id}: response too large; narrow the query`); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const combined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder().decode(combined).split(secret).join("[redacted]").split(authorization).join("[redacted]");
    let data: any; try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`${c.id}: invalid JSON response`); }
    if (data.ok === false || data.success === false || data.data?.issueCreate?.success === false || (Array.isArray(data.errors) && data.errors.length)) {
      throw new Error(`${c.id}: service rejected the request; check permissions and inputs`);
    }
    return redact(data, [secret, authorization]);
  };
}

function adapter(c: ServicePluginConnection): Adapter {
  const token = required(c, "token");
  const actions: Action[] = [];
  const add = (name: string, description: string, schema: Schema, run: Action["run"]) => actions.push({ name, description, schema, run });
  switch (c.id) {
    case "github": {
      const req = requester(c, "https://api.github.com", `Bearer ${token}`, { "X-GitHub-Api-Version": "2022-11-28" });
      const repo = { owner: key, repository: key };
      add("list_repositories", "List repositories available to the authenticated account.", { limit }, a => req(`/user/repos?per_page=${a.limit}&sort=updated`));
      add("list_code_alerts", "List code scanning alerts for a repository. Requires security alerts read access.", { ...repo, limit }, a => req(`/repos/${enc(a.owner)}/${enc(a.repository)}/code-scanning/alerts?per_page=${a.limit}`));
      add("list_dependency_alerts", "List Dependabot alerts for a repository.", { ...repo, limit }, a => req(`/repos/${enc(a.owner)}/${enc(a.repository)}/dependabot/alerts?per_page=${a.limit}`));
      add("create_issue", "Create an issue containing a finding or remediation task.", { ...repo, title: text, body: text }, a => req(`/repos/${enc(a.owner)}/${enc(a.repository)}/issues`, "POST", { title: a.title, body: a.body }));
      add("create_pull_request", "Open a pull request from an existing branch; does not edit files or merge changes.", { ...repo, title: text, body: text, head: key, base: key }, a => req(`/repos/${enc(a.owner)}/${enc(a.repository)}/pulls`, "POST", { title: a.title, body: a.body, head: a.head, base: a.base }));
      return { probe: () => req("/user"), actions };
    }
    case "semgrep": {
      const req = requester(c, "https://semgrep.dev/api/v1", `Bearer ${token}`);
      const configuredDeployment = required(c, "deploymentId");
      let deployment = enc(configuredDeployment);
      add("list_projects", "List Semgrep projects in the connected deployment.", { limit }, a => req(`/deployments/${deployment}/projects?page_size=${a.limit}`));
      add("list_findings", "List up to 100 Semgrep findings in the connected deployment.", { issueType: z.enum(["sast", "sca", "ai_sast"]).default("sast") }, a => req(`/deployments/${deployment}/findings?page_size=100&issue_type=${a.issueType}`));
      return { probe: async () => {
        const data = await req("/deployments");
        const match = data.deployments?.find((d: { id: unknown; slug: string }) => String(d.id) === configuredDeployment || d.slug === configuredDeployment);
        if (!match?.slug) throw new Error("semgrep: token cannot access this deployment");
        deployment = enc(match.slug); return data;
      }, actions };
    }
    case "snyk": {
      const base = endpoint(c.fields.url?.trim() || "https://api.snyk.io");
      if (!["https://api.snyk.io", "https://api.eu.snyk.io", "https://api.au.snyk.io", "https://api.us.snyk.io"].includes(base)) throw new Error("Choose a supported Snyk API region");
      const req = requester(c, base, `token ${token}`);
      const org = enc(required(c, "organizationId")); const version = "version=2024-10-15";
      add("list_projects", "List Snyk projects for the connected organization.", { limit }, a => req(`/rest/orgs/${org}/projects?${version}&limit=${a.limit}`));
      add("list_issues", "List security issues for the connected Snyk organization.", { limit }, a => req(`/rest/orgs/${org}/issues?${version}&limit=${a.limit}`));
      return { probe: () => req(`/rest/orgs/${org}?${version}`), actions };
    }
    case "linear": {
      const req = requester(c, "https://api.linear.app", token);
      const gql = (query: string, variables = {}) => req("/graphql", "POST", { query, variables });
      add("list_teams", "List Linear teams to route remediation tasks.", { limit }, a => gql("query($first:Int!){teams(first:$first){nodes{id name key}}}", { first: a.limit }));
      add("list_issues", "List recent Linear issues.", { limit }, a => gql("query($first:Int!){issues(first:$first){nodes{id identifier title url state{name}}}}", { first: a.limit }));
      add("create_issue", "Create a Linear remediation issue in a selected team.", { teamId: key, title: text, description: text }, a => gql("mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier title url}}}", { input: { teamId: a.teamId, title: a.title, description: a.description } }));
      return { probe: () => gql("{viewer{id name}}"), actions };
    }
    case "jira": {
      const req = requester(c, endpoint(required(c, "url")), `Basic ${Buffer.from(`${required(c, "email")}:${token}`).toString("base64")}`);
      add("list_projects", "List Jira projects available to this account.", { limit }, a => req(`/rest/api/3/project/search?maxResults=${a.limit}`));
      add("search_issues", "Search Jira issues using JQL.", { jql: text, limit }, a => req("/rest/api/3/search/jql", "POST", { jql: a.jql, maxResults: a.limit, fields: ["summary", "status", "priority"] }));
      add("create_issue", "Create a Jira remediation issue. Supply a valid project key and issue type ID.", { projectKey: key, issueTypeId: key, summary: text, description: text }, a => req("/rest/api/3/issue", "POST", { fields: { project: { key: a.projectKey }, issuetype: { id: a.issueTypeId }, summary: a.summary, description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: a.description }] }] } } }));
      return { probe: () => req("/rest/api/3/myself"), actions };
    }
    case "cloudflare": {
      const req = requester(c, "https://api.cloudflare.com/client/v4", `Bearer ${token}`);
      add("list_zones", "List Cloudflare zones visible to the connected token.", { limit }, a => req(`/zones?per_page=${Math.min(Number(a.limit), 50)}`));
      add("list_rulesets", "Read WAF and other rulesets for a zone.", { zoneId: key }, a => req(`/zones/${enc(a.zoneId)}/rulesets`));
      add("list_dns_records", "Read DNS records for a zone.", { zoneId: key, limit }, a => req(`/zones/${enc(a.zoneId)}/dns_records?per_page=${a.limit}`));
      return { probe: async () => { const data = await req("/user/tokens/verify"); if (data.result?.status !== "active") throw new Error("cloudflare: token is not active"); return data; }, actions };
    }
    case "slack": {
      const req = requester(c, "https://slack.com/api", `Bearer ${token}`);
      add("list_channels", "List public channels available to the Slack token.", { limit }, a => req(`/conversations.list?limit=${a.limit}&exclude_archived=true&types=public_channel`));
      add("channel_history", "Read recent messages from a selected Slack channel.", { channel: key, limit }, a => req(`/conversations.history?channel=${enc(a.channel)}&limit=${a.limit}`));
      add("send_message", "Post a workflow summary or finding to a selected Slack channel.", { channel: key, text }, a => req("/chat.postMessage", "POST", { channel: a.channel, text: a.text, unfurl_links: false, unfurl_media: false }));
      return { probe: () => req("/auth.test", "POST", {}), actions };
    }
    case "teams": {
      const req = requester(c, "https://graph.microsoft.com/v1.0", `Bearer ${token}`);
      add("list_teams", "List joined Microsoft Teams. Requires delegated Team.ReadBasic.All.", {}, () => req("/me/joinedTeams"));
      add("list_channels", "List channels in a selected Microsoft team.", { teamId: key }, a => req(`/teams/${enc(a.teamId)}/channels`));
      add("send_message", "Send a plain text workflow summary to a Teams channel. Requires delegated ChannelMessage.Send.", { teamId: key, channelId: key, text }, a => req(`/teams/${enc(a.teamId)}/channels/${enc(a.channelId)}/messages`, "POST", { body: { contentType: "text", content: a.text } }));
      return { probe: () => req("/me?$select=id,displayName"), actions };
    }
    default: throw new Error("Unknown service plugin");
  }
}

async function register(host: McpHost, c: ServicePluginConnection, validate: boolean): Promise<void> {
  if (c.id === "elastic") {
    const base = endpoint(required(c, "url"));
    const url = base.endsWith("/api/agent_builder/mcp") ? base : `${base}/api/agent_builder/mcp`;
    await host.connectHttp({ id: "elastic", url, headers: { Authorization: `ApiKey ${required(c, "token")}`, "kbn-xsrf": "true" } });
    return;
  }
  const vendor = adapter(c);
  if (validate) await vendor.probe();
  const server = new McpServer({ name: `zero-${c.id}`, version: "1.0.0" });
  for (const action of vendor.actions) {
    server.registerTool(action.name, { description: action.description, inputSchema: action.schema }, async args => {
      try { return { content: [{ type: "text" as const, text: JSON.stringify(await action.run(args)) }] }; }
      catch (err) { return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : "Service request failed" }] }; }
    });
  }
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  try { await host.register(c.id, client); } catch (err) { await server.close(); throw err; }
}

/** Enabled configured adapters only. A failed vendor never prevents other plugins loading. */
export async function connectServicePlugins(connections: readonly ServicePluginConnection[], existingHost?: McpHost): Promise<McpHost | undefined> {
  const host = existingHost ?? new McpHost();
  const ids = new Set(host.serverIds());
  const pending: Promise<void>[] = [];
  for (const connection of connections) {
    if (!connection.enabled || ids.has(connection.id)) continue;
    ids.add(connection.id);
    pending.push(register(host, connection, true));
  }
  // Independent services connect concurrently; an unavailable account cannot
  // accumulate a timeout for every other enabled plugin during session startup.
  await Promise.allSettled(pending);
  if (host.serverIds().length) return host;
  await host.closeAll(); return undefined;
}

/** Read-only account check (or Elastic MCP handshake), then tool discovery. */
export async function testServicePluginConnection(connection: ServicePluginConnection): Promise<{ tools: { name: string; description: string }[] }> {
  const host = new McpHost();
  try {
    await register(host, connection, true);
    return { tools: host.registeredTools().map(tool => ({ name: tool.name, description: tool.description })) };
  } finally { await host.closeAll(); }
}
