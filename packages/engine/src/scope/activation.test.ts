import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopeEnforcementState, withScopeEnforcement } from "./activation.js";
import { ScopePolicy } from "./scope.js";
import { PathPolicy } from "./enforcement.js";
import { resolveScopedPath } from "../agent/tools/scope-path.js";
import { disable, emptyEnablement, enable, readEnablement, writeEnablement } from "../plugins/enablement.js";

let root: string;
let project: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "0-scope-activation-")));
  project = join(root, "project");
  home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(join(root, "outside.txt"), "outside");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("first-party scope activation", () => {
  it("is on by default: no scope allows, a defined scope enforces exclusions, strict approval enforces without one", () => {
    const policy = ScopePolicy.fromJson({ in_scope: ["*.example.com"], out_of_scope: ["excluded.example.com"] });
    const paths = new PathPolicy(["/api"]);
    const idle = getScopeEnforcementState(project, home);
    expect(idle.enabled).toBe(false);
    withScopeEnforcement(idle, () => {
      expect(resolveScopedPath(project, "../outside.txt")).toBe(join(root, "outside.txt"));
      // Credential/attribution boundaries use the pure matcher, not activation.
      expect(policy.match("https://excluded.example.com/outside").allowed).toBe(false);
    });

    const defined = getScopeEnforcementState(project, home, true);
    expect(defined.enabled).toBe(true);
    withScopeEnforcement(defined, () => {
      expect(policy.enforce("https://allowed.example.com/api").allowed).toBe(true);
      expect(policy.enforce("https://excluded.example.com/api").allowed).toBe(false);
      expect(paths.enforce("https://allowed.example.com/outside").allowed).toBe(false);
      expect(() => resolveScopedPath(project, "../outside.txt")).toThrow();
    });

    const approval = enable(emptyEnablement(project), "scope", { version: "1.1.0", capabilities: [], now: 1 });
    if (!approval.ok) throw new Error(approval.error);
    expect(writeEnablement(project, approval.record, home)).toBe(true);
    expect(getScopeEnforcementState(project, home).enabled).toBe(true);
  });

  it("fails closed when disabled while a scope is defined", () => {
    const policy = ScopePolicy.fromJson({ in_scope: ["*.example.com"] });
    expect(writeEnablement(project, disable(readEnablement(project, home), "scope"), home)).toBe(true);
    const off = getScopeEnforcementState(project, home, true);
    expect(off.denied).toBe(true);
    withScopeEnforcement(off, () => {
      expect(policy.enforce("https://allowed.example.com").allowed).toBe(false);
    });
    expect(getScopeEnforcementState(project, home).denied).toBe(false);
  });

  it("enablement of a built-in is global: one store, not one record per project", () => {
    const approval = enable(emptyEnablement(project), "scope", { version: "1.1.0", capabilities: [], now: 1 });
    if (!approval.ok) throw new Error(approval.error);
    expect(writeEnablement(project, approval.record, home)).toBe(true);
    expect(getScopeEnforcementState(project, home).enabled).toBe(true);
    expect(getScopeEnforcementState(root, home).enabled).toBe(true);
  });

  it("keeps approval changes from weakening authorization in the middle of an execution", async () => {
    const policy = ScopePolicy.fromJson({ in_scope: ["allowed.example.com"] });
    const admitted = getScopeEnforcementState(project, home, true);
    await withScopeEnforcement(admitted, async () => {
      writeEnablement(project, disable(readEnablement(project, home), "scope"), home);
      await Promise.resolve();
      expect(policy.enforce("https://foreign.example.com").allowed).toBe(false);
      expect(policy.enforce("https://allowed.example.com").allowed).toBe(true);
    });
    expect(getScopeEnforcementState(project, home, true).denied).toBe(true);
  });
});
