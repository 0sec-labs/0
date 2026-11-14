import type { ScopeEnforcementState } from "@0/engine";
import type { WebConsoleRuntimeBootstrap } from "./web/operator-services.js";
import { randomUUID } from "node:crypto";
import { encodeWorkbenchFrame, WorkbenchFrameReader, type WorkbenchFrame } from "./workbench-console-protocol.js";

// Reuse the bounded controller framing without VM path/provider semantics.
export { encodeWorkbenchFrame as encodeHostConsoleFrame } from "./workbench-console-protocol.js";
export type { WorkbenchFrame as HostConsoleFrame } from "./workbench-console-protocol.js";

const HOST_CONSOLE_MESSAGE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;

/** Large live snapshots stay lossless within an explicit bounded assembly cap. */
export function encodeHostConsoleFrames(frame: WorkbenchFrame): string[] {
  const bytes = Buffer.from(JSON.stringify(frame));
  if (bytes.length > HOST_CONSOLE_MESSAGE_BYTES) throw new Error("Host console message exceeds assembly limit");
  if (bytes.length < CHUNK_BYTES) return [encodeWorkbenchFrame(frame)];
  const id = randomUUID();
  const total = Math.ceil(bytes.length / CHUNK_BYTES);
  return Array.from({ length: total }, (_, index) => encodeWorkbenchFrame({ type: "chunk", id, index, total, data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64") }));
}

export class HostConsoleFrameReader {
  #reader = new WorkbenchFrameReader();
  #assemblies = new Map<string, { total: number; parts: Buffer[]; bytes: number }>();
  push(data: string, receive: (frame: WorkbenchFrame) => void): void {
    this.#reader.push(data, frame => {
      if (frame.type !== "chunk") { receive(frame); return; }
      const { id, index, total, data: encoded } = frame;
      if (!id || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || (total as number) < 1 || (total as number) > HOST_CONSOLE_MESSAGE_BYTES / CHUNK_BYTES || typeof encoded !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid host console chunk");
      let assembly = this.#assemblies.get(id);
      if (!assembly) {
        if (index !== 0 || this.#assemblies.size >= 2) throw new Error("Host console chunk assembly limit exceeded");
        assembly = { total: total as number, parts: [], bytes: 0 }; this.#assemblies.set(id, assembly);
      }
      if (index !== assembly.parts.length || total !== assembly.total) throw new Error("Host console chunks are out of order");
      const bytes = Buffer.from(encoded, "base64");
      assembly.bytes += bytes.length;
      if (bytes.length > CHUNK_BYTES || assembly.bytes > HOST_CONSOLE_MESSAGE_BYTES) throw new Error("Host console chunk byte limit exceeded");
      assembly.parts.push(bytes);
      if (assembly.parts.length === total) {
        this.#assemblies.delete(id);
        const value: unknown = JSON.parse(Buffer.concat(assembly.parts).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as WorkbenchFrame).type !== "string" || (value as WorkbenchFrame).type === "chunk") throw new Error("Invalid assembled host console frame");
        receive(value as WorkbenchFrame);
      }
    });
  }
}

/** Private pipe only. Never put this bootstrap in argv, logs or saved chats. */
export interface HostConsoleBootstrap {
  sessionId: string;
  executionProfile: "local";
  config: Record<string, unknown>;
  dbPath?: string;
  learningDbPath?: string;
  executionEnvironment: Record<string, string>;
  runtime: WebConsoleRuntimeBootstrap;
  scopeEnforcement: ScopeEnforcementState;
  callbacks: string[];
}

export interface HostConsoleStopResult {
  /** The dedicated execution process has really exited, never a promise race. */
  processExited: boolean;
  /** Every registered owned process/group is confirmed absent or exited. */
  resourcesStopped: boolean;
  /** An unconfirmed stop permanently fences this controller from new work. */
  quarantined: boolean;
  error?: string;
}

export const HOST_CONSOLE_CALLBACKS = [
  "requestScope", "requestLocalScope", "approveTool", "escalateScopedAudit", "askOperator",
  "skillRead", "skillCreate", "skillSave", "skillCopy", "skillEditorRead", "sourceLessonHints",
  "workflowList", "workflowRead", "workflowSave", "workflowEditorRead", "workflowInvoke",
  "historyList", "historyRead",
] as const;
