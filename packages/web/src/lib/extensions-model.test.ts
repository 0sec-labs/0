import { describe, expect, it } from "vitest";
import { canUpdate, failureLine, importNote, isOn, promptView, shortRevision, sourceLine, sourceProblem, statusView, toggleIntent, type ExtensionRowDto, type InstallPromptDto } from "./extensions-model";

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
