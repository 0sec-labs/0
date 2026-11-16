/**
 * The MCP seams. The host depends on these interfaces only; the MCP SDK (stdio, Streamable HTTP, SSE), the file system
 * and the operator are adapters behind them. `McpConnector` is the one place a server process starts or a remote URL is
 * opened, so it is the one place the `beforeCommand` gate has to guard.
 */
import type { BeforeCommandInput, BeforeCommandThread } from "../../../hooks/before-command.js";
import type { Result } from "../core/result.js";
import type { McpPinRecord } from "../core/state.js";
import type { McpToolInfo } from "./core/tool-hash.js";
import type { ToolReview } from "./core/review.js";

export type McpLaunch =
  | { readonly kind: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string }
  | { readonly kind: "http"; readonly transport: "http" | "sse"; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export interface McpCallResult { readonly text: string; readonly isError: boolean }

/** A live connection to one server. */
export interface McpSession {
  tools(): Promise<McpToolInfo[]>;
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpConnector { connect(launch: McpLaunch): Promise<McpSession> }

/** The `beforeCommand` decision point, as the host sees it. */
export type McpGate = (input: BeforeCommandInput) => Promise<{ readonly decision: "allow" | "deny" | "ask"; readonly reason: string }>;

/** Asks the operator (the thread's approval channel). Absent means nobody can be asked: fail closed. */
export type McpConfirm = (request: { readonly name: string; readonly summary: string }) => Promise<boolean>;

/** Approved tool hashes, per extension revision and server. Written only by an operator act. */
export interface McpPinStore {
  pins(extension: string, revision: string): Readonly<Record<string, McpPinRecord>>;
  approve(extension: string, revision: string, server: string, tools: Record<string, string>): Result<void>;
}

/** What each connection saw, kept so the Extensions page and `info` can show Changed / New / Removed. Informational only: it grants nothing. */
export interface McpObservation { readonly at: string; readonly tools: Record<string, string>; readonly review: Pick<ToolReview, "changed" | "added" | "removed" | "needsApproval" | "reason"> | null; readonly blocked: string | null }
export interface McpObservationLog {
  record(extension: string, revision: string, server: string, observation: McpObservation): void;
  read(extension: string, revision: string): Readonly<Record<string, McpObservation>>;
}

export interface McpThread { readonly thread: () => BeforeCommandThread; readonly cwd: string }
