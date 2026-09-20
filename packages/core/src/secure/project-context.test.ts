import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureProjectSuggestions, parseProjectObservations, prepareProjectContext } from "./project-context.js";

const snapshot = { schema: "0sec-project-context-v1", repositoryId: "57bde9ba-c509-4dbd-8bc0-43d19e9e7024",
  revision: 1, sourceRevision: "a".repeat(40), context: { summary: "Service", instructions: "Preserve public APIs", observations: [] } };
let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe("project context trust boundary", () => {
  it("rejects unknown permissions and oversized snapshots before consumption", () => {
    expect(() => prepareProjectContext(JSON.stringify({ ...snapshot, permissions: ["publish"] }))).toThrow();
    expect(() => prepareProjectContext(JSON.stringify({ ...snapshot, context: { ...snapshot.context, instructions: "x".repeat(9000) } }))).toThrow();
    expect(() => prepareProjectContext("not-json")).toThrow();
  });

  it("changes the resume digest when approved instructions change", () => {
    const before = prepareProjectContext(JSON.stringify(snapshot));
    const after = prepareProjectContext(JSON.stringify({ ...snapshot, context: { ...snapshot.context, instructions: "Use the new conventions" } }));
    expect(before?.digest).not.toBe(after?.digest);
  });

  it("rejects unbounded notes and unsafe evidence paths", () => {
    const wrap = (notes: unknown) => `<codebase-context>${JSON.stringify(notes)}</codebase-context>`;
    expect(parseProjectObservations(wrap([{ kind: "convention", text: "Unsafe", files: ["../secret"] }]))).toEqual([]);
    expect(parseProjectObservations(wrap(Array.from({ length: 9 }, () => ({ kind: "tests", text: "Too many", files: ["test.ts"] }))))).toEqual([]);
    expect(parseProjectObservations("No observed conventions.")).toEqual([]);
  });

  it("retains only notes citing regular files in the exact scanned Git revision", () => {
    directory = mkdtempSync(join(tmpdir(), "zero-context-provenance-"));
    execFileSync("git", ["init", "-q", directory]);
    const git = (args: string[], input?: string) => execFileSync("git", ["-C", directory!, ...args], { input, encoding: "utf8" }).trim();
    const blob = git(["hash-object", "-w", "--stdin"], "export const transaction = true;\n");
    const tree = git(["mktree"], `100644 blob ${blob}\tservice.ts\n120000 blob ${blob}\tshortcut.ts\n`);
    const revision = execFileSync("git", ["-C", directory, "commit-tree", tree, "-m", "Fixture"], { encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
    const context = prepareProjectContext(JSON.stringify(snapshot))!;
    const notes = parseProjectObservations(`<codebase-context>${JSON.stringify([
      { kind: "convention", text: "Transactions are explicit in service.ts.", files: ["service.ts"] },
      { kind: "tests", text: "A missing file must not become evidence.", files: ["missing.ts"] },
      { kind: "security", text: "A symbolic link must not become source evidence.", files: ["shortcut.ts"] },
    ])}</codebase-context>`);
    const result = captureProjectSuggestions(notes, directory, revision, context);
    expect(result?.observations.map(item => item.text)).toEqual(["Transactions are explicit in service.ts."]);
    expect(result?.observations[0]?.evidence).toEqual([{ path: "service.ts", revision }]);
    expect(result?.configurationRevision).toBe(1);
    expect(captureProjectSuggestions(notes, directory, "b".repeat(40), context)).toBeUndefined();
  });
});
