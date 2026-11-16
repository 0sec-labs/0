import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService, BUILTIN_EXTENSIONS, unwrap } from "../index.js";
import { BUILTIN_PLUGINS } from "../../builtin.js";
import { disable, emptyEnablement, enablementFilePath, readEnablement, writeEnablement } from "../../enablement.js";
import { getBuiltinPluginState } from "../../builtin-state.js";
import { getScopeEnforcementState } from "../../../scope/activation.js";
import { cleanup, tmp } from "./fixtures.js";

const dirs: string[] = [];
const setup = () => { const home = tmp("home"); const project = tmp("proj"); dirs.push(home, project); return { home, project, svc: createExtensionService({ home }) }; };
afterEach(() => { cleanup(...dirs.splice(0)); });
const statePath = (home: string) => join(home, ".0", "extensions", "state.json");

describe("one store for built-in enablement", () => {
  it("has one registry: the plugin view is derived from the extension built-ins", () => {
    for (const p of BUILTIN_PLUGINS) expect(BUILTIN_EXTENSIONS.map(b => b.name)).toContain(p.id);
    expect(BUILTIN_PLUGINS.map(p => p.id)).toEqual(["scope"]);
  });

  it("disable('scope') through the extension installer really disables scope; enable turns it back on, strict", () => {
    const { home, project, svc } = setup();
    expect(getScopeEnforcementState(project, home, true).enabled).toBe(true);
    unwrap(svc.installer.disable("scope", { confirm: true }));
    expect(getBuiltinPluginState("scope", project, home)?.enabled).toBe(false);
    expect(getScopeEnforcementState(project, home, true).denied).toBe(true);
    expect(getScopeEnforcementState(project, home, false).denied).toBe(false);
    unwrap(svc.installer.enable("scope"));
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: true });
    expect(getScopeEnforcementState(project, home, false).enabled).toBe(true);
  });

  it("the `0 plugin` view writes the same store: disable there shows in the extension list", () => {
    const { home, project, svc } = setup();
    expect(writeEnablement(project, disable(readEnablement(project, home), "scope"), home)).toBe(true);
    expect(svc.list().rows.find(r => r.name === "scope")?.enabled).toBe(false);
    expect(JSON.parse(readFileSync(statePath(home), "utf8")).builtins.scope.enabled).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(enablementFilePath(project, home), "utf8")).enabled)).not.toContain("scope");
  });

  it("a hand-edited per-project record cannot switch scope off (it is only a migration source, once)", () => {
    const { home, project, svc } = setup();
    unwrap(svc.installer.enable("scope"));
    mkdirSync(join(home, ".0", "plugin-enablement"), { recursive: true });
    writeFileSync(enablementFilePath(project, home), JSON.stringify({ schema: 2, project, enabled: {} }));
    expect(getScopeEnforcementState(project, home, true).enabled).toBe(true);
  });

  it("migrates an old explicit enable once, then ignores the old files", () => {
    const { home, project } = setup();
    mkdirSync(join(home, ".0", "plugin-enablement"), { recursive: true });
    writeFileSync(enablementFilePath(project, home), JSON.stringify({ schema: 1, project, enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 5 } } }));
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: true });
    const state = JSON.parse(readFileSync(statePath(home), "utf8"));
    expect(state.builtins.scope).toMatchObject({ enabled: true, explicit: true }); expect(state.migrations.builtinEnablement).toBeTruthy();
    writeFileSync(enablementFilePath(project, home), JSON.stringify({ schema: 2, project, enabled: {} }));
    expect(getBuiltinPluginState("scope", project, home)?.enabled).toBe(true);
  });

  it("an old schema-2 record without scope migrates as a disable", () => {
    const { home, project } = setup();
    mkdirSync(join(home, ".0", "plugin-enablement"), { recursive: true });
    writeFileSync(enablementFilePath(project, home), JSON.stringify({ schema: 2, project, enabled: {} }));
    expect(getBuiltinPluginState("scope", project, home)?.enabled).toBe(false);
    expect(JSON.parse(readFileSync(statePath(home), "utf8")).builtins.scope.enabled).toBe(false);
  });

  it("missing and unparseable records mean default on", () => {
    const { home, project } = setup();
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: false });
    mkdirSync(join(home, ".0", "plugin-enablement"), { recursive: true });
    writeFileSync(enablementFilePath(project, home), "{not json");
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: false });
  });

  it("a parseable schema-2 record with a broken `enabled` field denies a defined scope with a clear message, and allows when none is defined", () => {
    const { home, project } = setup();
    mkdirSync(join(home, ".0", "plugin-enablement"), { recursive: true });
    for (const broken of ["garbage", null, 7, ["scope"]]) {
      writeFileSync(enablementFilePath(project, home), JSON.stringify({ schema: 2, project, enabled: broken }));
      const defined = getScopeEnforcementState(project, home, true);
      expect(defined.denied, JSON.stringify(broken)).toBe(true);
      expect(defined.message).toMatch(/corrupt/); expect(defined.message).toContain(enablementFilePath(project, home)); expect(defined.message).toContain("0 skills extensions enable scope");
      expect(getScopeEnforcementState(project, home, false).denied).toBe(false);
    }
  });

  it("state.json edited by hand is ignored: an unsealed built-in record means the default", () => {
    const { home, project, svc } = setup();
    unwrap(svc.installer.enable("scope"));
    const state = JSON.parse(readFileSync(statePath(home), "utf8"));
    state.builtins.scope = { enabled: false };
    writeFileSync(statePath(home), JSON.stringify(state));
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: false });
    expect(svc.list().rows.find(r => r.name === "scope")?.enabled).toBe(true);
  });

  it("emptyEnablement keeps the schema", () => { expect(emptyEnablement("/p").schema).toBe(2); });
});
