import { describe, expect, it } from "vitest";
import { auditActionLabel, auditDetailSummary, auditExportJson, auditLogPath, auditWhen, sortAudit, type AuditEntry } from "./audit-log-model";

const entry = (id: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({ id, ts: "2026-11-14T10:00:00.000Z", actor: "operator (browser)", action: "mcp.create", subject: "files", outcome: "ok", detail: {}, ...extra });

describe("audit log model", () => {
  it("builds the query path with search and cursor", () => {
    expect(auditLogPath()).toBe("/api/console/audit-log?limit=100");
    expect(auditLogPath({ q: " mcp ", before: 42, limit: 20 })).toBe("/api/console/audit-log?limit=20&q=mcp&before=42");
  });
  it("labels actions and times", () => {
    expect(auditActionLabel("mcp.create")).toBe("MCP create");
    expect(auditActionLabel("access.browser_only")).toBe("Access browser only");
    const now = Date.parse("2026-11-14T10:05:00.000Z");
    expect(auditWhen("2026-11-14T10:00:00.000Z", now)).toEqual({ relative: "5m ago", exact: "2026-11-14 10:00:00 UTC" });
    expect(auditWhen("2026-11-14T10:04:59.000Z", now).relative).toBe("Just now");
    expect(auditWhen("nope").relative).toBe("Unknown");
  });
  it("sorts by recency either way", () => {
    const rows = [entry(1), entry(3), entry(2)];
    expect(sortAudit(rows, "newest").map(row => row.id)).toEqual([3, 2, 1]);
    expect(sortAudit(rows, "oldest").map(row => row.id)).toEqual([1, 2, 3]);
  });
  it("summarises safe detail and exports the visible rows", () => {
    expect(auditDetailSummary({ key: "theme", old: "dark", new: "light" })).toBe("dark → light");
    expect(auditDetailSummary({ envKeys: ["A", "B"], fingerprint: "abcd" })).toBe("env: A, B · fingerprint abcd");
    expect(auditDetailSummary({ callerKind: "engine", route: "/api/console/mcp-servers", method: "POST" })).toBe("engine → POST /api/console/mcp-servers");
    expect(JSON.parse(auditExportJson([entry(1)]))).toEqual([{ id: 1, ts: "2026-11-14T10:00:00.000Z", actor: "operator (browser)", action: "mcp.create", subject: "files", outcome: "ok", detail: {} }]);
  });
});
