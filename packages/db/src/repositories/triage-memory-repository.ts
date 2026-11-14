// TriageMemoryRepository: persistence for triageMemories.


import { Repository } from "./base.js";

export class TriageMemoryRepository extends Repository {

  // ── Triage Memories (Semgrep-style per-target FP learning) ──

  insertTriageMemory(row: {
    id: string;
    scope: "global" | "target" | "package";
    scopeValue?: string | null;
    category: string;
    pattern: string;
    reasoning: string;
    createdAt: number;
    appliedCount?: number;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO triage_memories (id, scope, scope_value, category, pattern, reasoning, created_at, applied_count)
         VALUES (@id, @scope, @scopeValue, @category, @pattern, @reasoning, @createdAt, @appliedCount)`,
      )
      .run({
        id: row.id,
        scope: row.scope,
        scopeValue: row.scopeValue ?? null,
        category: row.category,
        pattern: row.pattern,
        reasoning: row.reasoning,
        createdAt: row.createdAt,
        appliedCount: row.appliedCount ?? 0,
      });
  }


  listTriageMemories(opts?: {
    scope?: "global" | "target" | "package";
    scopeValue?: string;
    category?: string;
    limit?: number;
  }): Array<{
    id: string;
    scope: "global" | "target" | "package";
    scopeValue: string | null;
    category: string;
    pattern: string;
    reasoning: string;
    createdAt: number;
    appliedCount: number;
  }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts?.scope) {
      where.push("scope = @scope");
      params.scope = opts.scope;
    }
    if (opts?.scopeValue) {
      where.push("scope_value = @scopeValue");
      params.scopeValue = opts.scopeValue;
    }
    if (opts?.category) {
      where.push("category = @category");
      params.category = opts.category;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts?.limit ?? 500;
    const rows = this.sqlite
      .prepare(
        `SELECT id, scope, scope_value as scopeValue, category, pattern, reasoning,
                created_at as createdAt, applied_count as appliedCount
         FROM triage_memories
         ${whereSql}
         ORDER BY applied_count DESC, created_at DESC
         LIMIT ${limit}`,
      )
      .all(params) as Array<{
        id: string;
        scope: "global" | "target" | "package";
        scopeValue: string | null;
        category: string;
        pattern: string;
        reasoning: string;
        createdAt: number;
        appliedCount: number;
      }>;
    return rows;
  }


  deleteTriageMemory(id: string): boolean {
    const result = this.sqlite.prepare("DELETE FROM triage_memories WHERE id = ?").run(id);
    return result.changes > 0;
  }


  incrementMemoryAppliedCount(id: string): void {
    this.sqlite
      .prepare("UPDATE triage_memories SET applied_count = applied_count + 1 WHERE id = ?")
      .run(id);
  }
}
