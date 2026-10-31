import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMaxTurns } from "./agent-runner.js";

/**
 * Turn-budget resolution. The operator directive is UNLIMITED by default: an
 * agent stops when the work is done, not when a counter runs out. These tests
 * pin that default, the env override precedence (per-purpose, per-role, then
 * global), and the invalid-value fallback — so an operator who WANTS a bound
 * can still set one without the default ever re-appearing.
 */
describe("getMaxTurns defaults", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["ZERO_MAX_TURNS"];
    delete process.env["ZERO_MAX_TURNS_VERIFY"];
    delete process.env["ZERO_MAX_TURNS_AUDIT"];
    delete process.env["ZERO_MAX_TURNS_REVIEW"];
  });

  afterEach(() => {
    Object.assign(process.env, origEnv);
  });

  it("is unlimited for every role, depth, branch and purpose", () => {
    for (const role of ["audit", "review"] as const) {
      for (const depth of [undefined, "quick", "default", "deep"]) {
        for (const branch of ["native", "legacy"] as const) {
          for (const purpose of ["research", "verify"] as const) {
            expect(getMaxTurns(role, depth, branch, purpose)).toBe(1_000_000);
          }
        }
      }
    }
  });

  it("defaults to the same unlimited budget when purpose is omitted", () => {
    expect(getMaxTurns("review", "deep", "native")).toBe(
      getMaxTurns("review", "deep", "native", "research"),
    );
  });

  it("keeps the finite ceiling well-defined for budget arithmetic", () => {
    const budget = getMaxTurns("audit", "deep", "native");
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
  });
});

describe("getMaxTurns env overrides", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["ZERO_MAX_TURNS"];
    delete process.env["ZERO_MAX_TURNS_VERIFY"];
    delete process.env["ZERO_MAX_TURNS_AUDIT"];
    delete process.env["ZERO_MAX_TURNS_REVIEW"];
  });

  afterEach(() => {
    Object.assign(process.env, origEnv);
  });

  it("ZERO_MAX_TURNS overrides every role, depth, and branch", () => {
    process.env["ZERO_MAX_TURNS"] = "7";
    expect(getMaxTurns("audit", "deep", "native")).toBe(7);
    expect(getMaxTurns("review", "quick", "legacy")).toBe(7);
    expect(getMaxTurns("review", "default", "native", "verify")).toBe(7);
  });

  it("ZERO_MAX_TURNS_VERIFY scopes to verify runs only", () => {
    process.env["ZERO_MAX_TURNS_VERIFY"] = "33";
    expect(getMaxTurns("review", "deep", "native", "verify")).toBe(33);
    expect(getMaxTurns("review", "deep", "native", "research")).toBe(1_000_000);
  });

  it("ZERO_MAX_TURNS_AUDIT and _REVIEW scope to their role", () => {
    process.env["ZERO_MAX_TURNS_AUDIT"] = "11";
    process.env["ZERO_MAX_TURNS_REVIEW"] = "22";
    expect(getMaxTurns("audit", "deep", "native")).toBe(11);
    expect(getMaxTurns("review", "deep", "native")).toBe(22);
    // Verify has its own scope and is untouched by the role overrides.
    expect(getMaxTurns("audit", "deep", "native", "verify")).toBe(1_000_000);
  });

  it("the purpose override wins over the role and global ones", () => {
    process.env["ZERO_MAX_TURNS"] = "5";
    process.env["ZERO_MAX_TURNS_VERIFY"] = "50";
    process.env["ZERO_MAX_TURNS_REVIEW"] = "60";
    expect(getMaxTurns("review", "deep", "native", "verify")).toBe(50);
    expect(getMaxTurns("review", "deep", "native")).toBe(60);
    // Audit has no specific override set, so it falls through to the global.
    expect(getMaxTurns("audit", "deep", "native")).toBe(5);
  });

  it("ignores invalid values rather than clamping them", () => {
    // A typo'd sweep parameter must fall back to the unlimited default, not
    // pin the agent to a single turn.
    for (const bad of ["0", "-4", "abc", "", "  ", "3.5", "NaN"]) {
      process.env["ZERO_MAX_TURNS_VERIFY"] = bad;
      expect(getMaxTurns("review", "default", "native", "verify")).toBe(1_000_000);
    }
  });

  it("allows raising budgets well past the defaults for sweeps", () => {
    process.env["ZERO_MAX_TURNS_REVIEW"] = "400";
    expect(getMaxTurns("review", "deep", "native")).toBe(400);
  });
});
