import { expect, test, vi } from "vitest";
import { chatResourceKey, parseChatResourceKey, backendRouteHref, chatHostScopeKey, boundChatHostSelection } from "../../../dashboard/src/console/chat-host.js";
test("equal conversation IDs on different hosts have distinct dock identities", () => {
  expect(chatResourceKey({ backendId: "mac", id: "same" })).not.toBe(chatResourceKey({ backendId: "server", id: "same" }));
  expect(parseChatResourceKey("mac~same", "local")).toEqual({ backendId: "mac", id: "same" });
  expect(parseChatResourceKey("same", "local")).toEqual({ backendId: "local", id: "same" });
});
test("host routes and identifiers reject ambiguous or external values", () => {
  expect(backendRouteHref("local", "/console/id")).toBe("/console/id");
  expect(backendRouteHref("server", "/console/id")).toBe("/b/server/console/id");
  expect(parseChatResourceKey("host~one~two", "local")).toBeUndefined();
  expect(() => backendRouteHref("server", "https://foreign.test")).toThrow();
  expect(() => backendRouteHref("server", "//foreign.test")).toThrow();
});

test("chat selectors never call the global host switch, including matching local hosts", () => {
  const globalSelect = vi.fn(), localSelect = vi.fn();
  const registry = { backendId: "local", backends: [], status: "connected", select: globalSelect, reconnect: vi.fn() };
  const local = boundChatHostSelection(registry, "local"); local.select("remote");
  expect(globalSelect).not.toHaveBeenCalled(); expect(local.backendId).toBe("local");
  const remote = boundChatHostSelection(registry, "remote", localSelect); remote.select("another");
  expect(localSelect).toHaveBeenCalledWith("another"); expect(globalSelect).not.toHaveBeenCalled(); expect(remote.backendId).toBe("remote");
});
test("host/account identities isolate transport and handshake cache lifetimes", () => {
  expect(chatHostScopeKey("mac", "work", "alice")).not.toBe(chatHostScopeKey("mac", "work", "bob"));
  expect(chatHostScopeKey("mac", "work", "alice")).not.toBe(chatHostScopeKey("server", "work", "alice"));
  expect(chatHostScopeKey("mac")).not.toBe(chatHostScopeKey("mac", "work", "alice"));
});
