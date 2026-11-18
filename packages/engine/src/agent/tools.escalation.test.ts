import { describe, it, expect, vi } from "vitest";
vi.mock("../plugins/enablement.js", async (importOriginal) => ({
  ...await importOriginal<object>(),
  readEnablement: () => ({ schema: 1, project: process.cwd(), enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 1 } } }),
}));
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "./tools.js";
import type { ToolContext, ToolCall, ScopedAuditEscalationRequest } from "./types.js";

// Scoped-source-audit allow-list gate: autonomy-aware + escalatable.
//
// The lightest possible harness: construct a ToolExecutor with a stub context
// (a real temp dir stands in for the scoped source root) and drive `execute`
// directly. No session, no runtime, no DB.
//
// `str_replace` is the tool from the live bug report and is NOT in
// SCOPED_SOURCE_AUDIT_TOOLS, so it is the natural probe. When the gate lets it
// through, its handler returns a DIFFERENT error (missing `patch` arg / needs a
// scope) — never the gate's "not available in a scoped source audit" message —
// which is exactly how we prove the gate opened without performing any write.

const BLOCK_MSG = /not available in a scoped source audit/;

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    target: "https://target.test",
    scanId: "escalation-test",
    findings: [],
    attackResults: [],
    targetInfo: {},
    role: "audit",
    ...overrides,
  } as ToolContext;
}

const patchCall: ToolCall = { name: "str_replace", arguments: {} };

describe("scoped source-audit escalation gate", () => {
  it("rechecks host authority after asynchronous admission before applying a patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-authority-admission-"));
    let authorized = true;
    let entered!: () => void;
    let approve!: (value: boolean) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const executor = new ToolExecutor(baseCtx({
      scopePath: root, approvals: "ask",
      escalateScopedAudit: () => { entered(); return new Promise(resolve => { approve = resolve; }); },
    }), null);
    try {
      const result = executor.execute({
        name: "str_replace",
        arguments: { path: "effect.txt", old_string: "", new_string: "effect\n" },
      }, { assertAuthority: () => { if (!authorized) throw new Error("Fixture authority revoked"); } });
      await waiting;
      authorized = false;
      approve(true);
      const outcome = await result;
      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe("Fixture authority revoked");
      expect(existsSync(join(root, "effect.txt"))).toBe(false);
    } finally { await executor.cleanup(); rmSync(root, { recursive: true, force: true }); }
  });


  it("Auto + configured scope → a previously-blocked tool dispatches", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-esc-"));
    try {
      const exec = new ToolExecutor(
        baseCtx({ scopePath: root, approvals: "auto" }),
        null,
      );
      const result = await exec.execute(patchCall);
      // Gate opened: we reach the handler, which rejects the empty patch arg —
      // NOT the scoped-audit block message.
      expect(result.error).not.toMatch(BLOCK_MSG);
      expect(result.error).toMatch(/path/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Auto + NO scope → still blocked (no scope means no execution rights)", async () => {
    // No scopePath: the allow-list gate does not even engage, and the handler's
    // own scope guard blocks the call. Auto grants nothing without a scope.
    const exec = new ToolExecutor(
      baseCtx({ approvals: "auto" /* no scopePath */ }),
      null,
    );
    const result = await exec.execute(patchCall);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a scoped local directory/);
  });

  it("standard + approving callback → tool runs; a second call does NOT re-invoke the callback", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-esc-"));
    try {
      const escalate = vi.fn(async (_req: ScopedAuditEscalationRequest) => true);
      const exec = new ToolExecutor(
        baseCtx({ scopePath: root, approvals: "ask", escalateScopedAudit: escalate }),
        null,
      );

      const first = await exec.execute(patchCall);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(first.error).not.toMatch(BLOCK_MSG); // gate opened → handler reached

      const second = await exec.execute(patchCall);
      // Grant remembered: no second prompt.
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(second.error).not.toMatch(BLOCK_MSG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("standard + denying callback → error; a retry does NOT re-invoke the callback", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-esc-"));
    try {
      const escalate = vi.fn(async (_req: ScopedAuditEscalationRequest) => false);
      const exec = new ToolExecutor(
        baseCtx({ scopePath: root, approvals: "ask", escalateScopedAudit: escalate }),
        null,
      );

      const first = await exec.execute(patchCall);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(first.success).toBe(false);
      expect(first.error).toMatch(BLOCK_MSG);

      const second = await exec.execute(patchCall);
      // Denial remembered: no re-prompt, same hard denial.
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(second.success).toBe(false);
      expect(second.error).toMatch(BLOCK_MSG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copilot + configured scope → auto-lifts like yolo WITHOUT invoking the callback", async () => {
    // Under the current autonomy model copilot has no per-action prompts, so the
    // scoped-audit allow-list is auto-lifted inside the configured scope exactly
    // like yolo — the escalation callback is never consulted.
    const root = mkdtempSync(join(tmpdir(), "0-esc-"));
    try {
      const escalate = vi.fn(async (_req: ScopedAuditEscalationRequest) => true);
      const exec = new ToolExecutor(
        baseCtx({ scopePath: root, approvals: "auto", escalateScopedAudit: escalate }),
        null,
      );
      const result = await exec.execute(patchCall);
      expect(escalate).not.toHaveBeenCalled();
      // Gate opened: we reach the handler (which rejects the empty patch arg),
      // NOT the scoped-audit block message.
      expect(result.error).not.toMatch(BLOCK_MSG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a tool already in SCOPED_SOURCE_AUDIT_TOOLS never triggers escalation", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-esc-"));
    try {
      const escalate = vi.fn(async (_req: ScopedAuditEscalationRequest) => true);
      const exec = new ToolExecutor(
        baseCtx({ scopePath: root, approvals: "ask", escalateScopedAudit: escalate }),
        null,
      );
      // load_skill is allow-listed → runs directly, callback untouched.
      const result = await exec.execute({ name: "load_skill", arguments: {} });
      expect(escalate).not.toHaveBeenCalled();
      expect(result.error ?? "").not.toMatch(BLOCK_MSG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("switching the approvals setting between calls changes the outcome without rebuilding the executor", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-esc-"));
    try {
      // Standard, no callback → hard denial (default behaviour).
      const ctx = baseCtx({ scopePath: root, approvals: "ask" });
      const exec = new ToolExecutor(ctx, null);

      const blocked = await exec.execute(patchCall);
      expect(blocked.success).toBe(false);
      expect(blocked.error).toMatch(BLOCK_MSG);

      // Flip the same context object to Auto — no new executor.
      ctx.approvals = "auto";
      const opened = await exec.execute(patchCall);
      expect(opened.error).not.toMatch(BLOCK_MSG);

      // And back to standard/no-callback → blocked again, same session.
      ctx.approvals = "ask";
      const reblocked = await exec.execute(patchCall);
      expect(reblocked.success).toBe(false);
      expect(reblocked.error).toMatch(BLOCK_MSG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
