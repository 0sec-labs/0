import { describe, expect, it } from "vitest";
import { buildRunRecords, RunRecordSchema } from "./work-records.js";
import type { SecurityWorkflowExecution } from "./security-workflows.js";

const execution = { id: "flow", workflowId: "definition", sessionId: "conversation", jobId: "job",
  workflow: { name: "Review", target: "/repo" }, status: "completed", createdAt: "2026-01-01", updatedAt: "2026-01-02",
  nodeResults: { audit: { status: "completed", scanId: "child", scanIds: ["child", "other"] } },
} as unknown as SecurityWorkflowExecution;
describe("canonical work records", () => {
  it("folds repeated native child references and keeps standalone scans distinct from conversations", () => {
    const records = buildRunRecords([execution], [
      { id: "child", target: "/repo", status: "completed", startedAt: "2026-01-01" },
      { id: "standalone", target: "/other", status: "failed", startedAt: "2026-01-03" },
    ]);
    expect(records.map(record => record.id)).toEqual(["scan:standalone", "workflow:flow"]);
    expect(records[0]).toMatchObject({ conversation: null, native: { scanIds: ["standalone"] } });
    expect(records[1]).toMatchObject({ conversation: { sessionId: "conversation" }, native: {
      workflowExecutionId: "flow", workflowId: "definition", jobId: "job", scanIds: ["child", "other"],
    } });
    for (const record of records) expect(RunRecordSchema.parse(record)).toEqual(record);
  });
  it("uses namespaced identities even when native IDs collide", () => {
    const records = buildRunRecords([execution], [{ id: "flow", target: "/other", status: "running", startedAt: "2026-01-01" }]);
    expect(new Set(records.map(record => record.id)).size).toBe(2);
  });
  it("separates execution ownership from explicit conversation provenance and preserves old real sessions", () => {
    const standalone = { ...execution, conversationSessionId: null, sessionId: "cli" };
    const explicit = { ...execution, sessionId: "worker-owner", conversationSessionId: "browser-chat" };
    const namedCliChat = { ...execution, sessionId: "cli", conversationSessionId: "cli", workflowId: "cli-fix", jobId: undefined };
    const legacyStandalone = { ...execution, sessionId: "cli", workflowId: "cli-fix", jobId: undefined };
    expect(buildRunRecords([standalone], [])[0].conversation).toBeNull();
    expect(buildRunRecords([explicit], [])[0].conversation).toEqual({ sessionId: "browser-chat" });
    expect(buildRunRecords([namedCliChat], [])[0].conversation).toEqual({ sessionId: "cli" });
    expect(buildRunRecords([legacyStandalone], [])[0].conversation).toBeNull();
    expect(buildRunRecords([execution], [])[0].conversation).toEqual({ sessionId: "conversation" });
  });
});
