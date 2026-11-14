import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEPRECATED_ENV, applyEnvAliases } from "./deprecated-env.js";

// Warn-once state is per process; use fresh module instances per test.
async function load() {
  vi.resetModules();
  return import("./deprecated-env.js");
}

describe("applyEnvAliases", () => {
  beforeEach(() => { vi.resetModules(); });

  it("copies an old name onto an unset replacement and warns once", async () => {
    const { applyEnvAliases } = await load();
    const env: NodeJS.ProcessEnv = { ZERO_WPSCAN_API_TOKEN: "secret-token" };
    const warn = vi.fn();
    applyEnvAliases(env, warn);
    applyEnvAliases(env, warn);
    expect(env["WPSCAN_API_TOKEN"]).toBe("secret-token");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[0] ZERO_WPSCAN_API_TOKEN is deprecated; use WPSCAN_API_TOKEN.");
    expect(warn.mock.calls[0]![0]).not.toContain("secret-token");
  });

  it("keeps the replacement and warns about conflicts without logging values", async () => {
    const { applyEnvAliases } = await load();
    const env: NodeJS.ProcessEnv = { ZERO_CHATGPT_AUTH_FILE: "/old/secret", ZERO_CODEX_AUTH_JSON_PATH: "/new/secret" };
    const warn = vi.fn();
    applyEnvAliases(env, warn);
    expect(env["ZERO_CODEX_AUTH_JSON_PATH"]).toBe("/new/secret");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/differ/);
    expect(warn.mock.calls[0]![0]).not.toMatch(/secret/);
  });

  it("is quiet with ZERO_NO_DEPRECATION_WARNINGS but still aliases", async () => {
    const { applyEnvAliases } = await load();
    const env: NodeJS.ProcessEnv = { ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_NO_DEPRECATION_WARNINGS: "1" };
    const warn = vi.fn();
    applyEnvAliases(env, warn);
    expect(env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"]).toBe("1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves unrelated variables untouched", async () => {
    const { applyEnvAliases } = await load();
    const env: NodeJS.ProcessEnv = { PATH: "/bin", ZERO_PROVIDER: "x", ZERO_SELECTED_PROVIDER: "y" };
    const before = { ...env };
    const warn = vi.fn();
    applyEnvAliases(env, warn);
    expect(env).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it("inverts flags for invert entries", async () => {
    vi.resetModules();
    const mod = await import("./deprecated-env.js");
    // The shipped table has no invert entry; exercise the mechanism through a temporary one.
    (mod.DEPRECATED_ENV as unknown as Array<unknown>).push({ old: "ZERO_TEST_OLD_OFF", replacement: "ZERO_TEST_ON", invert: true });
    try {
      const warn = vi.fn();
      const on: NodeJS.ProcessEnv = { ZERO_TEST_OLD_OFF: "yes" };
      mod.applyEnvAliases(on, warn);
      expect(on["ZERO_TEST_ON"]).toBe("0");
      const off: NodeJS.ProcessEnv = { ZERO_TEST_OLD_OFF: "0" };
      mod.applyEnvAliases(off, warn);
      expect(off["ZERO_TEST_ON"]).toBe("1");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      (mod.DEPRECATED_ENV as unknown as Array<unknown>).pop();
    }
  });

  it("lists only the approved aliases", () => {
    expect(DEPRECATED_ENV.map((e) => `${e.old}>${e.replacement}`)).toEqual([
      "ZERO_CHATGPT_AUTH_FILE>ZERO_CODEX_AUTH_JSON_PATH",
      "ZERO_WPSCAN_API_TOKEN>WPSCAN_API_TOKEN",
      "ZERO_SKIP_PROVIDER_BANNER>ZERO_SUPPRESS_PROVIDER_STARTUP_LOG",
    ]);
    expect(typeof applyEnvAliases).toBe("function");
  });
});
