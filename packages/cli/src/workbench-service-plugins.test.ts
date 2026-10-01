import { describe, expect, it } from "vitest";
import { servicePluginSecretRedactor, validateGuestServicePluginConnections } from "./workbench-service-plugins.js";
const connection = { id: "github", enabled: true, fields: { token: "selected-token" } };
describe("private service grants for the workbench guest", () => {
  it("requires an existing network grant and allows no implicit account selection", () => {
    expect(validateGuestServicePluginConnections(undefined, false)).toEqual([]);
    expect(() => validateGuestServicePluginConnections([connection], false)).toThrow("network grant");
    expect(() => validateGuestServicePluginConnections([connection], "true")).toThrow("network grant");
    expect(validateGuestServicePluginConnections([connection], true)).toEqual([connection]);
  });
  it("rejects custom servers, extra credentials, duplicates and unconfigured accounts", () => {
    for (const grants of [[{ ...connection, id: "arbitrary-host" }], [{ ...connection, enabled: false }], [connection, connection], [{ ...connection, fields: {} }], [{ ...connection, fields: { token: "secret", command: "bash" } }]]) {
      expect(() => validateGuestServicePluginConnections(grants, true)).toThrow("Invalid guest");
    }
  });
  it("rejects URL credentials, query secrets and malformed fields", () => {
    for (const url of ["https://user:password@elastic.example", "https://elastic.example?token=x", "https://elastic.example/#secret", "file:///host-secrets", "http://public.example"]) {
      expect(() => validateGuestServicePluginConnections([{ id: "elastic", enabled: true, fields: { token: "key", url } }], true)).toThrow("URL");
    }
    expect(() => validateGuestServicePluginConnections([{ ...connection, fields: { token: "token\nInjected" } }], true)).toThrow("field");
  });
  it("redacts encoded secrets and derived Jira authorization from errors and snapshots", () => {
    const connections = [{ id: "jira", enabled: true, fields: { email: "operator@example.com", token: 'private/token"', url: "https://example.atlassian.net" } }];
    const redact = servicePluginSecretRedactor(connections);
    const encoded = Buffer.from('operator@example.com:private/token"').toString("base64");
    for (const value of ['private/token"', encodeURIComponent('private/token"'), JSON.stringify('private/token"').slice(1, -1), encoded]) {
      expect(redact(`Error: ${value}`)).toBe("Error: [redacted]");
    }
    expect(JSON.parse(redact(JSON.stringify({ messages: [{ content: 'private/token"' }] })))).toEqual({ messages: [{ content: "[redacted]" }] });
    expect(redact("https://example.atlassian.net")).toBe("https://example.atlassian.net");
  });
});
