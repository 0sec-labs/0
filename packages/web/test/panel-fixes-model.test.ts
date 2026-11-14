import { expect, test } from "vitest";
import type { Workflow, WebFix } from "@/components/console-control/contracts";
import { fixBucket, fixDiffText, fixesFromWorkflows, fixStage, parseDiff, prLabel, safePrUrl } from "../src/console/panel/views/fixes-model";

const fix = (over: Partial<WebFix> = {}): WebFix => ({ id: "f1", sessionId: "s1", finding: { id: "x", title: "T" } as WebFix["finding"], repoRoot: "/r", baseCommit: "c", testCommand: "t", reviewToken: "r", eligible: true, applied: false, ...over });
const wf = (id: string, updatedAt: string, f: WebFix, over: Partial<Workflow> = {}) => ({ id, kind: "fix-propose", status: "completed", updatedAt, result: { fix: f }, ...over }) as Workflow;

test("fixesFromWorkflows filters by session and kind, dedupes by fix id with latest winning", () => {
  const list = fixesFromWorkflows([
    wf("a", "2026-01-01", fix()),
    wf("b", "2026-01-02", fix({ result: { diff: "d" } as never })),
    wf("c", "2026-01-03", fix({ id: "other", sessionId: "s2" })),
    wf("d", "2026-01-04", fix({ id: "f3" }), { kind: "run" }),
    wf("e", "2026-01-05", fix({ id: "f4" }), { status: "running" }),
  ], "s1");
  expect(list.map(e => [e.fix.id, e.workflowId, e.active])).toEqual([["f4", "e", true], ["f1", "b", false]]);
  expect(fixesFromWorkflows(undefined, "s1")).toEqual([]);
  expect(fixesFromWorkflows([wf("a", "1", fix())], undefined)).toEqual([]);
});

test("stage and bucket", () => {
  expect(fixStage(fix())).toBe("prepared");
  expect(fixStage(fix({ eligible: false }))).toBe("ineligible");
  expect(fixStage(fix({ result: {} as never }))).toBe("proposed");
  expect(fixStage(fix({ result: {} as never, verification: {} as never }))).toBe("retested");
  expect(fixStage(fix({ applied: true }))).toBe("applied");
  expect(fixStage(fix({ applied: true, published: { prUrl: "https://github.com/a/b/pull/7", branch: "b", worktree: "" } }))).toBe("pr-opened");
  expect(fixBucket("pr-opened")).toBe("ready");
  expect(fixBucket("proposed")).toBe("open");
});

test("parseDiff counts changes and files, ignoring headers", () => {
  const d = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n";
  const p = parseDiff(d);
  expect([p.added, p.removed, p.files, p.truncated]).toEqual([1, 1, ["x.ts"], false]);
  expect(p.lines.map(l => l.kind)).toEqual(["meta", "meta", "meta", "hunk", "del", "add", "context"]);
  expect(parseDiff("").lines).toEqual([]);
  expect(parseDiff("+a\n".repeat(2000)).truncated).toBe(true);
});

test("diff precedence and PR url safety", () => {
  expect(fixDiffText(fix({ result: { diff: "r" } as never, publication: { diff: "p" } as never }))).toBe("p");
  expect(fixDiffText(fix())).toBe("");
  expect(safePrUrl("https://github.com/a/b/pull/12")).toBe("https://github.com/a/b/pull/12");
  expect(safePrUrl("javascript:alert(1)")).toBeUndefined();
  expect(safePrUrl("https://u:p@github.com/x")).toBeUndefined();
  expect(prLabel("https://github.com/a/b/pull/12")).toBe("#12");
});
