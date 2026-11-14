import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_COMPLETION_TOKEN_LIMIT,
  NATIVE_COMPLETION_TOKEN_LIMIT,
  completionTokenLimit,
  resetCompletionTokenLimitWarnings,
} from "./usage-parsing.js";

describe("completionTokenLimit", () => {
  let write: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { resetCompletionTokenLimitWarnings(); write = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
  afterEach(() => write.mockRestore());

  it("defaults when unset or blank without warning", () => {
    expect(completionTokenLimit({})).toBe(NATIVE_COMPLETION_TOKEN_LIMIT);
    expect(completionTokenLimit({ ZERO_MAX_COMPLETION_TOKENS: "  " })).toBe(NATIVE_COMPLETION_TOKEN_LIMIT);
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts positive integers, including surrounding whitespace", () => {
    expect(completionTokenLimit({ ZERO_MAX_COMPLETION_TOKENS: "500" })).toBe(500);
    expect(completionTokenLimit({ ZERO_MAX_COMPLETION_TOKENS: " 16000 " })).toBe(16000);
  });

  it.each(["0", "-5", "abc", "1.5", "1e3", "0x10", "9007199254740993999"])("falls back on invalid %s and warns once without echoing it", (raw) => {
    expect(completionTokenLimit({ ZERO_MAX_COMPLETION_TOKENS: raw })).toBe(NATIVE_COMPLETION_TOKEN_LIMIT);
    completionTokenLimit({ ZERO_MAX_COMPLETION_TOKENS: raw });
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![0])).not.toContain(raw);
  });

  it("clamps to the global ceiling and to a known model maximum", () => {
    expect(completionTokenLimit({ ZERO_MAX_COMPLETION_TOKENS: "99999999" })).toBe(MAX_COMPLETION_TOKEN_LIMIT);
    expect(completionTokenLimit({ ZERO_MAX_COMPLETION_TOKENS: "50000" }, 4096)).toBe(4096);
    expect(completionTokenLimit({}, 4096)).toBe(4096);
  });

  it("reads lazily from the supplied env and process.env per call", () => {
    const env: Record<string, string> = {};
    expect(completionTokenLimit(env)).toBe(NATIVE_COMPLETION_TOKEN_LIMIT);
    env["ZERO_MAX_COMPLETION_TOKENS"] = "700";
    expect(completionTokenLimit(env)).toBe(700);
    vi.stubEnv("ZERO_MAX_COMPLETION_TOKENS", "900");
    expect(completionTokenLimit()).toBe(900);
    vi.unstubAllEnvs();
  });
});
