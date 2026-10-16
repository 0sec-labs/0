import { describe, expect, it } from "vitest";

import {
  PRIMARY_AGENT_NAME,
  agentTaskLabel,
  assignAgentName,
  uniquifyAgentName,
} from "./name-generator.js";

describe("agentTaskLabel", () => {
  it("shows the actual change rather than structural headings or acceptance instructions", () => {
    const task = "# Target\n`src/parser.ts`\n\n# Change\n- Preserve full assistant prose\n\n# Acceptance\nRun the consumer smoke";
    expect(agentTaskLabel(task, "QuietBeacon")).toBe("Preserve full assistant prose");
  });

  it("prefers the goal and strips display controls without flattening the task body into a label", () => {
    expect(agentTaskLabel("# Constraints\nDo not edit UI\n# Goal — **Review** parser\u202e boundaries\nSecond paragraph")).toBe("Review parser boundaries");
  });

  it("uses the stored name only when the task has no meaningful label", () => {
    expect(agentTaskLabel("# Target\n\n# Acceptance\nMust pass", "ParserReview")).toBe("ParserReview");
  });

  it("bounds long task labels without splitting a Unicode character", () => {
    const label = agentTaskLabel(`${"x".repeat(62)}😀 inspect parser flow`);
    expect(label).toBe(`${"x".repeat(62)}…`);
  });

  it("retains full task titles when the consuming surface owns its width", () => {
    const title = "Review authentication, authorization, tenant boundaries and session secrets across the complete repository";
    expect(agentTaskLabel(`# Goal\n${title}`, undefined, Infinity)).toBe(title);
  });
});

describe("uniquifyAgentName", () => {
  it("suffixes on a case-insensitive collision without changing an available name", () => {
    expect(uniquifyAgentName("ParserReview", ["Main"])).toBe("ParserReview");
    expect(uniquifyAgentName("Main", ["main"])).toBe("Main-2");
    expect(uniquifyAgentName("Review parser", ["Review parser", "review parser-2"])).toBe("Review parser-3");
  });
});

describe("assignAgentName", () => {
  it("keeps task meaning while reserving Main and distinguishing repeated assignments", () => {
    expect(assignAgentName("Main", [PRIMARY_AGENT_NAME])).toBe("Main-2");
    const first = assignAgentName("Review parser", [PRIMARY_AGENT_NAME]);
    expect(first).toBe("Review parser");
    expect(assignAgentName("Review parser", [PRIMARY_AGENT_NAME, first])).toBe("Review parser-2");
  });

  it("qualifies nested workers without qualifying Main's direct children", () => {
    expect(assignAgentName("Inspect parser", ["Main"], "Review")).toBe("Review.Inspect parser");
    expect(assignAgentName("Inspect parser", ["Main"], "Main")).toBe("Inspect parser");
  });
});
