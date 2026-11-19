import { describe, expect, it } from "vitest";
import { buildItems, firstSentence, plainAccess, versionLines } from "./extensions-list";
import type { ExtensionRowDto } from "./extensions-model";

const row = (over: Partial<ExtensionRowDto>): ExtensionRowDto => ({ name: "x", builtin: false, kind: "git", version: "1.0.0", description: "", status: "enabled", enabled: true, revision: "abcdef1234567", sourceLabel: "o/r", canDo: [], skills: [], refusal: null, note: "", ...over });
const github = { available: true, connected: false, account: null, scopes: [], missingScopes: [], refreshCommand: null, source: null, expiresAt: null, computer: "Mac", deviceAuth: { phase: "idle" as const, message: "" } };

describe("extensions list", () => {
  it("cuts a description to its first sentence", () => {
    expect(firstSentence("GitHub connection used by Sentinels. Built in: it cannot be removed.")).toBe("GitHub connection used by Sentinels.");
  });
  it("asks to connect GitHub when it is not connected, and not once it is", () => {
    const gh = row({ name: "github", builtin: true, status: "built-in", description: "Reviews pull requests." });
    expect(buildItems([gh], [], github)[0]!.status).toMatchObject({ label: "Not connected", action: "connect" });
    expect(buildItems([gh], [], { ...github, connected: true, account: "peak" })[0]!.status).toMatchObject({ label: "Connected", action: null });
  });
  it("calls other built-ins Built in and installed ones On or Off", () => {
    expect(buildItems([row({ builtin: true, status: "built-in" })], [], undefined)[0]!.status.label).toBe("Built-in");
    expect(buildItems([row({ enabled: false, status: "disabled" })], [], undefined)[0]!.status.label).toBe("Off");
  });
  it("leaves auth method names and hosts out of the access list", () => {
    const item = { connector: null, row: row({ canDo: ["connects to GitHub (cli-login / token; github.com)", "adds skills (text instructions): pr-diff-review"] }) };
    expect(plainAccess(item)).toEqual(["Adds skills: pr-diff-review"]);
  });
  it("shows the pinned commit only for installed extensions", () => {
    expect(versionLines(row({}))).toEqual([{ label: "Version", value: "1.0.0" }, { label: "Pinned to", value: "abcdef1" }]);
    expect(versionLines(row({ builtin: true }))).toContainEqual({ label: "Updates", value: "With 0" });
  });
});
