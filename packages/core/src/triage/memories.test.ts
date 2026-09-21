import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryStore,
  inferPackage,
  scoreMemory,
  type MemoryDbHandle,
  type MemoryScope,
  type TriageMemory,
} from "./memories.js";
import type { AttackCategory, Finding } from "@0/shared"
import { runStructuredVerify } from "./structured-verify.js";
import type { NativeRuntime } from "../runtime/types.js";

// ── In-memory fake DB handle ──

type Row = {
  id: string;
  scope: MemoryScope;
  scopeValue: string | null;
  category: string;
  pattern: string;
  reasoning: string;
  createdAt: number;
  appliedCount: number;
};

function createFakeDb(): MemoryDbHandle & { rows: Row[] } {
  const rows: Row[] = [];
  return {
    rows,
    insertTriageMemory(row) {
      rows.push({
        id: row.id,
        scope: row.scope,
        scopeValue: row.scopeValue ?? null,
        category: row.category,
        pattern: row.pattern,
        reasoning: row.reasoning,
        createdAt: row.createdAt,
        appliedCount: row.appliedCount ?? 0,
      });
    },
    listTriageMemories(opts) {
      return rows
        .filter((r) => (opts?.scope ? r.scope === opts.scope : true))
        .filter((r) => (opts?.scopeValue ? r.scopeValue === opts.scopeValue : true))
        .filter((r) => (opts?.category ? r.category === opts.category : true))
        .slice(0, opts?.limit ?? 500);
    },
    deleteTriageMemory(id) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) {
        rows.splice(idx, 1);
        return true;
      }
      return false;
    },
    incrementMemoryAppliedCount(id) {
      const row = rows.find((r) => r.id === id);
      if (row) row.appliedCount += 1;
    },
  };
}

