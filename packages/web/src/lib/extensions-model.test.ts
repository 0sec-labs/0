import { describe, expect, it } from "vitest";
import { canUpdate, failureLine, importNote, isOn, promptView, rowControl, showBuiltInChip, shortRevision, sourceLine, sourceProblem, statusView, toggleIntent, type ExtensionRowDto, type InstallPromptDto } from "./extensions-model";

const row = (over: Partial<ExtensionRowDto> = {}): ExtensionRowDto => ({ name: "demo", builtin: false, kind: "git", version: "1.0.0", description: "", status: "disabled", enabled: false, revision: "a".repeat(40), sourceLabel: "acme/demo", canDo: [], skills: [], refusal: null, note: "", ...over });
const prompt = (over: Partial<InstallPromptDto> = {}): InstallPromptDto => ({ kind: "install", name: "demo", version: "1.0.0", description: "d", source: { type: "git", url: "u" }, revision: "b".repeat(40), pinned: true, repoAtCommit: `u @ ${"b".repeat(40)}`, licence: null, canDo: [], warnings: [], hiddenUnicode: [], files: [], diff: null, ...over });

describe("extensions view model", () => {
  it("shows repo@short-sha, built-in and local sources", () => {
    expect(sourceLine(row())).toBe("acme/demo@aaaaaaa");
    expect(sourceLine(row({ builtin: true, kind: "built-in", revision: null, sourceLabel: null }))).toBe("Built in");
    expect(sourceLine(row({ kind: "local", sourceLabel: "/tmp/x", revision: "local-0123456789abcdef" }))).toBe("/tmp/x (local folder) @ 0123456");
    expect(shortRevision(null)).toBe("");
  });
  it("maps status to a label, tone and reason", () => {
    expect(statusView(row({ status: "enabled", enabled: true }))).toMatchObject({ label: "On", tone: "success" });
    expect(statusView(row({ status: "needs-approval" }))).toMatchObject({ label: "Needs approval", tone: "warning" });
    expect(statusView(row({ status: "refused", enabled: true, refusal: { code: "tampered", reason: "folder differs" } }))).toMatchObject({ label: "Refused", tone: "danger", detail: "folder differs" });
    expect(statusView(row({ status: "unmigrated", note: "old format" }))).toMatchObject({ label: "Could not migrate", detail: "old format" });
  });
  it("decides what the toggle does", () => {
    expect(toggleIntent(row())).toBe("enable");
    expect(toggleIntent(row({ status: "enabled", enabled: true }))).toBe("disable");
    expect(toggleIntent(row({ status: "needs-approval" }))).toBe("review");
    expect(toggleIntent(row({ status: "unmigrated" }))).toBe("none");
    expect(toggleIntent(row({ builtin: true, kind: "built-in", status: "built-in", enabled: true }))).toBe("confirm-disable");
    expect(toggleIntent(row({ status: "refused", enabled: true }))).toBe("disable");
    expect(isOn(row({ status: "refused", enabled: true }))).toBe(false);
    expect(canUpdate(row({ builtin: true, kind: "built-in", revision: null }))).toBe(false);
  });
  it("summarises the import report in one line", () => {
    expect(importNote(null)).toBeNull();
    expect(importNote({ importedAt: "", migrated: [{ kind: "k", name: "a", detail: "" }], notMigrated: [{ kind: "k", name: "b", detail: "" }], notes: [] })).toBe("Imported 1 item from your earlier setup; 1 could not be migrated.");
  });
  it("builds the install prompt and the update diff", () => {
    const install = promptView(prompt({ canDo: ["runs commands: go.sh"] }));
    expect(install).toMatchObject({ title: "Install demo 1.0.0", confirmLabel: "Install", canDo: ["runs commands: go.sh"], diff: null });
    expect(promptView(prompt()).canDo[0]).toMatch(/text instructions/);
    const update = promptView(prompt({ kind: "update", hiddenUnicode: ["a.md"], diff: { fromRevision: "a".repeat(40), added: ["x"], removed: [], changed: [], capabilityDelta: { added: ["runs commands: x"], removed: [] }, patch: "+x" } }));
    expect(update.confirmLabel).toBe("Update"); expect(update.diff).toMatchObject({ from: "aaaaaaa", hasChanges: true, patch: "+x" }); expect(update.warnings[0]).toMatch(/Hidden characters/);
  });
  it("checks the typed source and words failures", () => {
    expect(sourceProblem("")).toMatch(/Enter/); expect(sourceProblem("git@github.com:o/r.git")).toMatch(/https/); expect(sourceProblem("owner/repo")).toBeNull();
    expect(failureLine("review_mismatch", "x")).toMatch(/Review it again/); expect(failureLine("bad_source", "Bad.")).toBe("Bad.");
  });
});

describe("MCP tool review on an enabled extension", () => {
  it("warns with the one-line reason when a tool changed, and stays On otherwise", () => {
    const review = { server: "docs", state: "needs-approval" as const, reason: "changed: echo; blocked until you approve them again" };
    expect(statusView(row({ status: "enabled", enabled: true, mcp: [review] }))).toEqual({ label: "Tools need approval", tone: "warning", detail: "MCP server docs: changed: echo; blocked until you approve them again" });
    expect(statusView(row({ status: "enabled", enabled: true, mcp: [{ ...review, state: "approved", reason: "" }] })).label).toBe("On");
  });
});

describe("Add MCP server input", () => {
  it("splits a command with quotes and sends a URL as a URL", async () => {
    const { mcpDraftInput, mcpDraftProblem, splitCommand } = await import("./extensions-model");
    expect(splitCommand(`npx -y "my pkg" 'a b'`)).toEqual(["npx", "-y", "my pkg", "a b"]);
    expect(mcpDraftInput("docs", "npx -y docs-mcp")).toEqual({ mcp: { name: "docs", command: "npx", args: ["-y", "docs-mcp"] } });
    expect(mcpDraftInput("docs", "https://example.com/mcp")).toEqual({ mcp: { name: "docs", url: "https://example.com/mcp" } });
    expect(mcpDraftProblem("Docs", "x")).toMatch(/lowercase/);
    expect(mcpDraftProblem("docs", "http://example.com")).toMatch(/https/);
    expect(mcpDraftProblem("docs", "npx x")).toBeNull();
  });
});

describe("rowControl", () => {
  it("shows no switch for github and for an enabled scope while a scope is defined", () => {
    expect(rowControl({ required: "always", enabled: true }, false)).toEqual({ kind: "label", text: "Built in" });
    expect(rowControl({ required: "always", enabled: false }, true)).toEqual({ kind: "label", text: "Built in" });
    expect(rowControl({ required: "scope-defined", enabled: true }, true)).toEqual({ kind: "label", text: "On" });
  });
  it("keeps the switch for scope when no scope is defined or it is already off, and for everything else", () => {
    expect(rowControl({ required: "scope-defined", enabled: true }, false)).toEqual({ kind: "switch" });
    expect(rowControl({ required: "scope-defined", enabled: false }, true)).toEqual({ kind: "switch" });
    expect(rowControl({ required: null, enabled: true }, true)).toEqual({ kind: "switch" });
    expect(rowControl({ enabled: true }, true)).toEqual({ kind: "switch" });
  });
  it("hides the Built in chip only when the control already says it", () => {
    expect(showBuiltInChip({ builtin: true }, { kind: "label", text: "Built in" })).toBe(false);
    expect(showBuiltInChip({ builtin: true }, { kind: "switch" })).toBe(true);
    expect(showBuiltInChip({ builtin: false }, { kind: "switch" })).toBe(false);
  });
});
