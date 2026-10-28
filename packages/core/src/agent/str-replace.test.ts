import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("../plugins/enablement.js", async (importOriginal) => ({
  ...await importOriginal<object>(),
  readEnablement: () => ({ schema: 1, project: process.cwd(), enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 1 } } }),
}));
import { ToolExecutor, getToolsForRole } from "./tools.js";
import type { ToolContext, ToolResultMeta } from "./types.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// str_replace — exact-string file edit (Claude text_editor contract). These
// executor-level tests pin the match/uniqueness semantics, the scope gate, and
// the display-only edit-card meta.

const baseCtx: ToolContext = {
  target: "https://example.com",
  scanId: "str-replace-test",
  findings: [],
  attackResults: [],
  targetInfo: {},
};

describe("str_replace (executor-level integration)", () => {
  let tmp: string;
  let scopedExecutor: ToolExecutor;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "0-str-replace-"));
    scopedExecutor = new ToolExecutor({ ...baseCtx, scopePath: tmp }, null);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("replaces a unique exact match and reports the change", async () => {
    const target = join(tmp, "greet.ts");
    writeFileSync(target, ["function greet(name) {", "  return `Hello ${name}`;", "}", ""].join("\n"));

    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: {
        path: "greet.ts",
        old_string: "  return `Hello ${name}`;",
        new_string: "  return `Hi ${name}!`;",
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ path: "greet.ts", replacements: 1 });
    expect(readFileSync(target, "utf-8")).toBe(
      ["function greet(name) {", "  return `Hi ${name}!`;", "}", ""].join("\n"),
    );
  });

  it("attaches a display-only edit-card meta with added/removed and a diff", async () => {
    const target = join(tmp, "meta.ts");
    writeFileSync(target, ["const a = 1;", "const b = 2;", ""].join("\n"));

    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "meta.ts", old_string: "const b = 2;", new_string: "const b = 3;\nconst c = 4;" },
    });

    expect(result.success).toBe(true);
    const meta = result.meta as ToolResultMeta;
    expect(meta.kind).toBe("edit");
    expect(meta.path).toBe("meta.ts");
    expect(meta.removed).toBe(1);
    expect(meta.added).toBe(2);
    expect(meta.diff).toBe(["-const b = 2;", "+const b = 3;", "+const c = 4;"].join("\n"));
    // Model-facing shape carries no diff — meta is display-only.
    expect(result.output).not.toHaveProperty("diff");
  });

  it("errors when old_string is not found", async () => {
    const target = join(tmp, "nf.ts");
    writeFileSync(target, "const x = 1;\n");

    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "nf.ts", old_string: "const y = 2;", new_string: "const z = 3;" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in nf\.ts/);
    // File untouched.
    expect(readFileSync(target, "utf-8")).toBe("const x = 1;\n");
  });

  it("refuses a non-unique match unless replace_all is set", async () => {
    const target = join(tmp, "dup.ts");
    writeFileSync(target, ["x", "x", "x", ""].join("\n"));

    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "dup.ts", old_string: "x", new_string: "y" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/matches 3 locations in dup\.ts; not unique/);
    expect(result.error).toMatch(/replace_all/);
    // File untouched.
    expect(readFileSync(target, "utf-8")).toBe(["x", "x", "x", ""].join("\n"));
  });

  it("replaces every occurrence with replace_all", async () => {
    const target = join(tmp, "all.ts");
    writeFileSync(target, ["x", "x", "x", ""].join("\n"));

    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "all.ts", old_string: "x", new_string: "y", replace_all: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ path: "all.ts", replacements: 3 });
    expect(readFileSync(target, "utf-8")).toBe(["y", "y", "y", ""].join("\n"));
    expect((result.meta as ToolResultMeta).removed).toBe(3);
    expect((result.meta as ToolResultMeta).added).toBe(3);
  });

  it("is whitespace/indentation-sensitive — a TAB indent is not matched by spaces", async () => {
    const target = join(tmp, "ws.ts");
    // Body indented with a TAB; the model supplies spaces.
    writeFileSync(target, ["function f() {", "\treturn 1;", "}", ""].join("\n"));

    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "ws.ts", old_string: "  return 1;", new_string: "  return 2;" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(readFileSync(target, "utf-8")).toBe(["function f() {", "\treturn 1;", "}", ""].join("\n"));

    // The exact tab-indented old_string succeeds.
    const ok = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "ws.ts", old_string: "\treturn 1;", new_string: "\treturn 2;" },
    });
    expect(ok.success).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(["function f() {", "\treturn 2;", "}", ""].join("\n"));
  });

  it("treats `$` in new_string literally (no regex/replacement-pattern expansion)", async () => {
    const target = join(tmp, "dollar.ts");
    writeFileSync(target, "const a = 1;\n");

    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "dollar.ts", old_string: "const a = 1;", new_string: "const a = `$&$1`;" },
    });

    expect(result.success).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("const a = `$&$1`;\n");
  });

  it("refuses a path that escapes the scope", async () => {
    const outside = mkdtempSync(join(tmpdir(), "0-str-replace-out-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "top secret\n");
    try {
      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: { path: "../".repeat(8) + join(outside, "secret.txt").replace(/^\/+/, ""), old_string: "top secret", new_string: "pwned" },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/escapes the allowed scope/);
      // Absolute-path escape is refused too.
      const abs = await scopedExecutor.execute({
        name: "str_replace",
        arguments: { path: secret, old_string: "top secret", new_string: "pwned" },
      });
      expect(abs.success).toBe(false);
      expect(abs.error).toMatch(/escapes the allowed scope/);
      // Secret untouched.
      expect(readFileSync(secret, "utf-8")).toBe("top secret\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink pointing outside the scope", async () => {
    const outside = mkdtempSync(join(tmpdir(), "0-str-replace-symout-"));
    const secret = join(outside, "creds.txt");
    writeFileSync(secret, "aws_key\n");
    try {
      symlinkSync(secret, join(tmp, "link.txt"));
      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: { path: "link.txt", old_string: "aws_key", new_string: "pwned" },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/escapes the allowed scope/);
      expect(readFileSync(secret, "utf-8")).toBe("aws_key\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("errors when the file does not exist", async () => {
    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "nope.ts", old_string: "a", new_string: "b" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file does not exist/);
  });

  it("rejects an empty old_string", async () => {
    writeFileSync(join(tmp, "e.ts"), "x\n");
    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "e.ts", old_string: "", new_string: "y" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must not be empty/);
  });

  it("rejects an identical old_string / new_string no-op", async () => {
    writeFileSync(join(tmp, "same.ts"), "same\n");
    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "same.ts", old_string: "same", new_string: "same" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/identical/);
  });


  describe("line-ending adaptation (CRLF and LF interoperability)", () => {
    it("matches multiline LF search string against CRLF file and formats replacement with CRLF", async () => {
      const target = join(tmp, "crlf.ts");
      writeFileSync(target, "function foo() {\r\n  const a = 1;\r\n  return a;\r\n}\r\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "crlf.ts",
          old_string: "  const a = 1;\n  return a;",
          new_string: "  const a = 2;\n  const b = 3;\n  return a + b;",
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ path: "crlf.ts", replacements: 1 });
      const content = readFileSync(target, "utf-8");
      expect(content).toBe("function foo() {\r\n  const a = 2;\r\n  const b = 3;\r\n  return a + b;\r\n}\r\n");
      expect(content.replace(/\r\n/g, "")).not.toContain("\n");
    });

    it("single-line replacement in a CRLF file succeeds and preserves CRLF line endings", async () => {
      const target = join(tmp, "single-crlf.ts");
      writeFileSync(target, "const x = 1;\r\nconst y = 2;\r\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "single-crlf.ts",
          old_string: "const x = 1;",
          new_string: "const x = 42;",
        },
      });

      expect(result.success).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("const x = 42;\r\nconst y = 2;\r\n");
    });

    it("LF file continues to match and replace with LF without introducing CRLF", async () => {
      const target = join(tmp, "lf.ts");
      writeFileSync(target, "function bar() {\n  return 1;\n}\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "lf.ts",
          old_string: "function bar() {\n  return 1;\n}",
          new_string: "function bar() {\n  return 2;\n}",
        },
      });

      expect(result.success).toBe(true);
      const content = readFileSync(target, "utf-8");
      expect(content).toBe("function bar() {\n  return 2;\n}\n");
      expect(content).not.toContain("\r");
    });

    it("explicit CRLF input matches and replaces correctly on CRLF file", async () => {
      const target = join(tmp, "explicit-crlf.ts");
      writeFileSync(target, "line 1\r\nline 2\r\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "explicit-crlf.ts",
          old_string: "line 1\r\nline 2",
          new_string: "first\r\nsecond",
        },
      });

      expect(result.success).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("first\r\nsecond\r\n");
    });

    it("multiple matches with replace_all: true are all replaced on CRLF file", async () => {
      const target = join(tmp, "crlf-all.ts");
      writeFileSync(target, "repeat:\r\n  step\r\nrepeat:\r\n  step\r\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "crlf-all.ts",
          old_string: "repeat:\n  step",
          new_string: "done:\n  ok",
          replace_all: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ path: "crlf-all.ts", replacements: 2 });
      expect(readFileSync(target, "utf-8")).toBe("done:\r\n  ok\r\ndone:\r\n  ok\r\n");
    });

    it("multiple matches with replace_all: false are rejected as ambiguous on CRLF file", async () => {
      const target = join(tmp, "crlf-ambig.ts");
      writeFileSync(target, "block:\r\n  action\r\nblock:\r\n  action\r\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "crlf-ambig.ts",
          old_string: "block:\n  action",
          new_string: "block:\n  modified",
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/matches 2 locations in crlf-ambig\.ts; not unique/);
      expect(readFileSync(target, "utf-8")).toBe("block:\r\n  action\r\nblock:\r\n  action\r\n");
    });

    it("mixed-line-ending file retains unrelated line endings across the file", async () => {
      const target = join(tmp, "mixed.ts");
      const mixed = "header1\r\nheader2\r\ntarget:\r\n  foo\r\nfooter1\nfooter2\n";
      writeFileSync(target, mixed, "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "mixed.ts",
          old_string: "target:\n  foo",
          new_string: "target:\n  bar\n  baz",
        },
      });

      expect(result.success).toBe(true);
      const content = readFileSync(target, "utf-8");
      expect(content).toContain("target:\r\n  bar\r\n  baz\r\n");
      expect(content.startsWith("header1\r\nheader2\r\n")).toBe(true);
      expect(content.endsWith("footer1\nfooter2\n")).toBe(true);
    });

    it("CRLF input on an LF file adapts to match and preserves LF line endings", async () => {
      const target = join(tmp, "crlf-to-lf.ts");
      writeFileSync(target, "line 1\nline 2\nline 3\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "crlf-to-lf.ts",
          old_string: "line 1\r\nline 2",
          new_string: "alpha\r\nbeta",
        },
      });

      expect(result.success).toBe(true);
      const content = readFileSync(target, "utf-8");
      expect(content).toBe("alpha\nbeta\nline 3\n");
      expect(content).not.toContain("\r");
    });

    it("mixed-line-ending file: adapts CRLF query to match an LF block in a file that has CRLF elsewhere", async () => {
      const target = join(tmp, "mixed-crlf-elsewhere.ts");
      const mixed = "header1\r\nheader2\r\nfunction run() {\n  return 42;\n}\nfooter1\r\nfooter2\r\n";
      writeFileSync(target, mixed, "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "mixed-crlf-elsewhere.ts",
          old_string: "function run() {\r\n  return 42;\r\n}",
          new_string: "function run() {\r\n  return 100;\r\n}",
        },
      });

      expect(result.success).toBe(true);
      const content = readFileSync(target, "utf-8");
      expect(content).toContain("function run() {\n  return 100;\n}\n");
      expect(content.startsWith("header1\r\nheader2\r\n")).toBe(true);
      expect(content.endsWith("footer1\r\nfooter2\r\n")).toBe(true);
    });

    it("mixed-line-ending file: rejects ambiguity when the same logical multiline block occurs once with LF and once with CRLF (replace_all: false)", async () => {
      const target = join(tmp, "mixed-dup-reject.ts");
      const mixed = "header\r\nblock:\r\n  action\r\nmiddle\nblock:\n  action\nfooter\r\n";
      writeFileSync(target, mixed, "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "mixed-dup-reject.ts",
          old_string: "block:\n  action",
          new_string: "block:\n  done",
          replace_all: false,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/matches 2 locations in mixed-dup-reject\.ts; not unique/);
      expect(result.error).toMatch(/replace_all/);
      expect(readFileSync(target, "utf-8")).toBe(mixed);
    });

    it("mixed-line-ending file: replaces both occurrences when the same logical multiline block occurs once with LF and once with CRLF (replace_all: true)", async () => {
      const target = join(tmp, "mixed-dup-replace-all.ts");
      const mixed = "header\r\nblock:\r\n  action\r\nmiddle\nblock:\n  action\nfooter\r\n";
      writeFileSync(target, mixed, "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "mixed-dup-replace-all.ts",
          old_string: "block:\n  action",
          new_string: "block:\n  done",
          replace_all: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ path: "mixed-dup-replace-all.ts", replacements: 2 });
      const content = readFileSync(target, "utf-8");
      expect(content).toBe("header\r\nblock:\r\n  done\r\nmiddle\nblock:\n  done\nfooter\r\n");
      expect((result.meta as ToolResultMeta).removed).toBe(4);
      expect((result.meta as ToolResultMeta).added).toBe(4);
    });

    it("multiline matching uses non-overlapping semantics (same as exact matching)", async () => {
      const target = join(tmp, "overlap.ts");
      // "a\r\na\na" contains [0,4) for CRLF "a\r\na" and [3,6) for LF "a\na", overlapping at index 3
      writeFileSync(target, "a\r\na\na", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "overlap.ts",
          old_string: "a\na",
          new_string: "b\nb",
          replace_all: false,
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ path: "overlap.ts", replacements: 1 });
      expect(readFileSync(target, "utf-8")).toBe("b\r\nb\na");
    });

    it("treats special replacement patterns ($&, $', $`) literally in multiline replacements on CRLF files", async () => {
      const target = join(tmp, "special-dollar-crlf.ts");
      writeFileSync(target, "start:\r\n  val1\r\n  val2\r\nend\r\n", "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "special-dollar-crlf.ts",
          old_string: "start:\n  val1\n  val2",
          new_string: "start:\n  $& matched\n  $' post\n  $` pre",
        },
      });

      expect(result.success).toBe(true);
      const content = readFileSync(target, "utf-8");
      expect(content).toBe("start:\r\n  $& matched\r\n  $' post\r\n  $` pre\r\nend\r\n");
    });

    it("preserves literal $&, $', $` and all bytes outside matched regions with replace_all: true on mixed CRLF/LF file", async () => {
      const target = join(tmp, "mixed-dollar-all.ts");
      const mixed = "header:\r\nblock:\r\n  old\r\nmiddle:\nblock:\n  old\nfooter:\r\n";
      writeFileSync(target, mixed, "utf-8");

      const result = await scopedExecutor.execute({
        name: "str_replace",
        arguments: {
          path: "mixed-dollar-all.ts",
          old_string: "block:\n  old",
          new_string: "block:\n  $& and $'",
          replace_all: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ path: "mixed-dollar-all.ts", replacements: 2 });
      const content = readFileSync(target, "utf-8");
      expect(content).toBe("header:\r\nblock:\r\n  $& and $'\r\nmiddle:\nblock:\n  $& and $'\nfooter:\r\n");
    });
  });

  it("edits a file in a nested subdirectory of the scope", async () => {
    mkdirSync(join(tmp, "src", "lib"), { recursive: true });
    const nested = join(tmp, "src", "lib", "n.ts");
    writeFileSync(nested, "const v = 1;\n");
    const result = await scopedExecutor.execute({
      name: "str_replace",
      arguments: { path: "src/lib/n.ts", old_string: "const v = 1;", new_string: "const v = 2;" },
    });
    expect(result.success).toBe(true);
    expect(readFileSync(nested, "utf-8")).toBe("const v = 2;\n");
  });
});

describe("str_replace scope + role gating (mirrors apply_patch)", () => {
  it("refuses to run without a scoped local directory", async () => {
    const executor = new ToolExecutor({ ...baseCtx }, null);
    const result = await executor.execute({
      name: "str_replace",
      arguments: { path: "x.ts", old_string: "a", new_string: "b" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a scoped local directory/);
  });

  it("is offered to the verify role only alongside apply_patch when scoped", () => {
    const scoped = getToolsForRole("verify", { hasScope: true }).map((t) => t.name);
    expect(scoped).toContain("str_replace");
    expect(scoped).toContain("apply_patch");

    const unscoped = getToolsForRole("verify").map((t) => t.name);
    expect(unscoped).not.toContain("str_replace");
    expect(unscoped).not.toContain("apply_patch");
  });
});
