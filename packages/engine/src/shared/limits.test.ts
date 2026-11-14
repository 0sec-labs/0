import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASH_TIMEOUT_MS, LLM_429_MAX_RETRIES, LLM_MAX_RETRIES, LLM_STREAM_MAX_ATTEMPTS, REVIEW_MAX_FILES,
  VERIFY_CONCURRENCY, configureLimits, defineLimit, resetLimitsForTests, resolveLimit,
} from "./limits.js";

afterEach(() => { resetLimitsForTests(); vi.restoreAllMocks(); });
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe("registered defaults are unchanged", () => {
  it.each([
    [BASH_TIMEOUT_MS, 120_000], [REVIEW_MAX_FILES, 5000], [VERIFY_CONCURRENCY, 8],
    [LLM_STREAM_MAX_ATTEMPTS, 3], [LLM_MAX_RETRIES, 6], [LLM_429_MAX_RETRIES, 12],
  ])("%j", (limit, value) => { expect(resolveLimit(limit, env({}))).toBe(value); });
});

describe("resolution", () => {
  it("env overrides setting overrides default", () => {
    configureLimits({ "verify.concurrency": 4 });
    expect(resolveLimit(VERIFY_CONCURRENCY, env({}))).toBe(4);
    expect(resolveLimit(VERIFY_CONCURRENCY, env({ ZERO_VERIFY_CONCURRENCY: "2" }))).toBe(2);
  });
  it("clamps above max and rejects below min", () => {
    expect(resolveLimit(LLM_STREAM_MAX_ATTEMPTS, env({ ZERO_LLM_STREAM_MAX_ATTEMPTS: "99" }))).toBe(5);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveLimit(LLM_STREAM_MAX_ATTEMPTS, env({ ZERO_LLM_STREAM_MAX_ATTEMPTS: "0" }))).toBe(3);
    expect(resolveLimit(BASH_TIMEOUT_MS, env({ ZERO_BASH_TIMEOUT_MS: "-5" }))).toBe(120_000);
  });
  it("accepts zero retries and floors fractions", () => {
    expect(resolveLimit(LLM_MAX_RETRIES, env({ ZERO_LLM_MAX_RETRIES: "0" }))).toBe(0);
    expect(resolveLimit(BASH_TIMEOUT_MS, env({ ZERO_BASH_TIMEOUT_MS: "1500.9" }))).toBe(1500);
  });
  it("429 retries fall back to the generic variable, specific wins", () => {
    expect(resolveLimit(LLM_429_MAX_RETRIES, env({ ZERO_LLM_MAX_RETRIES: "3" }))).toBe(3);
    expect(resolveLimit(LLM_429_MAX_RETRIES, env({ ZERO_LLM_MAX_RETRIES: "3", ZERO_LLM_429_MAX_RETRIES: "9" }))).toBe(9);
  });
  it("invalid env falls back once-noticed without printing the value", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    configureLimits({ "review.maxFiles": 77 });
    const bad = env({ ZERO_REVIEW_MAX_FILES: "secret-xyz" });
    expect(resolveLimit(REVIEW_MAX_FILES, bad)).toBe(77);
    expect(resolveLimit(REVIEW_MAX_FILES, bad)).toBe(77);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![0])).toContain("ZERO_REVIEW_MAX_FILES");
    expect(String(write.mock.calls[0]![0])).not.toContain("secret-xyz");
  });
  it("blank env is treated as unset without a notice", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveLimit(REVIEW_MAX_FILES, env({ ZERO_REVIEW_MAX_FILES: "  " }))).toBe(5000);
    expect(write).not.toHaveBeenCalled();
  });
  it("drops out-of-range or unknown settings", () => {
    configureLimits({ "verify.concurrency": 0, "nope": 5 });
    expect(resolveLimit(VERIFY_CONCURRENCY, env({}))).toBe(8);
    configureLimits({ "llm.streamMaxAttempts": 50 });
    expect(resolveLimit(LLM_STREAM_MAX_ATTEMPTS, env({}))).toBe(5);
  });
  it("validates definitions", () => {
    expect(() => defineLimit({ key: "t.bad", env: "X", default: 5, min: 10, max: 20 })).toThrow(RangeError);
    expect(() => defineLimit({ key: "verify.concurrency", env: "X", default: 8, min: 1, max: 9 })).toThrow(/already/);
  });
});
