import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OPERATOR_INSTRUCTIONS_MAX_CHARS, homeStateDir, type OperatorInstructions } from "@0/engine/shared";

/**
 * Operator-owned instruction files, kept in the app's own state directory:
 *   global     <home>/.0/AGENTS.md
 *   workspace  <home>/.0/workspaces/<hash of workspace path>/AGENTS.md
 * Nothing here ever reads a file from the workspace itself: AGENTS.md/CLAUDE.md in a target
 * repository is attacker-controlled and is not an instruction source.
 */
export type InstructionKind = "global" | "workspace";

export const INSTRUCTION_FILE_NAME = "AGENTS.md";

function workspaceKey(workspacePath: string): string {
  let path = resolve(workspacePath);
  try { path = realpathSync(path); } catch { /* unresolved path still hashes deterministically */ }
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export function instructionFilePath(kind: InstructionKind, workspacePath: string | undefined, homeDir?: string): string {
  if (kind === "global") return join(homeStateDir(homeDir), INSTRUCTION_FILE_NAME);
  if (!workspacePath) throw new InstructionsError(400, "A workspace path is required.");
  return join(homeStateDir(homeDir), "workspaces", workspaceKey(workspacePath), INSTRUCTION_FILE_NAME);
}

export class InstructionsError extends Error {
  constructor(readonly status: number, message: string, readonly code = "invalid_instructions") { super(message); }
}

/** Content hash; the empty/missing file is revision "empty". */
export function instructionRevision(content: string | null): string {
  return content === null ? "empty" : createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function readIfPresent(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}

/** Resolved once at mission start; capped again by the engine when injecting. */
export function loadOperatorInstructions(workspacePath: string | undefined, homeDir?: string): OperatorInstructions {
  const global = readIfPresent(instructionFilePath("global", undefined, homeDir));
  const workspace = workspacePath ? readIfPresent(instructionFilePath("workspace", workspacePath, homeDir)) : null;
  return { ...(global ? { global } : {}), ...(workspace ? { workspace } : {}) };
}

function view(kind: InstructionKind, path: string, content: string | null) {
  return { kind, fileName: INSTRUCTION_FILE_NAME, content: content ?? "", revision: instructionRevision(content), maxChars: OPERATOR_INSTRUCTIONS_MAX_CHARS };
}

/** Handles `instructions/{global|workspace}` (relative to /api/console/). Null when not ours. */
export function handleInstructionsRequest(path: string, method: string, input: unknown, query: URLSearchParams, homeDir?: string): { status: number; data: unknown } | null {
  const match = /^instructions\/(global|workspace)$/.exec(path);
  if (!match) return null;
  const kind = match[1] as InstructionKind;
  try {
    if (method === "GET") {
      const file = instructionFilePath(kind, query.get("path") ?? undefined, homeDir);
      return { status: 200, data: view(kind, file, readIfPresent(file)) };
    }
    if (method !== "PUT") return { status: 405, data: { error: "Method not allowed." } };
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new InstructionsError(400, "Expected a JSON object.");
    const body = input as Record<string, unknown>;
    if (typeof body["content"] !== "string" || typeof body["revision"] !== "string") throw new InstructionsError(400, "content and revision are required.");
    const content = body["content"];
    if (content.length > OPERATOR_INSTRUCTIONS_MAX_CHARS) throw new InstructionsError(413, `Instructions are limited to ${OPERATOR_INSTRUCTIONS_MAX_CHARS.toLocaleString("en-US")} characters.`, "too_large");
    const workspacePath = typeof body["path"] === "string" ? body["path"] : undefined;
    const file = instructionFilePath(kind, workspacePath, homeDir);
    const current = readIfPresent(file);
    if (instructionRevision(current) !== body["revision"]) return { status: 409, data: { error: "These instructions changed since you opened them. Reload and re-apply your edit.", code: "revision_conflict", ...view(kind, file, current) } };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, file);
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    return { status: 200, data: view(kind, file, content) };
  } catch (error) {
    if (error instanceof InstructionsError) return { status: error.status, data: { error: error.message, code: error.code } };
    throw error;
  }
}
