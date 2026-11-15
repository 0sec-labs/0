import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const entry = new URL("../../../dist/index.js", import.meta.url).pathname;
const examples = new URL("../../../../../examples/agents/", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "zero-agents-cli-"));
const home = join(root, "home");
const folder = join(root, "agents");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A real CLI process against a real store under a temporary HOME. */
async function zero(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" }, cwd: root, timeout: 60_000 });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, out: failure.stdout ?? "", err: failure.stderr ?? "" };
  }
}

describe.skipIf(!existsSync(entry))("0 agents validate | diff | apply | export (real process)", () => {
  it("validates, diffs, applies, repeats as a no-op, and prunes only what it manages", async () => {
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(home, { recursive: true }); mkdirSync(folder, { recursive: true });
    for (const name of readdirSync(examples)) copyFileSync(join(examples, name), join(folder, name));

    const valid = await zero("agents", "validate", folder, "--json");
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.out)).toMatchObject({ ok: true, files: [{ id: "dependency-watcher" }, { id: "pen-tester" }, { id: "pr-security-reviewer" }] });

    const refused = await zero("agents", "apply", folder, "--json");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out).items.find((item: { id: string }) => item.id === "pr-security-reviewer").errors[0].message).toContain("access: changes");
    expect(JSON.parse((await zero("agents", "list", "--json")).out)).toHaveLength(0);

    const diff = JSON.parse((await zero("agents", "diff", folder, "--allow-changes", "--json")).out);
    expect(diff).toMatchObject({ dryRun: true, ok: true, counts: { create: 3 } });
    expect(JSON.parse((await zero("agents", "list", "--json")).out)).toHaveLength(0);

    const applied = JSON.parse((await zero("agents", "apply", folder, "--allow-changes", "--json")).out);
    expect(applied).toMatchObject({ dryRun: false, ok: true, counts: { create: 3 } });
    const listed = JSON.parse((await zero("agents", "list", "--json")).out) as Array<{ id: string; name: string; fileState: { source: string; path: string } }>;
    expect(listed.map(item => item.fileState.path).sort()).toEqual(["dependency-watcher.md", "pen-tester.md", "pr-security-reviewer.md"]);
    const before = JSON.stringify(listed);

    const again = JSON.parse((await zero("agents", "apply", folder, "--allow-changes", "--json")).out);
    expect(again.counts).toMatchObject({ unchanged: 3, create: 0, update: 0 });
    expect(JSON.stringify(JSON.parse((await zero("agents", "list", "--json")).out))).toBe(before);

    // A file that no longer exists is only removed with --prune --yes, and an Agent made by hand is never touched.
    const byHand = await zero("agents", "create", "--preset", "incident-triage", "--json");
    expect(byHand.code).toBe(0);
    rmSync(join(folder, "pen-tester.md"));
    expect(JSON.parse((await zero("agents", "apply", folder, "--allow-changes", "--json")).out).counts.prune).toBe(0);
    expect((await zero("agents", "apply", folder, "--allow-changes", "--prune")).code).toBe(2);
    const pruned = JSON.parse((await zero("agents", "apply", folder, "--allow-changes", "--prune", "--yes", "--json")).out);
    expect(pruned.counts).toMatchObject({ prune: 1, unchanged: 2 });
    const names = (JSON.parse((await zero("agents", "list", "--json")).out) as Array<{ name: string }>).map(item => item.name).sort();
    expect(names).toEqual(["Dependency Watcher", "Incident Triage", "PR Security Reviewer"]);
  }, 120_000);

  it("reports errors with file and line, and exports every Agent without changing any", async () => {
    writeFileSync(join(folder, "broken.md"), "---\napiVersion: 0security/v1\nid: broken\nname: Broken\nproduction: true\n---\n\nbody\n");
    const bad = await zero("agents", "validate", folder);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/broken\.md:5: Unknown key "production"/);
    rmSync(join(folder, "broken.md"));

    const before = (await zero("agents", "list", "--json")).out;
    const dir = join(root, "exported");
    const exported = await zero("agents", "export", "--all", "--dir", dir);
    expect(exported.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["dependency-watcher.md", "incident-triage.md", "pr-security-reviewer.md"]);
    expect((await zero("agents", "list", "--json")).out).toBe(before);
    expect(readFileSync(join(dir, "incident-triage.md"), "utf8")).toContain("preset: incident-triage");
    // Adopting the hand-made Agent through its exported file is a no-op on its settings.
    const adopt = JSON.parse((await zero("agents", "diff", join(dir, "incident-triage.md"), "--adopt", "--allow-changes", "--json")).out);
    expect(adopt.items[0]).toMatchObject({ action: "adopt", changes: [] });
    const refuse = JSON.parse((await zero("agents", "diff", join(dir, "incident-triage.md"), "--allow-changes", "--json")).out);
    expect(refuse.items[0].errors[0].message).toContain("--adopt");
    const single = await zero("agents", "export", "pen-tester");
    expect(single.code).toBe(1);
    expect((await zero("agents", "export", "--preset", "pen-tester")).out).toContain("preset: pen-tester");
  }, 120_000);
});
