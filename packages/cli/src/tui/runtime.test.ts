import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "@0/shared";
import { getReleaseChannel, getRuntimeMetadata } from "./runtime.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("artifact release identity", () => {
  it("keeps source and locally bundled artifacts in development even with a version or production env", () => {
    expect(getReleaseChannel({})).toBe("dev");
    vi.stubGlobal("__ZERO_VERSION__", VERSION);
    expect(getReleaseChannel({ NODE_ENV: "production" })).toBe("dev");
    vi.stubGlobal("__ZERO_RELEASE_CHANNEL__", "dev");
    expect(getReleaseChannel({ NODE_ENV: "production" })).toBe("dev");
  });
  it("recognizes a release build and lets an explicit development launch override it", () => {
    vi.stubGlobal("__ZERO_RELEASE_CHANNEL__", "beta");
    expect(getReleaseChannel({})).toBe("beta");
    expect(getReleaseChannel({ ZERO_DEV_SOURCE_ROOT: "/private/workspace" })).toBe("dev");
    expect(getReleaseChannel({ NODE_ENV: "development" })).toBe("dev");
    expect(getReleaseChannel({ ZERO_DEV_SOURCE_ROOT: " " })).toBe("beta");
  });
  it("does not interpret an unknown marker as a released artifact", () => {
    vi.stubGlobal("__ZERO_RELEASE_CHANNEL__", "unknown");
    expect(getReleaseChannel({})).toBe("dev");
  });
  it("returns only bounded version and runtime fields without copying env or workspace data", () => {
    vi.stubEnv("ZERO_DEV_SOURCE_ROOT", "/private/workspace");
    vi.stubEnv("OPENAI_API_KEY", "private-secret");
    const data = getRuntimeMetadata();
    expect(data).toEqual({ cliVersion: VERSION, releaseChannel: "dev", engine: "Node.js", engineVersion: process.version, platform: process.platform, arch: process.arch });
    expect(JSON.stringify(data)).not.toContain("private");
  });
  it("reports the actual Bun runtime independently of the artifact channel", () => {
    vi.stubGlobal("Bun", {});
    expect(getRuntimeMetadata().engine).toBe("Bun");
    expect(getRuntimeMetadata().engineVersion).toBe(process.versions.bun ?? "unknown");
  });
});
