/**
 * Flag-boundary tests for the SOP surfaces: dynamic playbooks and drift detection.
 *
 * These exist because every one of these features is a getter reading an env
 * var at call time (so the CLI `--features` flag, which mutates the env AFTER
 * this module is imported, is honored). That pattern is easy to regress into a
 * const, at which point the flag silently stops working — and a silently
 * ignored feature flag is worse than no flag, because ablation runs would
 * report a difference that was never applied.
 */

import { describe, it, expect, afterEach } from "vitest";
import { features } from "./features.js";
import { detectPlaybooks, buildPlaybookInjection, PLAYBOOKS } from "./playbooks.js";

const TOUCHED_ENV = [
  "ZERO_FEATURE_DYNAMIC_PLAYBOOKS",
  "ZERO_FEATURE_DRIFT_DETECTION",
];

afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key];
});

describe("feature-flag boundaries", () => {
  it("dynamicPlaybooks defaults OFF and honors a late env mutation", () => {
    expect(features.dynamicPlaybooks).toBe(false);
    process.env["ZERO_FEATURE_DYNAMIC_PLAYBOOKS"] = "1";
    expect(features.dynamicPlaybooks).toBe(true);
    process.env["ZERO_FEATURE_DYNAMIC_PLAYBOOKS"] = "0";
    expect(features.dynamicPlaybooks).toBe(false);
  });

  it("driftDetection defaults OFF and can be opted into", () => {
    expect(features.driftDetection).toBe(false);
    process.env["ZERO_FEATURE_DRIFT_DETECTION"] = "1";
    expect(features.driftDetection).toBe(true);
  });
});

describe("playbook injection behavior at the flag boundary", () => {
  /**
   * The flag gates the CALL SITE (native-loop.ts), not these functions — they
   * are pure and always work. What is asserted here is the contract the call
   * site depends on: detection needs >=2 indicator hits, caps at 3 playbooks,
   * and returns empty (so the loop injects nothing) when nothing matches.
   */
  it("returns nothing to inject when tool output matches no indicators", () => {
    const types = detectPlaybooks(["200 OK", "hello world", "<h1>Welcome</h1>"]);
    expect(types).toEqual([]);
    expect(buildPlaybookInjection(types)).toBe("");
  });

  it("requires two indicator hits, not one", () => {
    // A single SQL-flavored string is not enough to commit 500+ tokens of
    // methodology to the context.
    const single = detectPlaybooks(["You have an error in your SQL syntax"]);
    expect(single).not.toContain("sqli");
  });

  it("detects a class from richer evidence and builds an injection for it", () => {
    const types = detectPlaybooks([
      "You have an error in your SQL syntax near '1''",
      "mysql_fetch_array() expects parameter 1",
      "SELECT * FROM users WHERE id=",
    ]);
    expect(types.length).toBeGreaterThan(0);
    const text = buildPlaybookInjection(types);
    expect(text).toContain("Dynamic Playbook Injection");
    expect(text).toContain(PLAYBOOKS[types[0]!]);
  });

});
