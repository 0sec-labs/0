import { describe, it, expect } from "vitest";
import { buildEvalCommand, parseEvalArgs } from "./eval.js";
import { ToolExecutor } from "../tools.js";
import type { ToolContext, ToolResultMeta } from "../types.js";

describe("parseEvalArgs (js_eval / python_eval arg validation)", () => {
  it("accepts a non-empty code string and no timeout", () => {
    const r = parseEvalArgs({ code: "console.log(1)" });
    expect(r).toEqual({ ok: true, value: { code: "console.log(1)", timeout: undefined } });
  });

  it("accepts a positive numeric timeout", () => {
    const r = parseEvalArgs({ code: "x", timeout: 15 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.timeout).toBe(15);
  });

  it("rejects a missing code arg", () => {
    const r = parseEvalArgs({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/code is required/i);
  });

  it("rejects a non-string code arg", () => {
    const r = parseEvalArgs({ code: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be a string/i);
  });

  it("rejects an empty / whitespace-only code arg", () => {
    const r = parseEvalArgs({ code: "   \n  " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must not be empty/i);
  });

  it("rejects a non-positive or non-finite timeout", () => {
    for (const timeout of [0, -5, Number.NaN, "30"]) {
      const r = parseEvalArgs({ code: "x", timeout });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/timeout/i);
    }
  });
});

describe("buildEvalCommand (safe heredoc, no injection surface)", () => {
  it("wraps JS in a quoted node heredoc that contains the code literally", () => {
    const cmd = buildEvalCommand("javascript", "console.log('hi')");
    expect(cmd).toMatch(/^node <<'OSEC_EVAL_EOF'\n/);
    // Code appears verbatim so shellExec's static URL/egress scope guards still
    // see any embedded URL (a base64 pipeline would have hidden it).
    expect(cmd).toContain("console.log('hi')");
    expect(cmd.endsWith("\nOSEC_EVAL_EOF")).toBe(true);
  });

  it("uses python3 for python", () => {
    const cmd = buildEvalCommand("python", "print(2 + 2)");
    expect(cmd).toMatch(/^python3 <<'OSEC_EVAL_EOF'\n/);
    expect(cmd).toContain("print(2 + 2)");
  });

  it("picks a collision-free delimiter when the code contains the base token", () => {
    const cmd = buildEvalCommand("javascript", "OSEC_EVAL_EOF\nconsole.log(1)");
    // The base delimiter collides with a code line, so a numbered one is used.
    expect(cmd).toMatch(/^node <<'OSEC_EVAL_EOF_1'\n/);
    expect(cmd.endsWith("\nOSEC_EVAL_EOF_1")).toBe(true);
  });
});

function testCtx(): ToolContext {
  return {
    target: "https://example.com",
    scanId: "eval-test",
    findings: [],
    attackResults: [],
    targetInfo: {},
  };
}

describe("js_eval / python_eval — code-card meta shape", () => {
  it("routes js_eval through the executor and attaches a `code` meta", async () => {
    const executor = new ToolExecutor(testCtx(), null);
    const code = "console.log('eval-card-ok:' + (6 * 7))";
    const result = await executor.execute({ name: "js_eval", arguments: { code } });

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");
    expect(String(result.output)).toContain("eval-card-ok:42");

    const meta = result.meta as ToolResultMeta | undefined;
    expect(meta).toBeDefined();
    expect(meta?.kind).toBe("code");
    expect(meta?.language).toBe("javascript");
    expect(meta?.code).toBe(code);
    expect(meta?.output).toContain("eval-card-ok:42");
    expect(meta?.exitCode).toBe(0);
    expect(typeof meta?.durationMs).toBe("number");
  });

  it("rejects an invalid js_eval call before executing anything", async () => {
    const executor = new ToolExecutor(testCtx(), null);
    const result = await executor.execute({ name: "js_eval", arguments: {} });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/code is required/i);
    expect(result.meta).toBeUndefined();
  });
});
