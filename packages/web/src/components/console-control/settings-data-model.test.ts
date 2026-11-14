import { describe, expect, it } from "vitest";
import type { PanelFix } from "@/console/panel/views/fixes-model";
import { pullRequestRows, safePullRequestUrl } from "./settings-data-model";

const fix = (patch: Record<string, unknown>, updatedAt = "2026-11-13T00:00:00Z"): PanelFix => ({ fix: { id: "x", finding: { id: "f", title: "SQLi" }, eligible: true, applied: false, ...patch } as never, workflowId: "w", updatedAt, active: false });

describe("pull requests", () => {
  it("lists only published fixes, newest first", () => {
    const rows = pullRequestRows([fix({ id: "a", published: { prUrl: "https://github.com/a/b/pull/1", branch: "0/a" } }, "2026-11-01T00:00:00Z"), fix({ id: "b" }), fix({ id: "c", publication: { title: "Fix SQLi", baseBranch: "main" }, published: { prUrl: "https://github.com/a/b/pull/2", branch: "0/c" } })]);
    expect(rows.map(row => row.id)).toEqual(["c", "a"]);
    expect(rows[0]).toMatchObject({ title: "Fix SQLi", baseBranch: "main", branch: "0/c" });
  });
  it("only links web URLs", () => {
    expect(safePullRequestUrl("javascript:alert(1)")).toBeUndefined();
    expect(safePullRequestUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
  });
});
