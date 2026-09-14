import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCrashFeedbackMessage,
  crashStackLines,
  describeErrorForSurface,
  describeFeedbackOutcome,
  firstStackFrame,
  logProblem,
  resolveCrashKey,
  sanitizeCrashText,
  serializeError,
  type CrashInfo,
} from "./tui-crash.js";

const crash: CrashInfo = {
  message: "Cannot read properties of undefined (reading 'x')",
  stack: [
    "TypeError: Cannot read properties of undefined (reading 'x')",
    "    at ChatScreen (/home/op/.0sec/run.tsx:1200:5)",
    "    at renderWithHooks (/node_modules/react/index.js:1:1)",
  ].join("\n"),
};

describe("sanitizeCrashText", () => {
  it("redacts common secret shapes", () => {
    const dirty = [
      "token=sk-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "authorization: Bearer eyJhbGciOi.abc.def",
      "password=hunter2secret",
    ].join(" ");
    const clean = sanitizeCrashText(dirty);
    expect(clean).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(clean).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(clean).not.toContain("hunter2secret");
    expect(clean).toContain("[redacted]");
  });

  it("leaves ordinary stack text intact", () => {
    expect(sanitizeCrashText("at ChatScreen (run.tsx:12:3)")).toBe("at ChatScreen (run.tsx:12:3)");
  });

  it("treats undefined as empty", () => {
    expect(sanitizeCrashText(undefined)).toBe("");
  });
});

