import { describe, expect, it } from "vitest";
import type { DesktopConsoleDecision } from "@0/engine/shared";
import { resolvedSummary, waitingRequest } from "../src/console/approvals";

const base = { id: "d1", title: "Run nmap", kind: "tool" } as DesktopConsoleDecision;

describe("waiting line presentation", () => {
  it("names the request by the decision title for tool, scope and folder decisions", () => {
    expect(waitingRequest(base)).toBe("Run nmap");
    expect(waitingRequest({ ...base, kind: "local-scope", title: "Read /repo" })).toBe("Read /repo");
  });
  it("names a question by its header", () => {
    const question = { ...base, kind: "operator-question", questions: [{ header: "Which env?", question: "Pick one" }] } as DesktopConsoleDecision;
    expect(waitingRequest(question)).toBe("Which env?");
  });
  it("collapses closed decisions to one muted sentence", () => {
    expect(resolvedSummary({ ...base, approved: true })).toBe("Run nmap · allowed");
    expect(resolvedSummary({ ...base, approved: false })).toBe("Run nmap · declined");
    expect(resolvedSummary(base)).toBe("Run nmap · closed");
  });
});
