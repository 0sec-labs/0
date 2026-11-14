import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { osecDB } from "../storage/index.js";
import { ToolExecutor } from "./tools.js";
import type { ToolContext } from "./types.js";
import { normalizeFindingTitle, levenshtein, FUZZY_TITLE_DISTANCE_THRESHOLD } from "./tools-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createTestHarness() {
  const home = mkdtempSync(join(tmpdir(), "0-finding-dedupe-test-"));
  const db = new osecDB(join(home, "scan.db"));

  const createAgentSession = (scanId = "scan-root") => {
    try {
      db.createScan({ target: "https://target.test", depth: "default", format: "json" }, scanId);
    } catch {
      // Scan may already exist
    }
    const ctx = {
      target: "https://target.test",
      scanId,
      role: "attack",
      findings: [], // Each agent session has its own local in-memory findings array
      attackResults: [],
      targetInfo: {},
    } as unknown as ToolContext;
    return new ToolExecutor(ctx, db);
  };

  cleanups.push(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  return { db, createAgentSession };
}

describe("Cross-session finding deduplication (Candidate 1 remediation)", () => {
  it("keeps findings with similar titles on different endpoints separate", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    // Title 1 vs Title 2 Levenshtein distance is <= 5:
    // "sql injection in apiusers" vs "sql injection in apiorders" is distance 3
    const title1 = "SQL Injection in /api/users";
    const title2 = "SQL Injection in /api/orders";
    expect(levenshtein(normalizeFindingTitle(title1), normalizeFindingTitle(title2)))
      .toBeLessThanOrEqual(FUZZY_TITLE_DISTANCE_THRESHOLD);

    // Agent 1 saves vulnerability on /api/users
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: title1,
        severity: "critical",
        category: "sql-injection",
        description: "SQLi in users endpoint",
        evidence_request: "GET /api/users?search=admin'-- HTTP/1.1\r\nHost: target.test",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;
    expect(id1).toBeDefined();

    // Agent 2 saves distinct vulnerability on /api/orders
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: title2,
        severity: "high",
        category: "sql-injection",
        description: "SQLi in orders endpoint",
        evidence_request: "GET /api/orders?filter=paid'-- HTTP/1.1\r\nHost: target.test",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\norders",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;
    expect(id2).toBeDefined();

    // In the broken implementation, Agent 2's finding is incorrectly merged into id1!
    // After our fix, they must remain distinct findings:
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with finding");

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all.map((f: any) => f.title).sort()).toEqual([title2, title1].sort());
  });

  it("keeps findings in different vulnerability categories separate even with identical titles and endpoints", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const sharedRequest = "POST /api/profile HTTP/1.1\r\nHost: target.test\r\n\r\n{\"data\":\"test\"}";

    // Agent 1 reports SQL injection
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: "Vulnerability in profile endpoint",
        severity: "critical",
        category: "sql-injection",
        description: "SQL injection via JSON parameter",
        evidence_request: sharedRequest,
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nSQL error",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2 reports Stored XSS on the same endpoint
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: "Vulnerability in profile endpoint",
        severity: "medium",
        category: "xss",
        description: "Stored XSS in user profile",
        evidence_request: sharedRequest,
        evidence_response: "HTTP/1.1 200 OK\r\n\r\n<script>alert(1)</script>",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // In the broken implementation, Agent 2's finding is incorrectly merged into id1!
    // After our fix, category difference (sql-injection vs xss) prevents deduplication:
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with finding");

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all.map((f: any) => f.category).sort()).toEqual(["sql-injection", "xss"].sort());
  });

  it("deduplicates findings on the same endpoint with compatible evidence and fuzzy title match", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const sharedRequest = "GET /api/v1/users?search=admin'-- HTTP/1.1\r\nHost: target.test\r\nAccept: application/json";

    // Agent 1 saves finding
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: "SQL Injection in /api/v1/users",
        severity: "critical",
        category: "sql-injection",
        description: "SQL injection in search parameter",
        evidence_request: sharedRequest,
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2 reports the same vulnerability with slight title variation
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: "SQL injection in /api/v1/users.json",
        severity: "high",
        category: "sql-injection",
        description: "Duplicate report of users search SQLi",
        evidence_request: sharedRequest,
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // Genuine duplicate should merge into id1!
    expect(id2).toBe(id1);
    expect((res2.output as any).message).toContain(`merged with finding ${id1}`);

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(id1);
  });

  it("does not fuzzy-merge unrelated findings when evidence is missing or empty", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    // Titles with distance <= 5 ("user" vs "auth" is 4 edits)
    const title1 = "Information disclosure in user configuration";
    const title2 = "Information disclosure in auth configuration";
    expect(levenshtein(normalizeFindingTitle(title1), normalizeFindingTitle(title2)))
      .toBeLessThanOrEqual(FUZZY_TITLE_DISTANCE_THRESHOLD);

    // Agent 1 saves finding with no evidence_request
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: title1,
        severity: "medium",
        category: "information-disclosure",
        description: "Config file exposed",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2 saves finding with no evidence_request
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: title2,
        severity: "medium",
        category: "information-disclosure",
        description: "Auth settings exposed",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // In the broken implementation, both have empty evidence prefix and merge!
    // After our fix, without evidence anchor, fuzzy matching must NOT collapse them:
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with finding");

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
  });

  it("correctly handles multi-agent cross-session workflow with distinct and duplicate findings", async () => {
    const { db, createAgentSession } = createTestHarness();
    const subagentA = createAgentSession("subagent-a");
    const subagentB = createAgentSession("subagent-b");
    const subagentC = createAgentSession("subagent-c");

    // Subagent A finds command injection in ping tool
    const resA = await subagentA.execute({
      name: "save_finding",
      arguments: {
        title: "Command Injection in ping tool",
        severity: "critical",
        category: "command-injection",
        description: "Arbitrary command execution via host parameter",
        evidence_request: "POST /tools/ping HTTP/1.1\r\nHost: target.test\r\n\r\nhost=127.0.0.1;id",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nuid=0(root)",
      },
    });
    expect(resA.success).toBe(true);
    const idA = (resA.output as any).findingId;

    // Subagent B finds command injection in net tool (different endpoint, title distance <= 5)
    const resB = await subagentB.execute({
      name: "save_finding",
      arguments: {
        title: "Command Injection in net tool",
        severity: "critical",
        category: "command-injection",
        description: "Arbitrary command execution in network diagnostic tool",
        evidence_request: "POST /tools/net HTTP/1.1\r\nHost: target.test\r\n\r\nhost=127.0.0.1;id",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nuid=0(root)",
      },
    });
    expect(resB.success).toBe(true);
    const idB = (resB.output as any).findingId;

    // Subagent C finds true duplicate of Subagent A (same endpoint, similar title within distance 5)
    // "tool" vs "test" has edit distance 3 <= 5
    const resC = await subagentC.execute({
      name: "save_finding",
      arguments: {
        title: "Command Injection in ping test",
        severity: "critical",
        category: "command-injection",
        description: "Host param allows command chaining",
        evidence_request: "POST /tools/ping HTTP/1.1\r\nHost: target.test\r\n\r\nhost=127.0.0.1;id",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nuid=0(root)",
      },
    });
    expect(resC.success).toBe(true);
    const idC = (resC.output as any).findingId;

    // Subagent B's finding must be independent from A
    expect(idB).not.toBe(idA);
    // Subagent C's finding must merge into A
    expect(idC).toBe(idA);

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all.map((f: any) => f.id).sort()).toEqual([idA, idB].sort());
  });

  it("keeps findings with identical generic titles on different endpoints separate (cross-session)", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    // Both agents use the generic title "SQL Injection"
    const genericTitle = "SQL Injection";

    // Agent 1 saves finding on /api/users
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "SQLi in users",
        evidence_request: "GET /api/users?id=1'-- HTTP/1.1\r\nHost: target.test",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2 saves finding on /api/orders with the identical title
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "high",
        category: "sql-injection",
        description: "SQLi in orders",
        evidence_request: "GET /api/orders?id=1'-- HTTP/1.1\r\nHost: target.test",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\norder",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // In the broken implementation, exact title match fires before evidence check,
    // causing Agent 2's finding on /api/orders to be incorrectly merged into id1.
    // They must remain distinct findings:
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with finding");

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
  });

  it("keeps findings with identical generic titles on different endpoints separate (in-memory)", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent = createAgentSession("single-lane");

    const genericTitle = "SQL Injection";

    // Save on /api/users
    const res1 = await agent.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "SQLi in users",
        evidence_request: "GET /api/users?id=1'-- HTTP/1.1\r\nHost: target.test",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Save on /api/orders within the same agent session
    const res2 = await agent.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "high",
        category: "sql-injection",
        description: "SQLi in orders",
        evidence_request: "GET /api/orders?id=1'-- HTTP/1.1\r\nHost: target.test",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\norder",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // Must not merge in-memory when evidence prefixes conflict
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with existing finding");
  });

  it("keeps findings with identical generic titles and different HTTP methods separate", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const genericTitle = "Command Injection";

    // Agent 1: GET method
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "command-injection",
        description: "GET query param injection",
        evidence_request: "GET /api/exec?cmd=id HTTP/1.1\r\nHost: target.test",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nuid=0",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2: POST method on the same path
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "command-injection",
        description: "POST body injection",
        evidence_request: "POST /api/exec HTTP/1.1\r\nHost: target.test\r\n\r\ncmd=id",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nuid=0",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // Different methods have differing prefixes: must not merge
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with finding");

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
  });

  it("merges identical title when evidence prefix is identical (positive control)", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const genericTitle = "SQL Injection";
    const sharedRequest = "GET /api/v1/auth?user=admin'-- HTTP/1.1\r\nHost: target.test";

    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "First report",
        evidence_request: sharedRequest,
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "high",
        category: "sql-injection",
        description: "Second report on exact same endpoint",
        evidence_request: sharedRequest,
        evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // Must merge when title matches and evidence prefix matches
    expect(id2).toBe(id1);
    expect((res2.output as any).message).toContain(`merged with finding ${id1}`);

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(1);
  });

  it("does not merge an unclassified finding with a classified finding", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const sharedRequest = "GET /api/test HTTP/1.1\r\nHost: target.test";

    // Manually insert or save finding with empty category in DB
    const scanId = "lane-1";
    db.saveFinding(scanId, {
      id: "unclassified-finding-1",
      scanId,
      templateId: "tpl-1",
      title: "Vulnerability in test endpoint",
      description: "Generic finding",
      severity: "medium",
      category: "", // Empty category
      status: "discovered",
      timestamp: Date.now(),
      evidence: {
        request: sharedRequest,
        response: "HTTP/1.1 200 OK",
      },
    } as any);

    // Agent 2 reports finding with specific category "sql-injection"
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: "Vulnerability in test endpoint",
        severity: "critical",
        category: "sql-injection",
        description: "SQLi finding",
        evidence_request: sharedRequest,
        evidence_response: "HTTP/1.1 200 OK",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // Must NOT merge with empty/missing category row
    expect(id2).not.toBe("unclassified-finding-1");
    expect((res2.output as any).message).not.toContain("merged with finding unclassified-finding-1");
  });

  it("does not merge when existing evidence is empty and incoming evidence is concrete (cross-session)", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const genericTitle = "SQL Injection";

    // Agent 1: Saves generic finding with empty evidence request
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "Static hypothesis without request proof",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2: Saves finding with identical generic title but concrete endpoint evidence
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "Verified SQLi on orders endpoint",
        evidence_request: "POST /api/orders HTTP/1.1\r\nHost: target.test\r\n\r\norder_id=1'--",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\norder data",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // Must NOT merge into the empty-evidence finding (which would destroy concrete PoC evidence)
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with finding");

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
  });

  it("does not merge when existing evidence is empty and incoming evidence is concrete (in-memory)", async () => {
    const { createAgentSession } = createTestHarness();
    const agent = createAgentSession("single-lane");

    const genericTitle = "SQL Injection";

    // First save: no evidence
    const res1 = await agent.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "Initial hypothesis",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Second save: concrete evidence
    const res2 = await agent.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "Verified SQLi on orders endpoint",
        evidence_request: "POST /api/orders HTTP/1.1\r\nHost: target.test\r\n\r\norder_id=1'--",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\norder data",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // In-memory deduplication must not collapse concrete evidence into empty evidence
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with existing finding");
  });

  it("does not merge when existing evidence is concrete and incoming evidence is empty (cross-session)", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const genericTitle = "SQL Injection";

    // Agent 1: Saves finding with concrete endpoint evidence
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "Verified SQLi on orders endpoint",
        evidence_request: "POST /api/orders HTTP/1.1\r\nHost: target.test\r\n\r\norder_id=1'--",
        evidence_response: "HTTP/1.1 200 OK\r\n\r\norder data",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2: Saves finding with identical title but no evidence
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: genericTitle,
        severity: "critical",
        category: "sql-injection",
        description: "Unanchored hypothesis",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // Must NOT merge: an unanchored finding cannot be assumed identical to an endpoint-anchored finding
    expect(id2).not.toBe(id1);
    expect((res2.output as any).message).not.toContain("merged with finding");

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(2);
  });

  it("merges static findings with identical titles when both evidence prefixes are empty (positive control)", async () => {
    const { db, createAgentSession } = createTestHarness();
    const agent1 = createAgentSession("lane-1");
    const agent2 = createAgentSession("lane-2");

    const staticTitle = "Hardcoded Secret in settings.json";

    // Agent 1: Static finding with description only
    const res1 = await agent1.execute({
      name: "save_finding",
      arguments: {
        title: staticTitle,
        severity: "high",
        category: "information-disclosure",
        description: "API key found in repository config",
      },
    });
    expect(res1.success).toBe(true);
    const id1 = (res1.output as any).findingId;

    // Agent 2: Sibling lane also discovers the same static issue
    const res2 = await agent2.execute({
      name: "save_finding",
      arguments: {
        title: staticTitle,
        severity: "high",
        category: "information-disclosure",
        description: "Duplicate report of API key in settings.json",
      },
    });
    expect(res2.success).toBe(true);
    const id2 = (res2.output as any).findingId;

    // When both are empty and titles match exactly, they represent the same static finding and must merge
    expect(id2).toBe(id1);
    expect((res2.output as any).message).toContain(`merged with finding ${id1}`);

    const all = db.listFindings({ limit: 10 });
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(id1);
  });
});
