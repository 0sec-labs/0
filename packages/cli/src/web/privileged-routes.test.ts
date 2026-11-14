import { describe, expect, it } from "vitest";
import { isPrivilegedOperatorRoute, privilegedRouteDenial } from "./privileged-routes.js";

const browser = { engineRequest: false, teamEnabled: false };
describe("privileged operator routes", () => {
  it("classifies code-execution and credential-routing routes", () => {
    for (const [path, method] of [["mcp-servers", "POST"], ["mcp-servers/preview", "POST"], ["mcp-servers/custom-a", "PATCH"], ["mcp-servers/custom-a", "DELETE"], ["mcp-servers/custom-a/test", "POST"],
      ["plugins/install-github", "POST"], ["plugins/install-github/approve", "POST"], ["connections/order", "PUT"], ["connections/spread", "PUT"], ["connections/openrouter%3Adefault", "PATCH"], ["connections/openrouter%3Adefault/models", "PUT"]] as const)
      expect(isPrivilegedOperatorRoute(`/api/console/${path}`, method), `${method} ${path}`).toBe(true);
    for (const [path, method] of [["mcp-servers", "GET"], ["connections", "GET"], ["connections", "POST"], ["connections/openrouter%3Adefault/usage", "GET"], ["plugins", "GET"], ["plugins/install", "POST"]] as const)
      expect(isPrivilegedOperatorRoute(`/api/console/${path}`, method), `${method} ${path}`).toBe(false);
  });
  it("denies engine bearer callers and non-owners in team mode", () => {
    const url = "/api/console/mcp-servers";
    expect(privilegedRouteDenial(url, "POST", { engineRequest: true, teamEnabled: false })).toMatchObject({ status: 403, data: { code: "browser_only" } });
    expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true, role: "member" })).toMatchObject({ status: 403, data: { code: "owner_required" } });
    expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true })).toMatchObject({ status: 403 });
    expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true, role: "owner" })).toBeNull();
    expect(privilegedRouteDenial(url, "POST", browser)).toBeNull();
    expect(privilegedRouteDenial(url, "GET", { engineRequest: true, teamEnabled: false })).toBeNull();
  });
});
