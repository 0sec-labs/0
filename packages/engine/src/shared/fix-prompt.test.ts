import { describe, expect, it } from "vitest";
import { fixPolicyBlock, fixPrompt, type FixPolicy, type FixPromptFinding } from "./fix-prompt.js";

const sampleFinding: FixPromptFinding = {
  id: "find-sql-1",
  title: "SQL injection vulnerability in user lookup",
  severity: "high",
  category: "sql-injection",
  tool: "foxguard",
  description: "User input directly concatenated into SQL statement.",
  path: "src/db/users.ts",
  startLine: 42,
  snippet: "SELECT * FROM users WHERE name = '\" + input + \"'",
};

describe("fixPolicyBlock", () => {
  it("returns empty string when policy is undefined or empty", () => {
    expect(fixPolicyBlock(undefined)).toBe("");
    expect(fixPolicyBlock({})).toBe("");
  });

  it("formats approved libraries using string and object notation", () => {
    const policy: FixPolicy = {
      approvedLibraries: [
        "dompurify",
        { name: "kysely", preferredVersion: "^0.27.0", purpose: "SQL queries", notes: "Use parameterized queries" },
      ],
    };
    const block = fixPolicyBlock(policy);
    expect(block).toContain("<fix-policy>");
    expect(block).toContain("Approved libraries:");
    expect(block).toContain("- dompurify");
    expect(block).toContain("- kysely (version: ^0.27.0, purpose: SQL queries, note: Use parameterized queries)");
    expect(block).toContain("</fix-policy>");
  });

  it("formats forbidden patterns with reasons and alternatives", () => {
    const policy: FixPolicy = {
      forbiddenPatterns: [
        "eval",
        { pattern: "dangerouslySetInnerHTML", reason: "XSS risk", alternative: "DOMPurify.sanitize" },
      ],
    };
    const block = fixPolicyBlock(policy);
    expect(block).toContain("Forbidden patterns:");
    expect(block).toContain("- eval");
    expect(block).toContain("- dangerouslySetInnerHTML (reason: XSS risk, alternative: DOMPurify.sanitize)");
  });

  it("formats rules and policy notes", () => {
    const policy: FixPolicy = {
      rules: [
        "Never add new runtime dependencies without security team approval.",
        "Ensure all SQL statements use bind parameters.",
      ],
      notes: "Contact security@example.com for library approvals.",
    };
    const block = fixPolicyBlock(policy);
    expect(block).toContain("Policy rules:");
    expect(block).toContain("- Never add new runtime dependencies without security team approval.");
    expect(block).toContain("- Ensure all SQL statements use bind parameters.");
    expect(block).toContain("Notes: Contact security@example.com for library approvals.");
  });
});

describe("fixPrompt with policy", () => {
  it("omits policy block when no policy is provided", () => {
    const prompt = fixPrompt(sampleFinding, { tests: ["pnpm test"] });
    expect(prompt).not.toContain("<fix-policy>");
    expect(prompt).toContain("<finding>");
    expect(prompt).toContain("pnpm test");
  });

  it("injects fix policy block into the prompt before instructions", () => {
    const policy: FixPolicy = {
      approvedLibraries: ["kysely"],
      rules: ["Use parameterized queries"],
    };
    const prompt = fixPrompt(sampleFinding, { tests: ["pnpm test"], policy });
    expect(prompt).toContain("<fix-policy>");
    expect(prompt).toContain("Approved libraries:\n- kysely");
    expect(prompt).toContain("Policy rules:\n- Use parameterized queries");
    expect(prompt).toContain("Follow the organization's fix policy and approved library constraints.");
    expect(prompt).toContain("<finding>");
  });
});
