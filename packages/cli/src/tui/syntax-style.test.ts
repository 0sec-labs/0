import { describe, expect, it } from "vitest";

import { getTheme } from "./themes.js";
import {
  codeTokenStyle,
  highlightCode,
  normalizeCodeLang,
  parseDiffLine,
  toSyntaxStyleDefs,
  type CodeTokenKind,
} from "./syntax-style.js";

const THEME = getTheme("dark");

function kinds(line: string, lang?: string): CodeTokenKind[] {
  return highlightCode(line, lang).map((token) => token.kind);
}

function rejoin(line: string, lang?: string): string {
  return highlightCode(line, lang)
    .map((token) => token.text)
    .join("");
}

describe("normalizeCodeLang", () => {
  it("folds aliases onto a family", () => {
    for (const a of ["sh", "bash", "zsh", "shell", "console"]) expect(normalizeCodeLang(a)).toBe("bash");
    for (const a of ["js", "javascript", "jsx", "mjs"]) expect(normalizeCodeLang(a)).toBe("js");
    for (const a of ["ts", "typescript", "tsx"]) expect(normalizeCodeLang(a)).toBe("ts");
    for (const a of ["json", "jsonc", "json5"]) expect(normalizeCodeLang(a)).toBe("json");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeCodeLang("  BASH ")).toBe("bash");
    expect(normalizeCodeLang("TypeScript")).toBe("ts");
  });

  it("folds python and diff aliases", () => {
    for (const a of ["py", "python", "python3"]) expect(normalizeCodeLang(a)).toBe("python");
    for (const a of ["diff", "patch"]) expect(normalizeCodeLang(a)).toBe("diff");
    // A bare file extension resolves too, so an edit path's ext can drive it.
    expect(normalizeCodeLang("ts")).toBe("ts");
    expect(normalizeCodeLang("sh")).toBe("bash");
  });

  it("maps unknown or absent languages to plain", () => {
    expect(normalizeCodeLang("rust")).toBe("plain");
    expect(normalizeCodeLang("")).toBe("plain");
    expect(normalizeCodeLang(undefined)).toBe("plain");
  });
});

describe("highlightCode fidelity", () => {
  it("returns tokens whose texts rejoin to the exact input", () => {
    const samples: Array<[string, string]> = [
      ["ts", "export const n: number = 1_000; // total"],
      ["js", "const s = `hi ${name}`"],
      ["bash", 'curl -s "$URL" | jq .data # fetch'],
      ["json", '{ "a": [1, 2], "b": null }'],
      ["plain", "just some words * and _ marks"],
    ];
    for (const [lang, line] of samples) expect(rejoin(line, lang)).toBe(line);
  });

  it("returns no tokens for an empty line", () => {
    expect(highlightCode("", "ts")).toEqual([]);
  });

  it("keeps leading whitespace as a plain-prefixed token", () => {
    const tokens = highlightCode("\t  const x = 1", "ts");
    expect(tokens.map((t) => t.text).join("")).toBe("\t  const x = 1");
  });
});

describe("highlightCode: bash", () => {
  it("tags comments, strings, keywords, variables and numbers", () => {
    expect(kinds("# whole line comment", "bash")).toEqual(["comment"]);
    expect(kinds("for i in 1 2 3", "bash")).toContain("keyword");
    expect(kinds('echo "text"', "bash")).toContain("string");
    expect(kinds("echo ${VAR}", "bash")).toContain("variable");
    expect(kinds("sleep 30", "bash")).toContain("number");
  });

  it("does not treat a hash inside a word as a comment", () => {
    expect(kinds("id=abc#notcomment", "bash")).not.toContain("comment");
  });
});

describe("highlightCode: js/ts", () => {
  it("tags line and block comments", () => {
    expect(kinds("x = 1 // trailing", "js")).toContain("comment");
    expect(kinds("a /* mid */ b", "ts")).toContain("comment");
  });

  it("tags a call target as a function", () => {
    const tokens = highlightCode("doThing(42)", "ts");
    expect(tokens.find((t) => t.text === "doThing")?.kind).toBe("function");
  });

  it("tags literals as constants and numbers", () => {
    expect(kinds("return true", "js")).toContain("constant");
    expect(kinds("x = 0xFF", "js")).toContain("number");
    expect(kinds("y = 1.5e3", "js")).toContain("number");
  });

  it("only ts knows the ts-only keywords", () => {
    expect(kinds("interface A {}", "ts")).toContain("keyword");
    // In js, "interface" is an ordinary identifier: no keyword token appears.
    expect(kinds("interface A {}", "js")).not.toContain("keyword");
  });
});

