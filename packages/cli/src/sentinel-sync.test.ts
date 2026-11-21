import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sentinelNeedsReview } from "@0/engine/shared";
import { SecurityWorkflowStore, SentinelStore } from "@0/engine/storage";
import { applySync, exportDefinition, loadDefinitions, planSync } from "./sentinel-sync.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "0-sync-")); dirs.push(dir);
  const defs = join(dir, "defs");
  require("node:fs").mkdirSync(defs);
  const db = join(dir, "0.db");
  const stores = { sentinels: new SentinelStore(db), workflows: new SecurityWorkflowStore(db) };
  return { defs, stores, write: (name: string, text: string) => writeFileSync(join(defs, name), text), close: () => { stores.sentinels.close(); stores.workflows.close(); } };
}
const reviewer = `name: PR reviewer
mission: Review pull requests
instructions: |
  Read the diff and report security mistakes.
skills:
  - pr-diff-review
automations:
  - name: Review pull requests
    template: repository-review
    runIn: new-mission
    triggers:
      - kind: github-pr
        github:
          repo: o/r
          commentOnPr: true
`;
const nightly = `name: Nightly deps
instructions: Check advisories.
automations:
  - name: Daily review
    template: dependency-review
    triggers:
      - kind: schedule
        schedule: { frequency: daily, time: "03:00", timezone: UTC }
`;

describe("Sentinels as files", () => {
  it("shows what would change without writing, then creates paused Sentinels with disabled triggers", () => {
    const s = setup();
    s.write("pr.yaml", reviewer); s.write("deps.yml", nightly);
    const definitions = loadDefinitions(s.defs);
    const plan = planSync(definitions, s.stores);
    expect(plan.map(change => [change.sentinel, change.action])).toEqual([["Nightly deps", "create"], ["PR reviewer", "create"]]);
    expect(s.stores.sentinels.list()).toHaveLength(0);

    applySync(definitions, s.stores, { commit: "abc123" });
    const created = s.stores.sentinels.list();
    expect(created.map(sentinel => sentinel.status)).toEqual(["paused", "paused"]);
    const pr = created.find(sentinel => sentinel.name === "PR reviewer")!;
    expect(s.stores.sentinels.getFile(pr.id, "AGENTS.md")?.content).toContain("Read the diff");
    expect(JSON.parse(s.stores.sentinels.getFile(pr.id, "source.json")!.content)).toMatchObject({ file: "pr.yaml", commit: "abc123" });
    const triggers = s.stores.sentinels.listTriggers();
    expect(triggers).toHaveLength(2);
    expect(triggers.every(trigger => trigger.enabled === false)).toBe(true);
    expect(s.stores.workflows.list().map(workflow => workflow.name).sort()).toEqual(["Daily review", "Review pull requests"]);
    s.close();
  });

  it("a second sync changes nothing, and a changed file changes only what it says", () => {
    const s = setup();
    s.write("pr.yaml", reviewer);
    applySync(loadDefinitions(s.defs), s.stores);
    expect(planSync(loadDefinitions(s.defs), s.stores)[0]).toMatchObject({ action: "unchanged", changes: [] });
    s.write("pr.yaml", reviewer.replace("security mistakes", "security mistakes and secrets").replace("commentOnPr: true", "commentOnPr: false"));
    const plan = planSync(loadDefinitions(s.defs), s.stores);
    expect(plan[0]).toMatchObject({ action: "update", changes: ["instructions", "triggers of Review pull requests"] });
    applySync(loadDefinitions(s.defs), s.stores);
    expect(s.stores.sentinels.listTriggers()).toHaveLength(1);
    expect(s.stores.sentinels.listTriggers()[0]!.github?.commentOnPr).toBe(false);
    expect(planSync(loadDefinitions(s.defs), s.stores)[0]!.action).toBe("unchanged");
    s.close();
  });

  it("a changed skill list sends an active Sentinel back to review", () => {
    const s = setup();
    s.write("pr.yaml", reviewer);
    applySync(loadDefinitions(s.defs), s.stores);
    const sentinel = s.stores.sentinels.list()[0]!;
    s.stores.sentinels.setStatus(sentinel.id, "active", undefined, true);
    expect(sentinelNeedsReview(s.stores.sentinels.get(sentinel.id)!)).toBe(false);
    s.write("pr.yaml", reviewer.replace("- pr-diff-review", "- pr-diff-review\n  - crypto-misuse"));
    applySync(loadDefinitions(s.defs), s.stores);
    expect(sentinelNeedsReview(s.stores.sentinels.get(sentinel.id)!)).toBe(true);
    s.close();
  });

  it("an export syncs back as no change", () => {
    const s = setup();
    s.write("pr.yaml", reviewer);
    applySync(loadDefinitions(s.defs), s.stores);
    const sentinel = s.stores.sentinels.list()[0]!;
    s.write("pr.yaml", exportDefinition(sentinel, s.stores));
    expect(planSync(loadDefinitions(s.defs), s.stores)[0]).toMatchObject({ action: "unchanged" });
    s.close();
  });

  it("rejects bad files: unknown fields, duplicates, aliases and tags", () => {
    const s = setup();
    s.write("a.yaml", "name: A\nunknownField: 1\n");
    expect(() => loadDefinitions(s.defs)).toThrow("a.yaml");
    s.write("a.yaml", "name: Same\n"); s.write("b.yaml", "name: Same\n");
    expect(() => loadDefinitions(s.defs)).toThrow("used by another file");
    s.write("b.yaml", "name: B\ninstructions: &x hello\nmission: *x\n");
    expect(() => loadDefinitions(s.defs)).toThrow("b.yaml");
    s.write("b.yaml", "name: !!js/function x\n");
    expect(() => loadDefinitions(s.defs)).toThrow("b.yaml");
    s.close();
  });
});
