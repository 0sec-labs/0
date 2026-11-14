import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { osecDB } from "../storage/index.js";
import type { Finding } from "../shared/index.js";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
import type { ToolContext } from "./types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function createHarness(
  childCallsFactory?: (agentIndex: number) => Array<{ name: string; input: Record<string, unknown> }>,
  overrides: Partial<ToolContext> = {},
) {
  const home = mkdtempSync(join(tmpdir(), "0-lifecycle-test-"));
  const db = new osecDB(join(home, "engagement.db"));
  const rootScanId = "root-scan";
  db.createScan({ target: "https://target.test", depth: "default", format: "json" }, rootScanId);

  const context: ToolContext = {
    target: "https://target.test",
    scanId: rootScanId,
    role: "attack",
    consoleSession: true,
    findings: [],
    attackResults: [],
    targetInfo: {},
    autonomyMode: "yolo",
    delegationTools: [
      TOOL_DEFINITIONS.save_finding,
      TOOL_DEFINITIONS.update_finding,
      TOOL_DEFINITIONS.spawn_agent,
      TOOL_DEFINITIONS.spawn_agents,
      TOOL_DEFINITIONS.done,
    ],
    agentMessaging: {
      selfId: "Main",
      selfRole: "parent",
      siblingChannelEnabled: true,
      operatorChannelEnabled: false,
      projectPath: home,
      homeDir: home,
    },
    ...overrides,
  };

  let agentCount = 0;
  const factory = async (): Promise<NativeRuntime> => {
    const currentAgentIndex = agentCount++;
    const calls = childCallsFactory
      ? [...childCallsFactory(currentAgentIndex)]
      : [{ name: "done", input: { summary: "No-op subagent complete" } }];

    return {
      type: "api",
      isAvailable: async () => true,
      forkForSubagent: factory,
      executeNative: async (): Promise<NativeRuntimeResult> => {
        const call = calls.shift();
        if (!call) {
          return {
            content: [{ type: "tool_use", id: `done-${Date.now()}`, name: "done", input: { summary: "Finished" } }],
            stopReason: "tool_use",
            durationMs: 0,
          };
        }
        return {
          content: [{ type: "tool_use", id: `call-${calls.length}-${Date.now()}`, ...call }],
          stopReason: "tool_use",
          durationMs: 0,
        };
      },
    };
  };

  const tools = new ToolExecutor(context, db, undefined, factory);
  cleanups.push(async () => {
    await tools.cleanup();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  return { tools, db, context, home };
}

describe("Delegated finding lifecycle integrity", () => {
  describe("Defect A: Delegated Finding Deduplication", () => {
    it("1. parent finding followed by identical child finding: one SQLite row and one parent-memory entry", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "SQL Injection in User Search",
            severity: "critical",
            category: "sql-injection",
            description: "Child rediscovered SQLi",
            evidence_request: "GET /api/users?search=1' OR 1=1--",
            evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
          },
        },
        { name: "done", input: { summary: "Audit complete" } },
      ]);

      // Parent saves first
      const parentSave = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "SQL Injection in User Search",
          severity: "critical",
          category: "sql-injection",
          description: "Parent found SQLi",
          evidence_request: "GET /api/users?search=1' OR 1=1--",
          evidence_response: "HTTP/1.1 200 OK\r\n\r\nadmin",
        },
      });
      expect(parentSave.success).toBe(true);
      const parentFindingId = context.findings[0].id;
      expect(parentFindingId).toBeDefined();

      // Child runs and attempts to save the same finding
      const spawnResult = await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Audit users endpoint" , wait: true },
      });
      expect(spawnResult.success).toBe(true);

      // Verify SQLite has only 1 row
      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(parentFindingId);

      // Verify parent memory has only 1 finding
      expect(context.findings).toHaveLength(1);
      expect(context.findings[0].id).toBe(parentFindingId);
    });

    it("2. parent finding followed by fuzzy duplicate with matching evidence: one canonical finding", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            // "SQL Injection in /api/users.php" vs "SQL Injection in /api/users" is Levenshtein 4 <= 5
            title: "SQL Injection in /api/users.php",
            severity: "critical",
            category: "sql-injection",
            description: "Child formulation",
            evidence_request: "GET /api/users?id=1'--",
            evidence_response: "admin",
          },
        },
        { name: "done", input: { summary: "Complete" } },
      ]);

      const parentSave = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "SQL Injection in /api/users",
          severity: "critical",
          category: "sql-injection",
          description: "Original finding",
          evidence_request: "GET /api/users?id=1'--",
          evidence_response: "admin",
        },
      });
      expect(parentSave.success).toBe(true);
      const canonicalId = context.findings[0].id;

      await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Fuzzy check" , wait: true },
      });

      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(canonicalId);
      expect(rows[0].title).toBe("SQL Injection in /api/users");
      expect(context.findings).toHaveLength(1);
      expect(context.findings[0].id).toBe(canonicalId);
    });

    it("3. two children independently discover the same finding: one canonical finding", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "Cross-Site Scripting in Guestbook",
            severity: "high",
            category: "xss",
            description: "Stored XSS in message parameter",
            evidence_request: "POST /api/guestbook HTTP/1.1\r\n\r\nmessage=<script>alert(1)</script>",
            evidence_response: "<script>alert(1)</script>",
          },
        },
        { name: "done", input: { summary: "Worker done" } },
      ]);

      const spawnResult = await tools.execute({
        name: "spawn_agents",
        arguments: {
          tasks: [
            { task: "Worker 1: Audit guestbook POST parameters" },
            { task: "Worker 2: Audit guestbook stored messages" },
          ],
        },
      });
      expect(spawnResult.success).toBe(true);

      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Cross-Site Scripting in Guestbook");
      expect(context.findings).toHaveLength(1);
    });

    it("4. similar titles with different endpoints: remain separate", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "SQL Injection in /api/orders",
            severity: "high",
            category: "sql-injection",
            description: "Orders SQLi",
            evidence_request: "GET /api/orders?filter=paid'--",
            evidence_response: "orders data",
          },
        },
        { name: "done", input: { summary: "Orders audit complete" } },
      ]);

      await tools.execute({
        name: "save_finding",
        arguments: {
          title: "SQL Injection in /api/users",
          severity: "high",
          category: "sql-injection",
          description: "Users SQLi",
          evidence_request: "GET /api/users?search=admin'--",
          evidence_response: "users data",
        },
      });

      await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Audit orders" , wait: true },
      });

      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(2);
      expect(context.findings).toHaveLength(2);
      expect(rows.map((r: any) => r.title).sort()).toEqual([
        "SQL Injection in /api/orders",
        "SQL Injection in /api/users",
      ]);
    });

    it("5. different categories: remain separate", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "Vulnerability in profile endpoint",
            severity: "high",
            category: "xss",
            description: "XSS on profile",
            evidence_request: "POST /api/profile HTTP/1.1\r\n\r\nname=<script>",
            evidence_response: "saved",
          },
        },
        { name: "done", input: { summary: "Done" } },
      ]);

      await tools.execute({
        name: "save_finding",
        arguments: {
          title: "Vulnerability in profile endpoint",
          severity: "high",
          category: "sql-injection",
          description: "SQLi on profile",
          evidence_request: "POST /api/profile HTTP/1.1\r\n\r\nname=<script>",
          evidence_response: "saved",
        },
      });

      await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Audit profile XSS" , wait: true },
      });

      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(2);
      expect(context.findings).toHaveLength(2);
      expect(rows.map((r: any) => r.category).sort()).toEqual(["sql-injection", "xss"]);
    });

    it("6. different HTTP methods: remain separate", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "CSRF in profile endpoint",
            severity: "medium",
            category: "csrf",
            description: "POST method vulnerability",
            evidence_request: "POST /api/profile HTTP/1.1\r\nHost: target.test",
            evidence_response: "ok",
          },
        },
        { name: "done", input: { summary: "Done" } },
      ]);

      await tools.execute({
        name: "save_finding",
        arguments: {
          title: "CSRF in profile endpoint",
          severity: "medium",
          category: "csrf",
          description: "GET method vulnerability",
          evidence_request: "GET /api/profile HTTP/1.1\r\nHost: target.test",
          evidence_response: "ok",
        },
      });

      await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Inspect POST method" , wait: true },
      });

      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(2);
      expect(context.findings).toHaveLength(2);
    });

    it("7. empty evidence must not fuzzy-merge unrelated findings", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "SQL Injection in search",
            severity: "high",
            category: "sql-injection",
            description: "No evidence provided",
          },
        },
        { name: "done", input: { summary: "Done" } },
      ]);

      await tools.execute({
        name: "save_finding",
        arguments: {
          title: "SQL Injection in orders",
          severity: "high",
          category: "sql-injection",
          description: "No evidence provided",
        },
      });

      await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Search check" , wait: true },
      });

      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(2);
      expect(context.findings).toHaveLength(2);
    });

    it("8. finding already in SQLite but absent from parent memory: no duplicate insertion", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "SSRF in Webhook Delivery",
            severity: "critical",
            category: "ssrf",
            description: "Child discovers webhook SSRF",
            evidence_request: "POST /api/webhook HTTP/1.1\r\nHost: target.test\r\n\r\nurl=http://169.254.169.254",
            evidence_response: "ami-id",
          },
        },
        { name: "done", input: { summary: "Done" } },
      ]);

      // Seed SQLite directly with a finding from another scan session
      db.createScan({ target: "https://target.test", depth: "default", format: "json" }, "other-session");
      db.saveFinding("other-session", {
        id: "persisted-prior-ssrf",
        templateId: "ssrf-1",
        title: "SSRF in Webhook Delivery",
        description: "Prior scan SSRF",
        severity: "critical",
        category: "ssrf",
        status: "discovered",
        timestamp: Date.now(),
        evidence: {
          request: "POST /api/webhook HTTP/1.1\r\nHost: target.test\r\n\r\nurl=http://169.254.169.254",
          response: "ami-id",
        },
      } as Finding);

      // Parent memory does NOT have it
      expect(context.findings).toHaveLength(0);
      expect(db.listFindings({ limit: 10 })).toHaveLength(1);

      // Child discovers the same finding
      await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Audit webhooks" , wait: true },
      });

      // Total findings in SQLite must remain exactly 1 (no duplicate inserted)
      const allRows = db.listFindings({ limit: 10 });
      expect(allRows).toHaveLength(1);
      expect(allRows[0].id).toBe("persisted-prior-ssrf");

      // Parent memory should NOT receive a duplicate finding
      expect(context.findings).toHaveLength(0);
    });

    it("9. finding in parent memory but not SQLite: no duplicate memory entry", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "Prototype Pollution in Merge",
            severity: "high",
            category: "prototype-pollution",
            description: "Child finds pollution",
            evidence_request: "POST /api/merge\r\n{\"__proto__\":{}}",
            evidence_response: "polluted",
          },
        },
        { name: "done", input: { summary: "Done" } },
      ], {
        // Explicitly disable DB persistence on root context
        persistFindings: false,
      });

      // Parent manually has finding in memory
      context.findings.push({
        id: "mem-proto-1",
        templateId: "proto",
        title: "Prototype Pollution in Merge",
        description: "Parent in-memory",
        severity: "high",
        category: "prototype-pollution",
        status: "discovered",
        timestamp: Date.now(),
        evidence: { request: "POST /api/merge\r\n{\"__proto__\":{}}" },
      });

      await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Inspect merge" , wait: true },
      });

      // No SQLite records
      expect(db.listFindings({ limit: 10 })).toHaveLength(0);
      // Memory must remain deduplicated
      expect(context.findings).toHaveLength(1);
      expect(context.findings[0].id).toBe("mem-proto-1");
    });

    it("10. distinct child findings in one batch: all retained", async () => {
      const { tools, db, context } = createHarness((index) => [
        {
          name: "save_finding",
          input: {
            title: `Batch Finding ${index}`,
            severity: "medium",
            category: "information-disclosure",
            description: `Batch finding from worker ${index}`,
            evidence_request: `GET /endpoint/${index}`,
            evidence_response: `data ${index}`,
          },
        },
        { name: "done", input: { summary: "Worker complete" } },
      ]);

      const result = await tools.execute({
        name: "spawn_agents",
        arguments: {
          tasks: [
            { task: "Audit endpoint 0" },
            { task: "Audit endpoint 1" },
            { task: "Audit endpoint 2" },
          ],
        },
      });
      expect(result.success).toBe(true);

      const rows = db.listFindings({ limit: 10 });
      expect(rows).toHaveLength(3);
      expect(context.findings).toHaveLength(3);
    });
  });

  describe("Defect B: Delegated update_finding", () => {
    it("1. child updates a parent-owned finding to confirmed: parent memory and SQLite both change", async () => {
      let findingIdToUpdate = "";
      const { tools, db, context } = createHarness(() => [
        {
          name: "update_finding",
          input: {
            finding_id: findingIdToUpdate,
            status: "confirmed",
          },
        },
        { name: "done", input: { summary: "Verification complete" } },
      ]);

      // Parent saves finding initially in "discovered" status
      const saveRes = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "SQL Injection in Login",
          severity: "critical",
          category: "sql-injection",
          description: "Unconfirmed finding",
          evidence_request: "POST /login HTTP/1.1\r\n\r\nuser=admin'--",
          evidence_response: "200 OK",
        },
      });
      expect(saveRes.success).toBe(true);
      findingIdToUpdate = context.findings[0].id;
      expect(findingIdToUpdate).toBeDefined();

      // Verify initial state
      expect(context.findings[0].status).toBe("discovered");
      expect(db.getFinding(findingIdToUpdate)?.status).toBe("discovered");

      // Spawn child verifier agent
      const spawnResult = await tools.execute({
        name: "spawn_agent",
        arguments: { task: `Verify finding ${findingIdToUpdate}`, wait: true },
      });
      expect(spawnResult.success).toBe(true);

      // Both SQLite and parent memory must now be "confirmed"
      expect(db.getFinding(findingIdToUpdate)?.status).toBe("confirmed");
      expect(context.findings[0].status).toBe("confirmed");
    });

    it("2. child updates a parent-owned finding to false-positive: both representations change", async () => {
      let findingIdToUpdate = "";
      const { tools, db, context } = createHarness(() => [
        {
          name: "update_finding",
          input: {
            finding_id: findingIdToUpdate,
            status: "false-positive",
          },
        },
        { name: "done", input: { summary: "Verification ruled out vulnerability" } },
      ]);

      const saveRes = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "Suspected XSS in Comments",
          severity: "medium",
          category: "xss",
          description: "Needs verification",
          evidence_request: "POST /comment",
          evidence_response: "encoded &lt;script&gt;",
        },
      });
      expect(saveRes.success).toBe(true);
      findingIdToUpdate = context.findings[0].id;

      await tools.execute({
        name: "spawn_agent",
        arguments: { task: `Replay XSS ${findingIdToUpdate}`, wait: true },
      });

      expect(db.getFinding(findingIdToUpdate)?.status).toBe("false-positive");
      expect(context.findings[0].status).toBe("false-positive");
    });

    it("3. child attempts to update a nonexistent ID: explicit failure", async () => {
      const childContext: ToolContext = {
        target: "https://target.test",
        scanId: "child-standalone",
        findings: [],
        attackResults: [],
        targetInfo: {},
        updateDelegatedFinding: (id, status) => {
          return { success: false, error: `Finding not found: ${id}` };
        },
      };

      const child = new ToolExecutor(childContext);
      try {
        const result = await child.execute({
          name: "update_finding",
          arguments: {
            finding_id: "00000000-0000-0000-0000-000000000000",
            status: "confirmed",
          },
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Finding not found: 00000000-0000-0000-0000-000000000000");
      } finally {
        await child.cleanup();
      }
    });

    it("4. child has no delegated update handler: explicit failure", async () => {
      const childContext: ToolContext = {
        target: "https://target.test",
        scanId: "child-standalone",
        findings: [],
        attackResults: [],
        targetInfo: {},
        // No updateDelegatedFinding and no db
      };

      const child = new ToolExecutor(childContext);
      try {
        const result = await child.execute({
          name: "update_finding",
          arguments: {
            finding_id: "nonexistent-id",
            status: "confirmed",
          },
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Finding not found: nonexistent-id");
      } finally {
        await child.cleanup();
      }
    });

    it("5. parent updates a locally owned finding: existing behavior preserved", async () => {
      const { tools, db, context } = createHarness();

      const saveRes = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "Direct Parent Finding",
          severity: "low",
          category: "security-misconfiguration",
          description: "Headers missing",
          evidence_request: "GET /",
          evidence_response: "headers",
        },
      });
      const findingId = context.findings[0].id;

      const updateRes = await tools.execute({
        name: "update_finding",
        arguments: { finding_id: findingId, status: "confirmed" },
      });

      expect(updateRes.success).toBe(true);
      expect(context.findings[0].status).toBe("confirmed");
      expect(db.getFinding(findingId)?.status).toBe("confirmed");
    });

    it("6. database update failure: tool does not report success", async () => {
      const { tools, db, context } = createHarness();

      const saveRes = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "DB Error Finding",
          severity: "low",
          category: "security-misconfiguration",
          description: "Test",
          evidence_request: "GET /test",
          evidence_response: "test",
        },
      });
      const findingId = context.findings[0].id;

      vi.spyOn(db, "updateFindingStatus").mockImplementationOnce(() => {
        throw new Error("Disk I/O error");
      });

      const updateRes = await tools.execute({
        name: "update_finding",
        arguments: { finding_id: findingId, status: "confirmed" },
      });

      expect(updateRes.success).toBe(false);
      expect(updateRes.error).toContain("Disk I/O error");
    });

    it("7. child updates a finding it owns locally: existing behavior preserved", async () => {
      const localFinding: Finding = {
        id: "child-local-1",
        templateId: "tpl-1",
        title: "Child Local Finding",
        description: "Local description",
        severity: "medium",
        category: "xss",
        status: "discovered",
        timestamp: Date.now(),
        evidence: { request: "GET /local" },
      };

      let delegatedCalled = false;
      const childContext: ToolContext = {
        target: "https://target.test",
        scanId: "child-1",
        findings: [localFinding],
        attackResults: [],
        targetInfo: {},
        updateDelegatedFinding: (id, status) => {
          delegatedCalled = true;
          return { success: true, message: `Updated ${id}` };
        },
      };

      const child = new ToolExecutor(childContext);
      try {
        const res = await child.execute({
          name: "update_finding",
          arguments: { finding_id: "child-local-1", status: "confirmed" },
        });

        expect(res.success).toBe(true);
        expect(localFinding.status).toBe("confirmed");
        expect(delegatedCalled).toBe(true);
      } finally {
        await child.cleanup();
      }
    });

    it("8. child updates a locally cached finding when delegated update fails: reports failure and preserves original status in memory", async () => {
      const localFinding: Finding = {
        id: "child-local-fail",
        templateId: "tpl-1",
        title: "Child Local Finding",
        description: "Local description",
        severity: "medium",
        category: "xss",
        status: "discovered",
        timestamp: Date.now(),
        evidence: { request: "GET /local" },
      };

      const childContext: ToolContext = {
        target: "https://target.test",
        scanId: "child-1",
        findings: [localFinding],
        attackResults: [],
        targetInfo: {},
        updateDelegatedFinding: (id, status) => {
          return { success: false, error: "Database lock conflict" };
        },
      };

      const child = new ToolExecutor(childContext);
      try {
        const res = await child.execute({
          name: "update_finding",
          arguments: { finding_id: "child-local-fail", status: "confirmed" },
        });

        expect(res.success).toBe(false);
        expect(res.error).toBe("Database lock conflict");
        expect(localFinding.status).toBe("discovered");
      } finally {
        await child.cleanup();
      }
    });
  });

  describe("Integration: Full Multi-Agent Finding Lifecycle", () => {
    it("exercises discovery -> subagent deduplication -> subagent verification in real orchestration path", async () => {
      let parentFindingId = "";

      // Child 1 (discovery worker): finds duplicate of parent finding
      // Child 2 (verification worker): confirms parent finding
      const { tools, db, context } = createHarness((agentIndex) => {
        if (agentIndex === 0) {
          return [
            {
              name: "save_finding",
              input: {
                title: "Blind SQL Injection in /api/auth",
                severity: "critical",
                category: "sql-injection",
                description: "Duplicate discovery by child 1",
                evidence_request: "POST /api/auth HTTP/1.1\r\n\r\nuser=admin' AND (SELECT 1 FROM (SELECT SLEEP(5))a)--",
                evidence_response: "5000ms delay",
              },
            },
            { name: "done", input: { summary: "Discovery done" } },
          ];
        } else {
          return [
            {
              name: "update_finding",
              input: {
                finding_id: parentFindingId,
                status: "confirmed",
              },
            },
            { name: "done", input: { summary: "Verification done" } },
          ];
        }
      });

      // 1. Parent saves initial finding
      const parentSave = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "Blind SQL Injection in /api/auth",
          severity: "critical",
          category: "sql-injection",
          description: "Parent discovered finding",
          evidence_request: "POST /api/auth HTTP/1.1\r\n\r\nuser=admin' AND (SELECT 1 FROM (SELECT SLEEP(5))a)--",
          evidence_response: "5000ms delay",
        },
      });
      expect(parentSave.success).toBe(true);
      parentFindingId = context.findings[0].id;
      expect(parentFindingId).toBeDefined();

      // 2. Child 1 spawns and attempts duplicate save
      const child1Result = await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Run blind SQLi discovery" , wait: true },
      });
      expect(child1Result.success).toBe(true);

      // Verify deduplication: still 1 row in SQLite, 1 in memory
      expect(db.listFindings({ limit: 10 })).toHaveLength(1);
      expect(context.findings).toHaveLength(1);
      expect(context.findings[0].id).toBe(parentFindingId);
      expect(context.findings[0].status).toBe("discovered");

      // 3. Child 2 spawns and updates status to confirmed
      const child2Result = await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Verify blind SQLi with out-of-band replay" , wait: true },
      });
      expect(child2Result.success).toBe(true);

      // Verify mutation: row status in DB and memory is confirmed
      const finalDbRows = db.listFindings({ limit: 10 });
      expect(finalDbRows).toHaveLength(1);
      expect(finalDbRows[0].id).toBe(parentFindingId);
      expect(finalDbRows[0].status).toBe("confirmed");

      expect(context.findings).toHaveLength(1);
      expect(context.findings[0].id).toBe(parentFindingId);
      expect(context.findings[0].status).toBe("confirmed");
    });
  });

  describe("Hardening: Failure conditions and boundary contracts", () => {
    it("rejects delegated finding persistence when deduplication lookup fails, avoiding duplicate insertion", async () => {
      const { tools, db, context } = createHarness(() => [
        {
          name: "save_finding",
          input: {
            title: "Command Injection in Export",
            severity: "critical",
            category: "command-injection",
            description: "Child finding",
            evidence_request: "POST /export?format=$(id)",
            evidence_response: "uid=0",
          },
        },
        { name: "done", input: { summary: "Done" } },
      ]);

      vi.spyOn(db, "listFindings").mockImplementationOnce(() => {
        throw new Error("SQLite table locked during deduplication lookup");
      });

      const spawnRes = await tools.execute({
        name: "spawn_agent",
        arguments: { task: "Test lookup failure", wait: true },
      });
      expect(spawnRes.success).toBe(true);

      // Verify no duplicate/unverified rows survived in SQLite or parent memory
      expect(db.listFindings({ limit: 10 })).toHaveLength(0);
      expect(context.findings).toHaveLength(0);
    });

    it("atomic status update: failed database write leaves parent memory unchanged", async () => {
      const { tools, db, context } = createHarness();

      const saveRes = await tools.execute({
        name: "save_finding",
        arguments: {
          title: "Memory Safety Bug in Buffer",
          severity: "high",
          category: "heap-overflow",
          description: "Initial discovery",
          evidence_request: "POST /buffer",
          evidence_response: "crash",
        },
      });
      const findingId = context.findings[0].id;
      expect(context.findings[0].status).toBe("discovered");
      expect(db.getFinding(findingId)?.status).toBe("discovered");

      // Mock DB update to throw
      vi.spyOn(db, "updateFindingStatus").mockImplementationOnce(() => {
        throw new Error("Disk quota exceeded during update");
      });

      const updateRes = await tools.execute({
        name: "update_finding",
        arguments: { finding_id: findingId, status: "confirmed" },
      });

      expect(updateRes.success).toBe(false);
      expect(updateRes.error).toContain("Disk quota exceeded during update");

      // Atomicity check: parent memory must remain discovered, matching SQLite
      expect(context.findings[0].status).toBe("discovered");
      expect(db.getFinding(findingId)?.status).toBe("discovered");
    });

    it("status update rejects nonexistent database records when persistence is active", async () => {
      const { tools, db, context } = createHarness();

      // Put a phantom finding in memory that does NOT exist in SQLite
      context.findings.push({
        id: "phantom-unpersisted-id",
        templateId: "manual",
        title: "Phantom Finding",
        description: "Not in DB",
        severity: "medium",
        category: "xss",
        status: "discovered",
        timestamp: Date.now(),
        evidence: { request: "GET /phantom" },
      });

      expect(db.getFinding("phantom-unpersisted-id")).toBeUndefined();

      const updateRes = await tools.execute({
        name: "update_finding",
        arguments: { finding_id: "phantom-unpersisted-id", status: "confirmed" },
      });

      expect(updateRes.success).toBe(false);
      expect(updateRes.error).toContain("Finding not found: phantom-unpersisted-id");
      // Memory must not falsely report confirmed
      expect(context.findings.find(f => f.id === "phantom-unpersisted-id")?.status).toBe("discovered");
    });

    it("preserves local-only status update when persistence is intentionally disabled", async () => {
      const { tools, db, context } = createHarness(undefined, { persistFindings: false });

      context.findings.push({
        id: "local-only-id",
        templateId: "manual",
        title: "Local Only Finding",
        description: "Memory only",
        severity: "low",
        category: "information-disclosure",
        status: "discovered",
        timestamp: Date.now(),
        evidence: { request: "GET /local" },
      });

      const updateRes = await tools.execute({
        name: "update_finding",
        arguments: { finding_id: "local-only-id", status: "confirmed" },
      });

      expect(updateRes.success).toBe(true);
      expect(context.findings.find(f => f.id === "local-only-id")?.status).toBe("confirmed");
      expect(db.listFindings({ limit: 10 })).toHaveLength(0);
    });

    it("nested delegation propagates canonical finding ID and status across grandparent, parent, and grandchild", async () => {
      const home = mkdtempSync(join(tmpdir(), "0-nested-lifecycle-"));
      const db = new osecDB(join(home, "engagement.db"));
      const rootScanId = "grandparent-root";
      db.createScan({ target: "https://target.test", depth: "default", format: "json" }, rootScanId);

      // Grandparent context (root)
      const grandparentCtx: ToolContext = {
        target: "https://target.test",
        scanId: rootScanId,
        role: "attack",
        consoleSession: true,
        findings: [],
        attackResults: [],
        targetInfo: {},
        autonomyMode: "yolo",
      };

      const grandparentTools = new ToolExecutor(grandparentCtx, db);

      // Parent context inherits delegated persistence and update callbacks
      const parentCtx: ToolContext = {
        target: "https://target.test",
        scanId: "parent-child-1",
        role: "attack",
        consoleSession: true,
        findings: [],
        attackResults: [],
        targetInfo: {},
        persistDelegatedFinding: (grandparentTools as any).delegatedFindingPersistence(),
        updateDelegatedFinding: (grandparentTools as any).delegatedFindingStatusUpdate(),
      };

      const parentTools = new ToolExecutor(parentCtx, null);

      // Grandchild context inherits from parent
      const grandchildCtx: ToolContext = {
        target: "https://target.test",
        scanId: "grandchild-leaf",
        role: "attack",
        consoleSession: true,
        findings: [],
        attackResults: [],
        targetInfo: {},
        persistDelegatedFinding: (parentTools as any).delegatedFindingPersistence(),
        updateDelegatedFinding: (parentTools as any).delegatedFindingStatusUpdate(),
      };

      const grandchildTools = new ToolExecutor(grandchildCtx, null);

      try {
        // 1. Grandchild saves a finding
        const saveRes = await grandchildTools.execute({
          name: "save_finding",
          arguments: {
            title: "Nested RCE in Worker Pipeline",
            severity: "critical",
            category: "command-injection",
            description: "Discovered by grandchild",
            evidence_request: "POST /pipeline/exec\r\n\r\ncmd=whoami",
            evidence_response: "root",
          },
        });
        expect(saveRes.success).toBe(true);
        const canonicalId = (saveRes.output as any).findingId;
        expect(canonicalId).toBeDefined();

        // Verify root SQLite and grandparent memory received it
        expect(db.listFindings({ limit: 10 })).toHaveLength(1);
        expect(db.getFinding(canonicalId)?.title).toBe("Nested RCE in Worker Pipeline");
        expect(grandparentCtx.findings).toHaveLength(1);
        expect(grandparentCtx.findings[0].id).toBe(canonicalId);
        expect(grandparentCtx.findings[0].status).toBe("discovered");

        // Intermediate parent also tracked the finding in memory
        expect(parentCtx.findings).toHaveLength(1);
        expect(parentCtx.findings[0].id).toBe(canonicalId);

        // 2. Grandchild updates the finding status to confirmed
        const updateRes = await grandchildTools.execute({
          name: "update_finding",
          arguments: { finding_id: canonicalId, status: "confirmed" },
        });
        expect(updateRes.success).toBe(true);

        // Verify status updated at root SQLite, grandparent memory, intermediate parent, and grandchild
        expect(db.getFinding(canonicalId)?.status).toBe("confirmed");
        expect(grandparentCtx.findings[0].status).toBe("confirmed");
        expect(parentCtx.findings[0].status).toBe("confirmed");
        expect(grandchildCtx.findings[0].status).toBe("confirmed");
      } finally {
        await grandchildTools.cleanup();
        await parentTools.cleanup();
        await grandparentTools.cleanup();
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("rejects undefined callback result from persistDelegatedFinding and leaves local memory empty", async () => {
      const childContext: ToolContext = {
        target: "https://target.test",
        scanId: "child-void",
        findings: [],
        attackResults: [],
        targetInfo: {},
        persistDelegatedFinding: (() => undefined) as any,
      };

      const child = new ToolExecutor(childContext);
      try {
        const res = await child.execute({
          name: "save_finding",
          arguments: {
            title: "Unconfirmed Finding",
            severity: "high",
            category: "sql-injection",
            evidence_request: "POST /api/login",
            evidence_response: "syntax error",
          },
        });

        expect(res.success).toBe(false);
        expect(res.error).toContain("Delegated finding persistence failed: unconfirmed persistence result");
        expect(childContext.findings).toHaveLength(0);
      } finally {
        await child.cleanup();
      }
    });

    it("rejects invalid callback result from persistDelegatedFinding and leaves local memory empty", async () => {
      const childContext: ToolContext = {
        target: "https://target.test",
        scanId: "child-invalid",
        findings: [],
        attackResults: [],
        targetInfo: {},
        persistDelegatedFinding: (() => ({ status: "corrupted" })) as any,
      };

      const child = new ToolExecutor(childContext);
      try {
        const res = await child.execute({
          name: "save_finding",
          arguments: {
            title: "Corrupted Callback Finding",
            severity: "high",
            category: "sql-injection",
            evidence_request: "POST /api/login",
            evidence_response: "syntax error",
          },
        });

        expect(res.success).toBe(false);
        expect(res.error).toContain("unknown status corrupted");
        expect(childContext.findings).toHaveLength(0);
      } finally {
        await child.cleanup();
      }
    });

    it("nested delegation rejects unconfirmed callback result from ancestor", async () => {
      const parentContext: ToolContext = {
        target: "https://target.test",
        scanId: "parent-unconfirmed",
        findings: [],
        attackResults: [],
        targetInfo: {},
        persistDelegatedFinding: (() => undefined) as any,
      };

      const parentTools = new ToolExecutor(parentContext);
      try {
        const delegatedPersistence = (parentTools as any).delegatedFindingPersistence();
        expect(delegatedPersistence).toBeDefined();

        const fakeFinding: Finding = {
          id: "grandchild-candidate",
          templateId: "tpl-1",
          title: "Candidate",
          description: "Desc",
          severity: "high",
          category: "sql-injection",
          status: "discovered",
          timestamp: Date.now(),
          evidence: { request: "GET /test" },
        };

        const result = delegatedPersistence(fakeFinding);
        expect(result).toEqual({
          status: "rejected",
          reason: "Delegated finding persistence failed: unconfirmed persistence result",
        });
        expect(parentContext.findings).toHaveLength(0);
      } finally {
        await parentTools.cleanup();
      }
    });

    it("demonstrates architectural deduplication ceiling at 500 records per category", async () => {
      const home = mkdtempSync(join(tmpdir(), "0-dedupe-500-boundary-"));
      const db = new osecDB(join(home, "boundary.db"));
      const rootScanId = "scan-boundary-root";
      const siblingScanId = "sibling-lane-agent";
      db.createScan({ target: "https://target.test", depth: "default", format: "json" }, rootScanId);
      db.createScan({ target: "https://target.test", depth: "default", format: "json" }, siblingScanId);

      try {
        // Fast batch insert within a single transaction
        const olderFindingId = "old-sql-injection-0";
        db.transaction(() => {
          // 1. Insert an older finding F_0 at timestamp 1000
          db.saveFinding(rootScanId, {
            id: olderFindingId,
            templateId: "sqlmap",
            title: "SQL Injection in User Profile",
            description: "Older finding",
            severity: "high",
            category: "sql-injection",
            status: "discovered",
            timestamp: 1000,
            evidence: { request: "POST /profile/edit\n\nid=1' OR 1=1--" },
          });

          // 2. Insert 500 newer distinct findings in the same category (timestamps 2001..2500)
          for (let i = 1; i <= 500; i++) {
            db.saveFinding(rootScanId, {
              id: `sql-injection-${i}`,
              templateId: "sqlmap",
              title: `Distinct SQL Injection on Endpoint ${i}`,
              description: `Unique finding ${i}`,
              severity: "high",
              category: "sql-injection",
              status: "discovered",
              timestamp: 2000 + i,
              evidence: { request: `POST /api/endpoint/${i}\n\nid=1' OR 1=1--` },
            });
          }
        });

        // Verify total records in this category is 501
        const allRows = db.listFindings({ category: "sql-injection", limit: 600 });
        expect(allRows).toHaveLength(501);

        // 3. Instantiate tool executor and attempt to save a candidate finding identical to olderFindingId
        const context: ToolContext = {
          target: "https://target.test",
          scanId: siblingScanId,
          findings: [],
          attackResults: [],
          targetInfo: {},
          persistFindings: true,
        };

        const tools = new ToolExecutor(context, db);
        try {
          const saveRes = await tools.execute({
            name: "save_finding",
            arguments: {
              title: "SQL Injection in User Profile",
              severity: "high",
              category: "sql-injection",
              evidence_request: "POST /profile/edit\n\nid=1' OR 1=1--",
              evidence_response: "syntax error",
            },
          });

          // Because the query bounds cross-session deduplication to the 500 most recent records
          // in the category, the 501st record (olderFindingId) is beyond the boundary window.
          // Therefore, it does NOT merge and creates a new finding row.
          expect(saveRes.success).toBe(true);
          const savedId = (saveRes.output as { findingId: string }).findingId;
          expect(savedId).not.toBe(olderFindingId);

          // 4. Now test an incoming finding matching the 500th most recent record (within the window)
          const withinWindowTarget = "sql-injection-500";
          const dupeRes = await tools.execute({
            name: "save_finding",
            arguments: {
              title: "Distinct SQL Injection on Endpoint 500",
              severity: "high",
              category: "sql-injection",
              evidence_request: "POST /api/endpoint/500\n\nid=1' OR 1=1--",
              evidence_response: "syntax error",
            },
          });

          // Within the 500-record window: correctly deduplicates and merges!
          expect(dupeRes.success).toBe(true);
          expect((dupeRes.output as { findingId: string }).findingId).toBe(withinWindowTarget);
          expect((dupeRes.output as { message: string }).message).toContain(`merged with finding ${withinWindowTarget}`);
        } finally {
          await tools.cleanup();
        }
      } finally {
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("orders records deterministically by timestamp desc, id desc when timestamps tie", async () => {
      const home = mkdtempSync(join(tmpdir(), "0-tie-ordering-"));
      const db = new osecDB(join(home, "tie.db"));
      const scanId = "tie-scan";
      db.createScan({ target: "https://target.test", depth: "default", format: "json" }, scanId);

      try {
        const tieTime = 5000;
        db.transaction(() => {
          db.saveFinding(scanId, {
            id: "tie-a",
            templateId: "tpl",
            title: "Tie A",
            description: "A",
            severity: "high",
            category: "xss",
            status: "discovered",
            timestamp: tieTime,
            evidence: { request: "GET /a" },
          });
          db.saveFinding(scanId, {
            id: "tie-c",
            templateId: "tpl",
            title: "Tie C",
            description: "C",
            severity: "high",
            category: "xss",
            status: "discovered",
            timestamp: tieTime,
            evidence: { request: "GET /c" },
          });
          db.saveFinding(scanId, {
            id: "tie-b",
            templateId: "tpl",
            title: "Tie B",
            description: "B",
            severity: "high",
            category: "xss",
            status: "discovered",
            timestamp: tieTime,
            evidence: { request: "GET /b" },
          });
        });

        const rows = db.listFindings({ category: "xss", limit: 10 });
        expect(rows.map(r => r.id)).toEqual(["tie-c", "tie-b", "tie-a"]);
      } finally {
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
