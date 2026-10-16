import { describe, expect, it } from "vitest";
import { remoteBackendClientId } from "./backend-client-mode.js";
describe("explicit remote client routing", () => {
  it("recognizes only explicit remote workflow clients", () => {
    expect(remoteBackendClientId(["workflow", "list", "--backend", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["runs", "show", "run", "--backend=engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["mcp-server", "--workflows", "--backend", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["review", "/repo", "--backend", "engine-one"])).toBeUndefined();
  });
  it("routes session clients and explicit loopback attachment without treating values as flags", () => {
    expect(remoteBackendClientId(["sessions", "list", "--backend", "engine-one"])).toBe("engine-one");
    expect(remoteBackendClientId(["sessions", "list", "--engine-url", "http://127.0.0.1:3000", "--engine-token-env", "TOKEN"])).toBe("attached-engine");
    expect(remoteBackendClientId(["workflow", "run", "--session", "--backend=engine-one"])).toBeUndefined();
    expect(() => remoteBackendClientId(["workflow", "list", "--engine-url=http://example.com", "--engine-token-env=TOKEN"])).toThrow("loopback");
    expect(() => remoteBackendClientId(["runs", "list", "--engine-url=http://localhost:3000"])).toThrow("Select either");
    expect(() => remoteBackendClientId(["runs", "list", "--backend=one", "--engine-url=http://localhost:3000", "--engine-token-env=TOKEN"])).toThrow("Select either");
  });
  it("does not interpret positional targets or option values as a sandbox bypass", () => {
    expect(remoteBackendClientId(["workflow", "run", "--", "--backend", "engine-one"])).toBeUndefined();
    expect(remoteBackendClientId(["workflow", "run", "--target", "--backend=engine-one"])).toBeUndefined();
    expect(remoteBackendClientId(["mcp-server", "--tools", "--backend=engine-one"])).toBeUndefined();
    expect(() => remoteBackendClientId(["workflow", "list", "--backend", "local"])).toThrow("preserve configured local execution");
    expect(() => remoteBackendClientId(["workflow", "list", "--backend", "one", "--backend", "two"])).toThrow("exactly one");
  });
});