// ── Finding factory ──

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-1",
    templateId: "audit-sink",
    title: "Reflected XSS in search endpoint",
    description:
      "The search parameter value is reflected in the HTML response without encoding, enabling reflected XSS.",
    severity: "high",
    category: "xss" as AttackCategory,
    status: "discovered",
    evidence: {
      request: "GET /search?q=<script>alert(1)</script> HTTP/1.1",
      response: "HTTP/1.1 200 OK\n\n<html><body>results for <script>alert(1)</script></body></html>",
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

it("scan-local context excludes persisted global history, including an empty admitted context", async () => {
  const db = createFakeDb();
  const finding = makeFinding();
  const memory: TriageMemory = {
    id: "cloud:reviewed", scope: "target", scopeValue: "/workspace/repo",
    category: finding.category, pattern: finding.title, reasoning: "Check the current content type.",
    createdAt: 1, appliedCount: 0,
  };
  db.insertTriageMemory({ ...memory, id: "local:unrelated", scope: "global", scopeValue: null });
  const contextual = new MemoryStore(db, { contextMemories: [memory] });
  expect((await contextual.getRelevantMemories(finding, "/workspace/repo")).map(row => row.id))
    .toEqual(["cloud:reviewed"]);
  expect(await new MemoryStore(db, { contextMemories: [] }).getRelevantMemories(finding, "/workspace/repo"))
    .toEqual([]);
});

describe("inferPackage", () => {
  it("extracts host from http URLs", () => {
    expect(inferPackage("https://api.example.com/v1/users")).toBe("api.example.com");
  });

  it("extracts first path segment for filesystem targets", () => {
    expect(inferPackage("/github.com/acme/widgets")).toBe("github.com");
  });

  it("lowercases package identifiers", () => {
    expect(inferPackage("MyPackage")).toBe("mypackage");
  });
});

describe("scoreMemory", () => {
  it("awards a category-match boost", () => {
    const finding = makeFinding();
    const same: TriageMemory = {
      id: "m",
      scope: "global",
      category: "xss",
      pattern: "Reflected XSS in search endpoint",
      reasoning: "The response Content-Type is text/plain so the script cannot execute.",
      createdAt: 0,
      appliedCount: 0,
    };
    const diff: TriageMemory = { ...same, category: "sql-injection" };
    expect(scoreMemory(same, finding)).toBeGreaterThan(scoreMemory(diff, finding));
  });

  it("returns zero for unrelated content", () => {
    const finding = makeFinding();
    const unrelated: TriageMemory = {
      id: "m",
      scope: "global",
      category: "xss",
      pattern: "qqqqq zzzzz vvvvv",
      reasoning: "wwwww yyyyy kkkkk",
      createdAt: 0,
      appliedCount: 0,
    };
    // Category boost still applies even with zero token overlap, so make
    // the category different as well to isolate the text signal.
    const strangerNoCategory: TriageMemory = { ...unrelated, category: "ssrf" };
    expect(scoreMemory(strangerNoCategory, finding)).toBe(0);
  });
});

describe("MemoryStore", () => {
  let db: ReturnType<typeof createFakeDb>;
  let store: MemoryStore;

  beforeEach(() => {
    db = createFakeDb();
    store = new MemoryStore(db);
  });

  it("records an FP memory", async () => {
    const finding = makeFinding();
    const memory = await store.recordFp(
      finding,
      "Search page has CSP that blocks inline script execution.",
      "target",
      "https://example.com",
    );
    expect(memory.category).toBe("xss");
    expect(memory.scope).toBe("target");
    expect(memory.scopeValue).toBe("https://example.com");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.reasoning).toContain("CSP");
  });

  it("omits scopeValue for global scope", async () => {
    const finding = makeFinding();
    const memory = await store.recordFp(finding, "Demo app, always FP.", "global");
    expect(memory.scopeValue).toBeUndefined();
    expect(db.rows[0]!.scopeValue).toBeNull();
  });

  it("returns relevant memories filtered by scope and sorted by score", async () => {
    const finding = makeFinding();
    await store.recordFp(finding, "reflected but CSP blocks", "global");
    await store.recordFp(finding, "different target entirely", "target", "https://other.com");
    await store.recordFp(finding, "reflected xss but encoded", "target", "https://example.com");

    const memories = await store.getRelevantMemories(finding, "https://example.com");
    // The "other.com" memory must be filtered out by scope.
    expect(memories.map((m) => m.scope + ":" + (m.scopeValue ?? ""))).not.toContain(
      "target:https://other.com",
    );
    expect(memories.length).toBeGreaterThanOrEqual(2);
  });

  it("respects package scope via inferPackage", async () => {
    const finding = makeFinding();
    await store.recordFp(finding, "known FP on this host", "package", "example.com");
    await store.recordFp(finding, "unrelated host memory", "package", "evil.com");

    const memories = await store.getRelevantMemories(finding, "https://example.com/search");
    expect(memories).toHaveLength(1);
    expect(memories[0]!.scopeValue).toBe("example.com");
  });

  it("filters out memories from different categories", async () => {
    const finding = makeFinding();
    const sqlFinding = makeFinding({ category: "sql-injection" as AttackCategory });
    await store.recordFp(sqlFinding, "sql injection FP", "global");
    await store.recordFp(finding, "xss FP", "global");

    const memories = await store.getRelevantMemories(finding, "https://example.com");
    expect(memories.every((m) => m.category === "xss")).toBe(true);
  });

  it("does not let an exact historical false-positive match dismiss independently confirmed evidence", async () => {
    const finding = makeFinding({ evidence: {} });
    const historicalReason = "Prior deployment required a separate access check; reassess the current evidence.";
    await store.recordFp(finding, historicalReason, "target", "https://example.test");
    const runtime: NativeRuntime = {
      type: "api",
      async isAvailable() { return true; },
      async executeNative(systemPrompt, messages) {
        expect(systemPrompt).not.toContain(historicalReason);
        expect(messages.flatMap(message => message.content)
          .some(block => block.type === "text" && block.text.includes(historicalReason))).toBe(true);
        return {
          content: [{ type: "text", text: JSON.stringify({
            passed: true, confidence: 0.95, reasoning: "The current response contains the independently reproduced exploit.",
          }) }],
          stopReason: "end_turn", durationMs: 1,
        };
      },
    };
    const result = await runStructuredVerify(finding, "https://example.test", runtime, { memoryStore: store });
    expect(result.verdict).toBe("confirmed");
  });


  it("returns empty string when no memories to format", async () => {
    expect(await store.formatForPrompt([])).toBe("");
  });


  it("increments appliedCount via recordApplied", async () => {
    const finding = makeFinding();
    const memory = await store.recordFp(finding, "foo", "global");
    await store.recordApplied(memory.id);
    await store.recordApplied(memory.id);
    const listed = await store.listAll();
    expect(listed[0]!.appliedCount).toBe(2);
  });

  it("removes memories by id", async () => {
    const finding = makeFinding();
    const memory = await store.recordFp(finding, "foo", "global");
    expect(await store.remove(memory.id)).toBe(true);
    expect(await store.remove("does-not-exist")).toBe(false);
    expect(db.rows).toHaveLength(0);
  });
});
