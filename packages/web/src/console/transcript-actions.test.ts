import { describe, expect, it } from "vitest";
import {
  clampDisabled,
  failedCallCount,
  hideFromWorkLog,
  isRetryableError,
  messageLink,
  plainText,
  quoteBlock,
  toolbarActions,
  turnArtifacts,
  workedLabel,
} from "./transcript-actions";
import type { ToolCallState } from "./transcript";

const call = (name: string, result: unknown, args: unknown = {}): ToolCallState => ({
  id: `${name}-${Math.random()}`,
  name,
  arguments: args,
  result,
  isRunning: false,
});
const failed = call("http", { success: false, error: "boom" });
const markers = (over = {}) => ({ failed: 0, subagents: 0, compacted: false, ...over });

describe("workedLabel", () => {
  const base = { isWorking: false, hasWork: true, stopped: false, time: "5m 16s", markers: markers() };
  it("plain, failed, subagent and compacted variants", () => {
    expect(workedLabel(base)).toBe("Worked for 5m 16s");
    expect(workedLabel({ ...base, markers: markers({ failed: 1 }) })).toBe("Worked for 5m 16s, 1 failed");
    expect(workedLabel({ ...base, markers: markers({ failed: 2, subagents: 3, compacted: true }) })).toBe(
      "Worked for 5m 16s, 2 failed, 3 subagents, compacted",
    );
    expect(workedLabel({ ...base, markers: markers({ subagents: 1 }) })).toBe("Worked for 5m 16s, 1 subagent");
  });
  it("working and stopped states", () => {
    expect(workedLabel({ ...base, isWorking: true, hasWork: false })).toBe("Thinking");
    expect(workedLabel({ ...base, isWorking: true })).toBe("Working");
    expect(workedLabel({ ...base, stopped: true, time: "" })).toBe("Stopped");
  });
  it("counts failed receipts only", () => {
    expect(failedCallCount([failed, call("read", { success: true, output: "x" })])).toBe(1);
  });
});

describe("clamp rules", () => {
  it("never clamps the newest answer", () => {
    expect(clampDisabled({ latestTurn: true, isLastAssistantSegment: true })).toBe(true);
    expect(clampDisabled({ latestTurn: true, isLastAssistantSegment: false })).toBe(false);
    expect(clampDisabled({ latestTurn: false, isLastAssistantSegment: true })).toBe(false);
  });
});

describe("visualize rows", () => {
  it("hides only successful visualize calls that render inline", () => {
    expect(hideFromWorkLog(call("visualize", { ok: true }), true)).toBe(true);
    expect(hideFromWorkLog(call("visualize", { success: false, error: "bad" }), true)).toBe(false);
    expect(hideFromWorkLog(call("visualize", { ok: true }), false)).toBe(false);
    expect(hideFromWorkLog(call("read_file", { ok: true }), true)).toBe(false);
  });
});

describe("retry eligibility", () => {
  it("allows generic errors only", () => {
    expect(isRetryableError("Provider returned HTTP 500")).toBe(true);
    expect(isRetryableError("Tool call denied by policy")).toBe(false);
    expect(isRetryableError("Approval declined by operator")).toBe(false);
    expect(isRetryableError("Target out of scope")).toBe(false);
    expect(isRetryableError("HTTP 401 unauthorized")).toBe(false);
  });
});

describe("toolbar", () => {
  it("never offers edit or retry-from-here", () => {
    const actions = toolbarActions({ text: "hi", canReply: true, hasLink: true });
    expect(actions).toMatchObject({ copy: true, reply: true, copyMarkdown: true, copyLink: true, edit: false, retryFromHere: false });
  });
  it("hides reply for readers and empty text", () => {
    expect(toolbarActions({ text: "hi", canReply: false, hasLink: false }).reply).toBe(false);
    expect(toolbarActions({ text: "  ", canReply: true, hasLink: true }).copy).toBe(false);
  });
  it("quotes, links and flattens", () => {
    expect(quoteBlock("a\n\nb")).toBe("> a\n>\n> b\n\n");
    expect(messageLink("http://x/chats/1#old", "t2")).toBe("http://x/chats/1#chat-t2");
    expect(plainText("## Title\n**bold** `x` [link](http://a)")).toBe("Title\nbold x link");
  });
});

describe("turnArtifacts", () => {
  it("extracts saved findings and PR urls from successful results", () => {
    const artifacts = turnArtifacts({
      toolCalls: [
        call("save_finding", { success: true, output: { findingId: "F-1" } }, { title: "SQLi in /login" }),
        call("save_finding", { findingId: "F-1" }, { title: "dup" }),
        call("fix_publish", { fix: { published: { prUrl: "https://github.com/acme/app/pull/12" } } }),
        call("save_finding", { success: false, error: "no" }, { title: "failed" }),
      ],
    });
    expect(artifacts).toEqual([
      { id: "F-1", kind: "finding", title: "SQLi in /login", status: "Saved" },
      { id: "https://github.com/acme/app/pull/12", kind: "pull-request", title: "Opened app#12", status: "PR opened", url: "https://github.com/acme/app/pull/12" },
    ]);
  });
  it("returns nothing without data", () => {
    expect(turnArtifacts({ toolCalls: [call("read_file", "text")] })).toEqual([]);
  });
});
