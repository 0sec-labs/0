/** 0#193 — the agent-tool `parseVerificationSpecArg` helper: parsed objects and JSON strings in, malformed payloads rejected cleanly. */
import { describe, it, expect } from "vitest";
import type { VerificationSpec } from "./shared/index.js";
import { parseVerificationSpecArg } from "./agent/tools.js";

function makeSpec(): VerificationSpec {
  return {
    code: [
      {
        kind: "file-contains",
        file: "app/users.ts",
        pattern: "db\\.query.*req\\.body",
      },
      {
        kind: "file-missing-pattern",
        file: "app/users.ts",
        pattern: "WHERE name = \\?",
      },
      { kind: "file-exists", file: "lib/db.ts" },
    ],
    behavior: {
      steps: [
        { method: "POST", path: "/users", body: { name: "x" }, expect: "success" },
      ],
    },
  };
}

describe("parseVerificationSpecArg (agent tool wire shape, 0#193)", () => {
  it("returns null for nullish / empty / wrong-type input", () => {
    expect(parseVerificationSpecArg(null)).toBeNull();
    expect(parseVerificationSpecArg(undefined)).toBeNull();
    expect(parseVerificationSpecArg("")).toBeNull();
    expect(parseVerificationSpecArg(42)).toBeNull();
    expect(parseVerificationSpecArg(true)).toBeNull();
    expect(parseVerificationSpecArg([])).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseVerificationSpecArg("[{")).toBeNull();
    expect(parseVerificationSpecArg("not json")).toBeNull();
  });

  it("returns null when code is missing", () => {
    expect(parseVerificationSpecArg('{"behavior":{"steps":[]}}')).toBeNull();
  });

  it("parses a JSON-encoded string of a valid spec", () => {
    const spec = makeSpec();
    const out = parseVerificationSpecArg(JSON.stringify(spec));
    expect(out).not.toBeNull();
    expect(out!.code).toHaveLength(3);
    expect(out!.behavior?.steps).toHaveLength(1);
  });

  it("accepts an already-parsed object", () => {
    const spec = makeSpec();
    const out = parseVerificationSpecArg(spec);
    expect(out).toEqual(spec);
  });

  it("drops individual malformed predicates but keeps well-formed ones", () => {
    const mixed = {
      code: [
        // good
        { kind: "file-contains", file: "a.ts", pattern: "x" },
        // missing file
        { kind: "file-contains", pattern: "x" },
        // unknown kind
        { kind: "armageddon", file: "a.ts" },
        // missing pattern on file-contains
        { kind: "file-contains", file: "b.ts" },
        // bad ast-shape (no query)
        { kind: "ast-shape", file: "a.ts" },
        // not an object
        "nope",
        null,
      ],
    };
    const out = parseVerificationSpecArg(mixed);
    expect(out).not.toBeNull();
    expect(out!.code).toHaveLength(1);
    expect(out!.code[0].kind).toBe("file-contains");
  });

  it("accepts a bounded full-commit git diff predicate", () => {
    const diff = "diff --git a/proof.ts b/proof.ts\n";
    const out = parseVerificationSpecArg({
      code: [{ kind: "git-diff-applies", baseCommit: "a".repeat(40), diff }],
    });
    expect(out?.code).toEqual([
      { kind: "git-diff-applies", baseCommit: "a".repeat(40), diff },
    ]);
  });

  it("drops a git diff predicate with an invalid base commit or empty diff", () => {
    const out = parseVerificationSpecArg({
      code: [
        { kind: "git-diff-applies", baseCommit: "deadbeef", diff: "diff --git a/a b/a\n" },
        { kind: "git-diff-applies", baseCommit: "a".repeat(40), diff: "" },
      ],
    });
    expect(out).toBeNull();
  });

  it("drops a malformed behavior block but keeps the spec", () => {
    const out = parseVerificationSpecArg({
      code: [{ kind: "file-exists", file: "a.ts" }],
      behavior: { steps: "not an array" },
    });
    expect(out).not.toBeNull();
    expect(out!.code).toHaveLength(1);
    expect(out!.behavior).toBeUndefined();
  });

  it("drops behavior steps with malformed expect", () => {
    const out = parseVerificationSpecArg({
      code: [{ kind: "file-exists", file: "a.ts" }],
      behavior: {
        steps: [
          // good
          { method: "GET", path: "/", expect: "success" },
          // bad string
          { method: "GET", path: "/", expect: "explode" },
          // bad object (status not a number)
          { method: "GET", path: "/", expect: { status: "200" } },
          // good with status
          { method: "POST", path: "/", expect: { status: 403 } },
        ],
      },
    });
    expect(out).not.toBeNull();
    expect(out!.behavior?.steps).toHaveLength(2);
  });

  it("returns null when the spec collapses to nothing usable", () => {
    // No usable predicates AND no usable behavior → nothing to attach.
    const out = parseVerificationSpecArg({
      code: [{ kind: "armageddon" }, "junk"],
    });
    expect(out).toBeNull();
  });
});

