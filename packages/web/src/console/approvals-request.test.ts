import { describe, expect, it } from "vitest";
import { resolvedSummary, waitingRequest } from "./approvals";

const tool = (call: { name: string; arguments: unknown }) =>
  ({ id: "d1", kind: "tool", title: "Confirm tool action", detail: "", call }) as never;

describe("waitingRequest for tool decisions", () => {
  it("names the command being confirmed", () => {
    expect(waitingRequest(tool({ name: "bash", arguments: { command: "touch approved.txt" } }))).toBe("Run touch approved.txt");
  });
  it("names other tools", () => {
    expect(waitingRequest(tool({ name: "web_fetch", arguments: { url: "https://a.test" } }))).toBe("Use web fetch");
  });
  it("keeps the outcome in the closed summary", () => {
    expect(resolvedSummary({ ...tool({ name: "bash", arguments: { command: "ls" } }), approved: false })).toBe("Run ls · declined");
  });
  it("falls back to the title without a call", () => {
    expect(waitingRequest({ id: "d2", kind: "tool", title: "Confirm tool action", detail: "" } as never)).toBe("Confirm tool action");
  });
});
