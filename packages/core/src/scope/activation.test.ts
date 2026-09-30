import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopeEnforcementState, withScopeEnforcement } from "./activation.js";
import { ScopePolicy } from "./scope.js";
import { PathPolicy } from "./enforcement.js";
import { resolveScopedPath } from "../agent/tools/scope-path.js";
import { disable, emptyEnablement, enable, writeEnablement } from "../plugins/enablement.js";

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
  it("requires explicit project approval, enforces exclusions while active, and deactivates cleanly", () => {
    const policy = ScopePolicy.fromJson({ in_scope: ["*.example.com"], out_of_scope: ["excluded.example.com"] });
    const paths = new PathPolicy(["/api"]);
    const off = getScopeEnforcementState(project, home);
    withScopeEnforcement(off, () => {
      expect(policy.enforce("https://excluded.example.com/outside").allowed).toBe(true);
      expect(paths.enforce("https://example.com/outside").allowed).toBe(true);
      expect(resolveScopedPath(project, "../outside.txt")).toBe(join(root, "outside.txt"));
      // Credential/attribution boundaries use the pure matcher, not activation.
      expect(policy.match("https://excluded.example.com/outside").allowed).toBe(false);
    });

    const approval = enable(emptyEnablement(project), "scope", { version: "1.0.0", capabilities: [], now: 1 });
    if (!approval.ok) throw new Error(approval.error);
    expect(writeEnablement(project, approval.record, home)).toBe(true);
    const on = getScopeEnforcementState(project, home);
    expect(on.enabled).toBe(true);
    withScopeEnforcement(on, () => {
      expect(policy.enforce("https://allowed.example.com/api").allowed).toBe(true);
      expect(policy.enforce("https://excluded.example.com/api").allowed).toBe(false);
      expect(paths.enforce("https://allowed.example.com/outside").allowed).toBe(false);
      expect(() => resolveScopedPath(project, "../outside.txt")).toThrow();
    });

    expect(writeEnablement(project, disable(approval.record, "scope"), home)).toBe(true);
    const deactivated = getScopeEnforcementState(project, home);
    expect(deactivated.enabled).toBe(false);
    withScopeEnforcement(deactivated, () => {
      expect(policy.enforce("https://excluded.example.com/api").allowed).toBe(true);
    });
  });

  it("does not activate another project or reuse stale first-party approval", () => {
    const approval = enable(emptyEnablement(project), "scope", { version: "0.0.1", capabilities: [], now: 1 });
    if (!approval.ok) throw new Error(approval.error);
    expect(writeEnablement(project, approval.record, home)).toBe(true);
    expect(getScopeEnforcementState(project, home).enabled).toBe(false);
    expect(getScopeEnforcementState(root, home).enabled).toBe(false);
  });

  it("keeps approval changes from weakening authorization in the middle of an execution", async () => {
    const approval = enable(emptyEnablement(project), "scope", { version: "1.0.0", capabilities: [], now: 1 });
    if (!approval.ok) throw new Error(approval.error);
    writeEnablement(project, approval.record, home);
    const policy = ScopePolicy.fromJson({ in_scope: ["allowed.example.com"] });
    const admitted = getScopeEnforcementState(project, home);
    await withScopeEnforcement(admitted, async () => {
      writeEnablement(project, disable(approval.record, "scope"), home);
      await Promise.resolve();
      expect(policy.enforce("https://foreign.example.com").allowed).toBe(false);
    });
    expect(getScopeEnforcementState(project, home).enabled).toBe(false);
  });
});