describe("highlightCode: json", () => {
  it("distinguishes keys from string values", () => {
    const tokens = highlightCode('"name": "value"', "json");
    expect(tokens.find((t) => t.text === '"name"')?.kind).toBe("property");
    expect(tokens.find((t) => t.text === '"value"')?.kind).toBe("string");
  });

  it("tags literals and signed numbers", () => {
    expect(kinds('"a": false', "json")).toContain("constant");
    expect(kinds('"a": -2.5', "json")).toContain("number");
    expect(highlightCode('"a": -2.5', "json").find((t) => t.kind === "number")?.text).toBe("-2.5");
  });
});

describe("highlightCode: python", () => {
  it("tags comments, strings, keywords, constants, numbers and calls", () => {
    expect(kinds("# a comment", "python")).toEqual(["comment"]);
    expect(kinds("def foo():", "python")).toContain("keyword");
    expect(kinds("x = 'hi'", "python")).toContain("string");
    expect(kinds("return None", "python")).toContain("constant");
    expect(kinds("n = 42", "python")).toContain("number");
    const call = highlightCode("print(x)", "python");
    expect(call.find((t) => t.text === "print")?.kind).toBe("function");
  });

  it("rejoins to the exact input", () => {
    const line = "async def run(self, x=1):  # go";
    expect(rejoin(line, "python")).toBe(line);
  });
});

describe("highlightCode: diff (coarse line-class mode)", () => {
  it("classifies added, removed, context, hunk and marker lines", () => {
    expect(kinds("+added line", "diff")).toEqual(["inserted"]);
    expect(kinds("-removed line", "diff")).toEqual(["deleted"]);
    expect(kinds(" context line", "diff")).toEqual(["plain"]);
    expect(kinds("@@ -1,2 +1,3 @@", "diff")).toEqual(["meta"]);
    expect(kinds("+++ b/file.ts", "diff")).toEqual(["meta"]);
    expect(kinds("--- a/file.ts", "diff")).toEqual(["meta"]);
  });

  it("rejoins to the exact input", () => {
    for (const line of ["+x", "-y", " z", "@@ hunk @@", "diff --git a b"]) {
      expect(rejoin(line, "diff")).toBe(line);
    }
  });
});

describe("parseDiffLine", () => {
  it("splits sign from content, and flags markers/hunks", () => {
    expect(parseDiffLine("+new")).toEqual({ sign: "+", content: "new", raw: "+new" });
    expect(parseDiffLine("-old")).toEqual({ sign: "-", content: "old", raw: "-old" });
    expect(parseDiffLine(" ctx")).toEqual({ sign: " ", content: "ctx", raw: " ctx" });
    expect(parseDiffLine("@@ -1 +1 @@").sign).toBe("@");
    expect(parseDiffLine("+++ b/x").sign).toBe("meta");
    expect(parseDiffLine("--- a/x").sign).toBe("meta");
    expect(parseDiffLine("diff --git a b").sign).toBe("meta");
    // A line with no diff sign is treated as context content.
    expect(parseDiffLine("bare")).toEqual({ sign: "", content: "bare", raw: "bare" });
  });
});

describe("codeTokenStyle", () => {
  it("maps every kind to a theme colour", () => {
    const all: CodeTokenKind[] = [
      "plain", "keyword", "string", "comment", "number", "function",
      "type", "constant", "variable", "operator", "punctuation", "property",
    ];
    for (const kind of all) {
      const style = codeTokenStyle(kind, THEME);
      expect(style.fg).toMatch(/^#|^[a-z]/i);
    }
  });

  it("never paints a token red (red is reserved for errors)", () => {
    const all: CodeTokenKind[] = [
      "plain", "keyword", "string", "comment", "number", "function",
      "type", "constant", "variable", "operator", "punctuation", "property",
    ];
    for (const kind of all) expect(codeTokenStyle(kind, THEME).fg).not.toBe(THEME.ERROR);
  });

  it("makes keywords bold and comments dim", () => {
    expect(codeTokenStyle("keyword", THEME).bold).toBe(true);
    expect(codeTokenStyle("comment", THEME).dim).toBe(true);
  });
});

describe("toSyntaxStyleDefs", () => {
  it("emits a default plus one entry per highlight scope", () => {
    const defs = toSyntaxStyleDefs(THEME);
    expect(defs.default!.fg).toBe(THEME.TEXT);
    for (const scope of ["keyword", "string", "comment", "number", "property"]) {
      expect(defs[scope]).toBeDefined();
      expect(defs[scope]!.fg).toMatch(/^#|^[a-z]/i);
    }
    expect(defs.keyword!.bold).toBe(true);
  });
});
