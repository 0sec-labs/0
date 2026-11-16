import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService } from "../index.js";
import { scopeDefinedFrom } from "../overview.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ext-scope-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("overview scopeDefined", () => {
  it("is false when nothing defines a scope", () => {
    expect(scopeDefinedFrom()).toBe(false);
    expect(scopeDefinedFrom({ projectFolder: tmp(), settingsScope: false, agentScopes: 0 })).toBe(false);
  });
  it("is true for a project scope file with rules, in either location", () => {
    const a = tmp(); writeFileSync(join(a, "scope.json"), JSON.stringify({ in_scope: ["app.example.com"] }));
    const b = tmp(); mkdirSync(join(b, ".0")); writeFileSync(join(b, ".0", "scope.json"), JSON.stringify({ out_of_scope: ["x.example.com"] }));
    expect(scopeDefinedFrom({ projectFolder: a })).toBe(true);
    expect(scopeDefinedFrom({ projectFolder: b })).toBe(true);
  });
  it("ignores an empty or malformed scope file", () => {
    const a = tmp(); writeFileSync(join(a, "scope.json"), JSON.stringify({ in_scope: [], out_of_scope: [] }));
    const b = tmp(); writeFileSync(join(b, "scope.json"), "{nope");
    expect(scopeDefinedFrom({ projectFolder: a })).toBe(false);
    expect(scopeDefinedFrom({ projectFolder: b })).toBe(false);
  });
  it("is true for a scope in settings or any Agent or automation scope", () => {
    expect(scopeDefinedFrom({ settingsScope: true })).toBe(true);
    expect(scopeDefinedFrom({ agentScopes: 1 })).toBe(true);
  });
  it("is part of the service overview, including the error case", () => {
    const svc = createExtensionService({ home: tmp() });
    expect(svc.overview().scopeDefined).toBe(false);
    expect(svc.overview(undefined, { agentScopes: 2 }).scopeDefined).toBe(true);
  });
});
