import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DesktopPreferences } from "./preferences.js";

it("flushes the latest draft and preferences before reopening on a new sidecar origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "0-workspace-"));
  try {
    const path = join(directory, "workspace.json");
    const preferences = new DesktopPreferences(path);
    const writes = [
      preferences.set("0:drafts", { session: "unfinished" }),
      preferences.set("0:theme", "light"),
      preferences.set("0:drafts", { session: "final draft" }),
    ];
    await preferences.flush();
    await Promise.all(writes);
    const reopened = new DesktopPreferences(path).snapshot();
    expect(reopened["0:drafts"]).toEqual({ session: "final draft" });
    expect(reopened["0:theme"]).toBe("light");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
