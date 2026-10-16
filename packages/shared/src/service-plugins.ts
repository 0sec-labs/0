/** Built-in service plugin setup. Credentials belong to the operator store, never workflows. */
export interface ServicePluginField {
  key: string;
  label: string;
  type: "secret" | "url" | "text";
  required: boolean;
}
export interface ServicePluginDescriptor {
  id: string;
  name: string;
  description: string;
  category: string;
  docsUrl: string;
  fields: ServicePluginField[];
  credentialNote?: string;
}
const token: ServicePluginField = { key: "token", label: "API token", type: "secret", required: true };
export const SERVICE_PLUGIN_CATALOG: readonly ServicePluginDescriptor[] = [
  { id: "github", name: "GitHub", description: "Review repositories, security alerts and pull requests.", category: "Code", docsUrl: "https://github.com/github/github-mcp-server", fields: [{ ...token, label: "Personal access token" }] },
  { id: "elastic", name: "Elastic", description: "Search security alerts and telemetry.", category: "Security", docsUrl: "https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/mcp-server-api-keys", fields: [{ key: "url", label: "Kibana URL", type: "url", required: true }, { ...token, label: "Encoded API key" }], credentialNote: "Requires Elastic Agent Builder access." },
  { id: "semgrep", name: "Semgrep", description: "Investigate code, dependency and secret findings.", category: "Security", docsUrl: "https://semgrep.dev/docs/semgrep-appsec-platform/api", fields: [token, { key: "deploymentId", label: "Deployment ID", type: "text", required: true }] },
  { id: "snyk", name: "Snyk", description: "Review vulnerable projects and dependencies.", category: "Security", docsUrl: "https://docs.snyk.io/snyk-api", fields: [token, { key: "organizationId", label: "Organization ID", type: "text", required: true }, { key: "url", label: "API URL (optional)", type: "url", required: false }] },
  { id: "linear", name: "Linear", description: "Create and track remediation issues.", category: "Issues", docsUrl: "https://linear.app/developers/graphql", fields: [token] },
  { id: "jira", name: "Jira", description: "Turn security findings into assigned issues.", category: "Issues", docsUrl: "https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/", fields: [{ key: "url", label: "Jira Cloud URL", type: "url", required: true }, { key: "email", label: "Account email", type: "text", required: true }, token] },
  { id: "cloudflare", name: "Cloudflare", description: "Inspect zones, DNS and security configuration.", category: "Cloud", docsUrl: "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/", fields: [token] },
  { id: "slack", name: "Slack", description: "Read channels and share workflow summaries.", category: "Messaging", docsUrl: "https://docs.slack.dev/authentication/tokens/", fields: [{ ...token, label: "Bot or user token" }] },
  { id: "teams", name: "Microsoft Teams", description: "Read teams and share channel summaries.", category: "Messaging", docsUrl: "https://learn.microsoft.com/en-us/graph/auth/auth-concepts", fields: [{ ...token, label: "Microsoft Graph access token" }], credentialNote: "Delegated token with Teams access. Reconnect when it expires." },
];

export interface ServicePluginConnection {
  id: string;
  enabled: boolean;
  fields: Record<string, string>;
}
export interface ServicePluginItem extends ServicePluginDescriptor {
  configured: boolean;
  enabled: boolean;
  tools: { name: string; description: string }[];
  values: Record<string, string>;
  testedAt: string | null;
  error?: string;
}
export interface ServicePluginsResponse {
  items: ServicePluginItem[];
  executionProfile: "local" | "smolvm";
}
