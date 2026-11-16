import { describe, expect, it } from "vitest";
import { accessSummary, connectAction, connectorHeadline, healthNote, validConnectorToken, type ConnectorRowDto } from "./connector-model";

const row = (over: Partial<ConnectorRowDto["status"]> = {}, methods: ConnectorRowDto["connector"]["methods"] = ["token"]): ConnectorRowDto => ({
  extension: "chat", builtin: false, enabled: true,
  connector: { service: "chat", title: "Chat", description: "", category: "Messaging", auth: methods[0]!, methods, env: ["CHAT_TOKEN"], hosts: ["chat.example.com"], read: ["channels"], write: [], health: { type: "none" }, connectLabel: "Connect" },
  status: { state: "not-connected", account: null, detail: "", health: "unknown", ...over },
});

describe("connector model", () => {
  it("one Connect button per state", () => {
    expect(connectAction(row())).toEqual({ kind: "token", label: "Connect" });
    expect(connectAction(row({ state: "connected" }))).toEqual({ kind: "token", label: "Replace token" });
    expect(connectAction(row({}, ["oauth-device"])).kind).toBe("sign-in");
    expect(connectAction(row({ state: "signing-in" })).kind).toBe("none");
    expect(connectAction(row({}, ["cli-login"])).kind).toBe("none");
  });
  it("headlines say who is connected or what is missing", () => {
    expect(connectorHeadline(row({ state: "connected", account: "ada", detail: "via token" }))).toBe("Connected as ada via token");
    expect(connectorHeadline(row())).toBe("Not connected");
    expect(connectorHeadline(row({ state: "needs-attention", detail: "Needs permissions: repo" }))).toBe("Needs permissions: repo");
  });
  it("shows the declared access and a rejected or unreachable service", () => {
    expect(accessSummary({ read: ["a", "b"], write: [] })).toEqual({ reads: "a, b", writes: "nothing" });
    expect(healthNote(row({ state: "connected", health: "rejected" }).status)).toMatch(/rejected/);
    expect(healthNote(row({ state: "connected", health: "ok" }).status)).toBeNull();
  });
  it("accepts only a single-token string", () => {
    expect(validConnectorToken(" abc ")).toBe(true);
    expect(validConnectorToken("a b")).toBe(false);
    expect(validConnectorToken("")).toBe(false);
  });
});
