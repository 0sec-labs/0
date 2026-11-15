import { describe, expect, it } from "vitest";
import { isPrivacyMessage, projectLabel, samePath } from "@/console/workspace-path";

describe("workspace path comparison", () => {
  it("treats trailing slashes and unicode composition as the same folder", () => {
    expect(samePath("/Users/a/Documents/", "/Users/a/Documents")).toBe(true);
    expect(samePath("/Users/a/Café", "/Users/a/Café")).toBe(true);
    expect(samePath("/Users/a/Documents", "/Users/a/Desktop")).toBe(false);
    expect(samePath("/", "/")).toBe(true);
    expect(samePath(undefined, "/x")).toBe(false);
  });
  it("does not wait for a typed string to equal the stored real path", () => {
    // The picker waits for the server's real path (returned by the PATCH), never for "~/Documents".
    expect(samePath("~/Documents", "/Users/a/Documents")).toBe(false);
    expect(samePath("/Users/a/Documents", "/Users/a/Documents")).toBe(true);
  });
});

describe("project label", () => {
  it("shows the folder name, and the familiar name for iCloud Drive locations", () => {
    expect(projectLabel("/Users/a/Documents")).toBe("Documents");
    expect(projectLabel("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Desktop")).toBe("Desktop");
    expect(projectLabel("/Users/a/Library/Mobile Documents/com~apple~CloudDocs")).toBe("iCloud Drive");
    expect(projectLabel("/Users/a/Library/Mobile Documents/com~apple~Pages")).toBe("Pages");
    expect(projectLabel("/Users/a/Café")).toBe("Café");
    expect(projectLabel("/work/0sec-labs/0")).toBe("0sec-labs/0");
  });
  it("recognises the macOS privacy wording that unlocks the settings button", () => {
    expect(isPrivacyMessage("macOS is blocking access to Documents. Allow Terminal under ...")).toBe(true);
    expect(isPrivacyMessage("That folder doesn't exist.")).toBe(false);
    expect(isPrivacyMessage(null)).toBe(false);
  });
});