describe("crashStackLines", () => {
  it("trims, drops blanks and caps at max", () => {
    const lines = crashStackLines(crash.stack, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("TypeError: Cannot read properties of undefined (reading 'x')");
    expect(lines[1]).toBe("at ChatScreen (/home/op/.0sec/run.tsx:1200:5)");
  });

  it("returns nothing for max 0", () => {
    expect(crashStackLines(crash.stack, 0)).toEqual([]);
  });
});

describe("buildCrashFeedbackMessage", () => {
  it("prepends the note, then a delimited sanitized report", () => {
    const message = buildCrashFeedbackMessage("it died opening findings", crash, 3);
    expect(message.startsWith("it died opening findings\n\n")).toBe(true);
    expect(message).toContain("--- TUI crash report ---");
    expect(message).toContain("error: Cannot read properties of undefined (reading 'x')");
    expect(message).toContain("stack:");
  });

  it("omits the note block when the note is blank", () => {
    const message = buildCrashFeedbackMessage("   ", crash);
    expect(message.startsWith("--- TUI crash report ---")).toBe(true);
  });

  it("redacts secrets that appear in the message or stack", () => {
    const message = buildCrashFeedbackMessage("", {
      message: "boom with token=sk-abcdefghijklmnopqrstuvwxyz012345",
      stack: "at f (ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789)",
    });
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(message).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("falls back to a placeholder for an empty message", () => {
    expect(buildCrashFeedbackMessage("", { message: "", stack: "" })).toContain("error: unknown TUI error");
  });
});

describe("resolveCrashKey", () => {
  it("maps r/f/q in the options view", () => {
    expect(resolveCrashKey("options", { name: "r" })).toEqual({ type: "restart" });
    expect(resolveCrashKey("options", { name: "f" })).toEqual({ type: "feedback" });
    expect(resolveCrashKey("options", { name: "q" })).toEqual({ type: "quit" });
    expect(resolveCrashKey("options", { name: "escape" })).toEqual({ type: "quit" });
    expect(resolveCrashKey("options", { name: "x" })).toEqual({ type: "none" });
  });

  it("offers the same commands from the result view", () => {
    expect(resolveCrashKey("result", { name: "r" })).toEqual({ type: "restart" });
    expect(resolveCrashKey("result", { name: "f" })).toEqual({ type: "feedback" });
    expect(resolveCrashKey("result", { name: "q" })).toEqual({ type: "quit" });
  });

  it("treats letters as text in the feedback view", () => {
    expect(resolveCrashKey("feedback", { name: "r", sequence: "r" })).toEqual({ type: "append", text: "r" });
    expect(resolveCrashKey("feedback", { name: "q", sequence: "q" })).toEqual({ type: "append", text: "q" });
    expect(resolveCrashKey("feedback", { name: "return" })).toEqual({ type: "submit" });
    expect(resolveCrashKey("feedback", { name: "escape" })).toEqual({ type: "back" });
    expect(resolveCrashKey("feedback", { name: "backspace" })).toEqual({ type: "backspace" });
  });

  it("does not append control chords as text", () => {
    expect(resolveCrashKey("feedback", { ctrl: true, name: "a", sequence: "" })).toEqual({ type: "none" });
    expect(resolveCrashKey("feedback", { meta: true, name: "v", sequence: "v" })).toEqual({ type: "none" });
  });

  it("ctrl+c quits from every view", () => {
    for (const view of ["options", "feedback", "submitting", "result"] as const) {
      expect(resolveCrashKey(view, { ctrl: true, name: "c" })).toEqual({ type: "quit" });
    }
  });

  it("swallows keys while submitting", () => {
    expect(resolveCrashKey("submitting", { name: "r" })).toEqual({ type: "none" });
  });
});

describe("describeFeedbackOutcome", () => {
  const local = { ok: true, path: "/home/op/.0sec/feedback.md" };

  it("reports success when both save and submit succeed", () => {
    const out = describeFeedbackOutcome(local, { ok: true });
    expect(out.tone).toBe("ok");
    expect(out.text).toContain("submitted");
  });

  it("reports a saved-locally skip as ok", () => {
    const out = describeFeedbackOutcome(local, { ok: false, skipped: "no-endpoint", error: "No feedback endpoint configured. Saved locally only." });
    expect(out.tone).toBe("ok");
    expect(out.text).toContain("locally");
  });

  it("reports a network failure as an error but notes the local save", () => {
    const out = describeFeedbackOutcome(local, { ok: false, error: "timed out" });
    expect(out.tone).toBe("err");
    expect(out.text).toContain("Saved locally");
    expect(out.text).toContain("timed out");
  });

  it("reports a local save failure as an error", () => {
    const out = describeFeedbackOutcome({ ok: false, path: local.path, error: "EACCES" }, { ok: false, skipped: "no-endpoint" });
    expect(out.tone).toBe("err");
    expect(out.text).toContain("Could not save");
  });
});

describe("serializeError", () => {
  it("captures name, message and the full stack for an Error", () => {
    const err = new TypeError("boom");
    const out = serializeError(err);
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("boom");
    expect(typeof out.stack).toBe("string");
    expect(String(out.stack)).toContain("boom");
    expect(String(out.stack)).toContain("at ");
  });

  it("falls back to a stringified value for a non-Error", () => {
    expect(serializeError("plain string")).toEqual({ value: "plain string" });
  });
});

describe("firstStackFrame", () => {
  it("returns the first `at …` frame without the leading `at`", () => {
    const stack = [
      "TypeError: x",
      "    at ChatScreen (/home/op/run.tsx:12:5)",
      "    at render (/node_modules/react/index.js:1:1)",
    ].join("\n");
    expect(firstStackFrame(stack)).toBe("ChatScreen (/home/op/run.tsx:12:5)");
  });

  it("returns undefined for empty or frame-less stacks", () => {
    expect(firstStackFrame(undefined)).toBeUndefined();
    expect(firstStackFrame("TypeError: x")).toBeUndefined();
  });
});

describe("describeErrorForSurface", () => {
  it("uses the real message when present", () => {
    expect(describeErrorForSurface(new Error("real reason"))).toBe("real reason");
  });

  it("never renders a bare 'unknown' for an Error with an empty message", () => {
    const err = new Error("");
    err.stack = "Error\n    at doThing (/home/op/turn.ts:88:3)";
    const text = describeErrorForSurface(err);
    expect(text).not.toBe("unknown");
    expect(text).toContain("Error");
    expect(text).toContain("doThing (/home/op/turn.ts:88:3)");
    expect(text).toContain("0sec-tui.log");
  });

  it("uses the error name and a log hint when there is no stack at all", () => {
    const err = new RangeError("");
    err.stack = undefined;
    const text = describeErrorForSurface(err);
    expect(text).toContain("RangeError");
    expect(text).toContain("0sec-tui.log");
  });

  it("handles null/empty non-Errors without producing 'unknown'", () => {
    expect(describeErrorForSurface(null)).toContain("no message");
    expect(describeErrorForSurface("")).toContain("no message");
    expect(describeErrorForSurface("a plain error string")).toBe("a plain error string");
  });

  it("bounds the surfaced text", () => {
    const text = describeErrorForSurface(new Error("x".repeat(5000)), 100);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("logProblem (always-on local capture)", () => {
  let dir: string;
  const savedLog = process.env["0SEC_TUI_LOG"];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedLog === undefined) delete process.env["0SEC_TUI_LOG"];
    else process.env["0SEC_TUI_LOG"] = savedLog;
  });

  it("writes the full serialized error (with stack) to the log by default", () => {
    dir = mkdtempSync(join(tmpdir(), "tui-log-"));
    const logPath = join(dir, "tui.log");
    process.env["0SEC_TUI_LOG"] = logPath;

    const err = new Error("kaboom");
    logProblem("runtime", err, "shell");

    const written = readFileSync(logPath, "utf8").trim();
    const record = JSON.parse(written);
    expect(record.kind).toBe("problem");
    expect(record.problemKind).toBe("runtime");
    expect(record.toolName).toBe("shell");
    expect(record.error.message).toBe("kaboom");
    expect(typeof record.error.stack).toBe("string");
    expect(record.error.stack).toContain("kaboom");
  });

  it("captures a non-Error problem too", () => {
    dir = mkdtempSync(join(tmpdir(), "tui-log-"));
    const logPath = join(dir, "tui.log");
    process.env["0SEC_TUI_LOG"] = logPath;

    logProblem("tool", "string failure");

    const record = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(record.problemKind).toBe("tool");
    expect(record.error.value).toBe("string failure");
    expect(record.toolName).toBeUndefined();
  });
});
