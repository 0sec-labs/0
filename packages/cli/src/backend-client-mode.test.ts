import { describe, expect, it } from "vitest";
import { remoteBackendClientId } from "./backend-client-mode.js";
describe("explicit remote client routing", () => {
  it("recognizes only explicit remote workflow clients", () => {
    expect(remoteBackendClientId(["workflow", "list", "--engine", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["runs", "show", "run", "--engine=engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["mcp-server", "--automations", "--engine", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["workflow", "list", "--backend", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["runs", "show", "run", "--backend=engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["workflow", "run", "--session", "--backend=engine-one"])).toBeUndefined();
    expect(remoteBackendClientId(["mcp-server", "--workflows", "--backend", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["review", "/repo", "--engine", "engine-one"])).toBeUndefined();
  });
  it("routes session clients and explicit loopback attachment without treating values as flags", () => {
    expect(remoteBackendClientId(["sessions", "list", "--engine", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["sessions", "list", "--engine-url", "http://127.0.0.1:3000", "--engine-token-env", "TOKEN"])).toBe("attached-engine");
    expect(remoteBackendClientId(["workflow", "run", "--chat", "--engine=engine-one"])).toBeUndefined();
    expect(() => remoteBackendClientId(["workflow", "list", "--engine-url=http://example.com", "--engine-token-env=TOKEN"])).toThrow("loopback");
    expect(() => remoteBackendClientId(["runs", "list", "--engine-url=http://localhost:3000"])).toThrow("Select either");
    expect(() => remoteBackendClientId(["runs", "list", "--engine=one", "--engine-url=http://localhost:3000", "--engine-token-env=TOKEN"])).toThrow("Select either");
  });
  it("does not interpret positional targets or option values as a sandbox bypass", () => {
    expect(remoteBackendClientId(["workflow", "run", "--", "--engine", "engine-one"])).toBeUndefined();
    expect(remoteBackendClientId(["workflow", "run", "--target", "--engine=engine-one"])).toBeUndefined();
    expect(remoteBackendClientId(["mcp-server", "--tools", "--engine=engine-one"])).toBeUndefined();
    expect(() => remoteBackendClientId(["workflow", "list", "--engine", "local"])).toThrow("preserve configured local execution");
    expect(() => remoteBackendClientId(["workflow", "list", "--engine", "one", "--engine", "two"])).toThrow("exactly one");
  });
});
