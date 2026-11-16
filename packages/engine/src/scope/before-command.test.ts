import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateBeforeCommand, type BeforeCommandInput } from "../hooks/before-command.js";
import { runBeforeCommand } from "../agent/before-command.js";
import { disable, emptyEnablement, enablementFilePath, readEnablement, writeEnablement } from "../plugins/enablement.js";
import { getBuiltinPluginState } from "../plugins/builtin-state.js";
import { getScopeEnforcementState } from "./activation.js";
import { scopeBeforeCommandPolicy } from "./before-command.js";
import { ScopePolicy } from "./scope.js";

let root: string;
let project: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "0-scope-hook-")));
  project = join(root, "project");
  home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.spyOn(process, "cwd").mockReturnValue(project);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const scope = () => ScopePolicy.fromJson({ in_scope: ["*.example.com"], out_of_scope: ["admin.example.com"] });
const bash = (command: string, thread: BeforeCommandInput["thread"] = {}): BeforeCommandInput =>
  ({ kind: "bash", command, argv: command.split(" "), cwd: project, hosts: [], paths: [], thread });
const disableScope = () => {
  expect(writeEnablement(project, disable(readEnablement(project, home), "scope"), home)).toBe(true);
};

describe("scope as a built-in extension on beforeCommand", () => {
  it("allows everything when no scope is defined", async () => {
    expect((await runBeforeCommand(bash("curl https://anything.test/x"))).decision).toBe("allow");
  });

  it("enforces on a fresh HOME as soon as a scope is passed", async () => {
    const thread = { scope: scope() };
    expect((await runBeforeCommand(bash("curl https://app.example.com/x", thread))).decision).toBe("allow");
    const out = await runBeforeCommand(bash("curl https://evil.test/x", thread));
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("out-of-scope URL 'https://evil.test/x'");
    expect((await runBeforeCommand(bash("curl https://admin.example.com/", thread))).decision).toBe("deny");
  });

  it("denies http_audit path violations", async () => {
    const thread = { scope: scope(), pathPrefixes: ["/api"] };
    expect((await runBeforeCommand(bash("curl https://app.example.com/api/x", thread))).decision).toBe("allow");
    expect((await runBeforeCommand(bash("curl https://app.example.com/other", thread))).reason).toContain("out-of-path");
  });

  it("denies when a scope is defined but the extension is disabled, and allows when none is", async () => {
    disableScope();
    expect(getBuiltinPluginState("scope", project, home)?.enabled).toBe(false);
    expect((await runBeforeCommand(bash("echo hi", { scope: scope() }))).decision).toBe("deny");
    expect((await runBeforeCommand(bash("echo hi"))).decision).toBe("allow");
  });

  it("denies when the scope extension errors while a scope is defined", async () => {
    const broken = ScopePolicy.fromJson({ in_scope: ["example.com"] });
    vi.spyOn(broken, "match").mockImplementation(() => { throw new Error("matcher crashed"); });
    const out = await evaluateBeforeCommand(bash("curl https://example.com", { scope: broken }), [scopeBeforeCommandPolicy]);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("matcher crashed");
  });

  it("scope deny beats Ask before running commands", async () => {
    const out = await runBeforeCommand(bash("curl https://evil.test/", { scope: scope(), approvals: "ask" }));
    expect(out.decision).toBe("deny");
    expect(out.asks.map(item => item.policyId)).toContain("approvals");
  });

  it("Ask before running commands is the same hook: ask for effectful calls, never for reads", async () => {
    expect((await runBeforeCommand(bash("ls", { approvals: "ask" }))).decision).toBe("ask");
    expect((await runBeforeCommand({ ...bash("ls", { approvals: "ask" }), effectful: false })).decision).toBe("allow");
    expect((await runBeforeCommand(bash("ls", { approvals: "auto" }))).decision).toBe("allow");
  });

  it("asks for uncovered hosts only when an operator channel can approve, never for exclusions", async () => {
    const thread = { scope: scope(), canAskScope: true };
    expect((await runBeforeCommand(bash("curl https://new.test/", thread))).decision).toBe("ask");
    expect((await runBeforeCommand(bash("curl https://admin.example.com/", thread))).decision).toBe("deny");
  });

  it("checks hosts named by network tools", async () => {
    const input: BeforeCommandInput = { ...bash("http_request"), kind: "network", hosts: ["https://evil.test/a"], thread: { scope: scope() } };
    expect((await runBeforeCommand(input)).decision).toBe("deny");
  });

  it("Known gap: a host built from a variable inside the command is not visible to the text check", async () => {
    const out = await runBeforeCommand(bash('H=evil.test; curl $H/x', { scope: scope() }));
    expect(out.decision).toBe("allow");
  });
});

describe("scope enablement record migration", () => {
  const writeRaw = (value: unknown) => {
    const file = enablementFilePath(project, home);
    mkdirSync(join(home, ".0", "plugin-enablement"), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };

  it("fresh home: on by default, not strict", () => {
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: false });
    const state = getScopeEnforcementState(project, home);
    expect(state.enabled).toBe(false);
    expect(getScopeEnforcementState(project, home, true).enabled).toBe(true);
  });

  it("legacy record with scope enabled stays enabled and strict (even at an older version)", () => {
    writeRaw({ schema: 1, project, enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 5 } } });
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: true });
    expect(getScopeEnforcementState(project, home).enabled).toBe(true);
  });

  it("legacy record that never enabled scope gets the default without a block", () => {
    writeRaw({ schema: 1, project, enabled: {} });
    expect(getBuiltinPluginState("scope", project, home)).toMatchObject({ enabled: true, explicit: false });
    expect(getScopeEnforcementState(project, home).denied).toBe(false);
  });

  it("corrupt record keeps scope on", () => {
    writeRaw("{not json");
    expect(getBuiltinPluginState("scope", project, home)?.enabled).toBe(true);
  });

  it("a schema 2 record without scope is an explicit disable", () => {
    writeRaw({ schema: 2, project, enabled: {} });
    expect(getBuiltinPluginState("scope", project, home)?.enabled).toBe(false);
    expect(getScopeEnforcementState(project, home, true).denied).toBe(true);
    expect(emptyEnablement(project).schema).toBe(2);
  });
});
