import { describe, expect, it } from "vitest";
import type { DesktopConsoleDecision } from "@0/engine/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalPanel, rememberAnswer, resolvedSummary, waitingRequest } from "../src/console/approvals";

const base = { id: "d1", title: "Run nmap", kind: "tool" } as DesktopConsoleDecision;

describe("waiting line presentation", () => {
  it("names the request by the decision title for tool decisions", () => {
    expect(waitingRequest(base)).toBe("Run nmap");
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

describe("question block", () => {
  const question = { ...base, id: "q1", kind: "operator-question", title: "Operator input requested", questions: [{ header: "Target", question: "Which target?", options: [{ label: "Staging", description: "Safe to touch" }, { label: "Prod", description: "Live users" }] }] } as DesktopConsoleDecision;
  const html = renderToStaticMarkup(createElement(ApprovalPanel, { decision: question, busy: false, onResolve: () => {} }));
  it("is a calm waiting row plus a flat list of selectable options, with no bordered card or legend frame", () => {
    expect(html).toContain("Waiting on");
    expect(html).toContain("Which target?");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(new Set(html.match(/name="[^"]+-options"/g)).size).toBe(1);
    expect(html).toContain("Safe to touch");
    expect(html).not.toContain("border-l-[0.5px]");
    expect(html).not.toContain("bg-secondary/50");
    expect(html).toMatch(/<legend class="sr-only">Target<\/legend>/);
    expect(html).toContain("Decline");
    expect(html).toContain("Send answers");
  });
  it("collapses to one Answered line after it is answered", () => {
    rememberAnswer("q1", [{ header: "Target", selectedLabels: ["Staging"] }]);
    const closed = { ...question, resolved: true, approved: true };
    expect(resolvedSummary(closed)).toBe("Answered: Staging");
    const line = renderToStaticMarkup(createElement(ApprovalPanel, { decision: closed, busy: false, onResolve: () => {} }));
    expect(line).toContain("Answered: Staging");
    expect(line).not.toContain("radio");
  });
});
