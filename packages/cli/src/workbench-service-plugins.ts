import { SERVICE_PLUGIN_CATALOG, type ServicePluginConnection } from "@0/shared";

/** Only explicit builtin account grants can cross the private guest init channel. */
export function validateGuestServicePluginConnections(raw: unknown, networkGranted: unknown): ServicePluginConnection[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SERVICE_PLUGIN_CATALOG.length) throw new Error("Invalid guest service plugin grants");
  const ids = new Set<string>();
  const connections = raw.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid guest service plugin grant");
    const row = value as Record<string, unknown>;
    const plugin = SERVICE_PLUGIN_CATALOG.find(item => item.id === row.id);
    if (!plugin || ids.has(plugin.id) || row.enabled !== true || !row.fields || typeof row.fields !== "object" || Array.isArray(row.fields)) throw new Error("Invalid guest service plugin grant");
    ids.add(plugin.id);
    const fields = row.fields as Record<string, unknown>;
    if (Object.keys(fields).some(key => !plugin.fields.some(field => field.key === key))) throw new Error("Invalid guest service plugin field");
    const output: Record<string, string> = {};
    for (const field of plugin.fields) {
      const value = fields[field.key];
      if (value === undefined && !field.required) continue;
      if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid guest service plugin field");
      if (field.type === "url") {
        let url: URL;
        try { url = new URL(value); } catch { throw new Error("Invalid guest service plugin URL"); }
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Invalid guest service plugin URL");
      }
      output[field.key] = value;
    }
    return { id: plugin.id, enabled: true, fields: output };
  });
  if (connections.length && networkGranted !== true) throw new Error("Service plugins require the existing SmolVM network grant. Enable workbench networking before using connected plugins.");
  return connections;
}

/** Scrub private credentials before runtime output or snapshots leave the guest. */
export function servicePluginSecretRedactor(connections: ServicePluginConnection[]): (value: string) => string {
  const secrets = connections.flatMap(connection => {
    const plugin = SERVICE_PLUGIN_CATALOG.find(item => item.id === connection.id)!;
    const values = plugin.fields.filter(field => field.type === "secret").map(field => connection.fields[field.key]).filter((value): value is string => !!value);
    // Jira uses a Basic authorization value derived from email and API token.
    if (connection.id === "jira" && connection.fields.email && connection.fields.token) values.push(Buffer.from(`${connection.fields.email}:${connection.fields.token}`).toString("base64"));
    return values.flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  }).sort((a, b) => b.length - a.length);
  return value => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
}
