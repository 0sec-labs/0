import { describe, expect, it } from "vitest";
import { extensionEnv, isProviderKeyName } from "../core/env.js";

const parent = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", GITHUB_TOKEN: "ghp", AWS_SECRET: "s", LD_PRELOAD: "/evil.so", NODE_OPTIONS: "--require x" };

describe("extension env allowlist", () => {
  it("starts from a scrubbed base and passes nothing undeclared", () => {
    expect(extensionEnv({ declared: [], approved: [], parent })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
  it("passes only names that are declared AND approved", () => {
    expect(extensionEnv({ declared: ["GITHUB_TOKEN"], approved: [], parent }).GITHUB_TOKEN).toBeUndefined();
    expect(extensionEnv({ declared: [], approved: ["GITHUB_TOKEN"], parent }).GITHUB_TOKEN).toBeUndefined();
    expect(extensionEnv({ declared: ["GITHUB_TOKEN"], approved: ["GITHUB_TOKEN"], parent }).GITHUB_TOKEN).toBe("ghp");
  });
  it("never passes provider keys unless declared and approved", () => {
    expect(extensionEnv({ declared: ["GITHUB_TOKEN"], approved: ["GITHUB_TOKEN"], parent }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(extensionEnv({ declared: ["OPENAI_API_KEY"], approved: ["OPENAI_API_KEY"], parent }).OPENAI_API_KEY).toBe("sk-o");
    expect(isProviderKeyName("ANTHROPIC_API_KEY") && isProviderKeyName("SOME_API_KEY") && !isProviderKeyName("GITHUB_TOKEN")).toBe(true);
  });
  it("never passes loader variables even when declared and approved", () => {
    const env = extensionEnv({ declared: ["LD_PRELOAD", "NODE_OPTIONS"], approved: ["LD_PRELOAD", "NODE_OPTIONS"], parent, extra: { LD_AUDIT: "x", ZERO_EXTENSION_NAME: "n" } });
    expect(env).not.toHaveProperty("LD_PRELOAD"); expect(env).not.toHaveProperty("NODE_OPTIONS"); expect(env).not.toHaveProperty("LD_AUDIT"); expect(env.ZERO_EXTENSION_NAME).toBe("n");
  });
});
