import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../agent/tools.js";
import { buildConsoleSystemPrompt } from "./turn-engine.js";

const GONE = ["read_file", "list_files", "search_files", "http_request", "query_findings", "verify_finding", "list_skills", "spawn_agents", "spawn_persistent_agent", "read_only", "read-only worker", "tool registry", "reconnaissance"];

describe("what the model is told matches the tools it has", () => {
  it.each(["ask", "auto"] as const)("the system prompt (%s) names no removed tool or mode", (approvals) => {
    const prompt = buildConsoleSystemPrompt({ scanId: "s", approvals });
    for (const word of GONE) expect(prompt, word).not.toContain(word);
    expect(prompt).toContain("shell");
  });

  it("no tool description or parameter mentions a removed tool or a read-only mode", () => {
    const text = JSON.stringify(Object.values(TOOL_DEFINITIONS));
    for (const word of GONE) expect(text, word).not.toContain(word);
  });
});
