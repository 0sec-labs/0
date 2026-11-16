/** One declared MCP server as the host tracks it. Mutable state lives here, decisions live in core/. */
import type { ToolDefinition } from "../../../agent/types.js";
import type { LoadedExtension } from "../runtime.js";
import type { McpServerDecl } from "../core/manifest.js";
import type { ServerIndexEntry } from "./core/definitions.js";
import type { McpToolInfo } from "./core/tool-hash.js";
import type { McpSession } from "./ports.js";

export type State = "idle" | "ready" | "blocked";
export interface Server {
  readonly id: string; readonly ext: LoadedExtension; readonly decl: McpServerDecl; readonly entry: ServerIndexEntry;
  state: State; reason: string; session?: McpSession;
  /** What the definitions were built from. A call re-checks these against the operator's pin. */
  tools: Map<string, McpToolInfo>; allowed: Set<string>; defs: ToolDefinition[];
  /** Values that must never appear in what comes back (the secrets this server's process was given). */
  secrets: string[];
  /** The server announced a changed tool list: nothing is callable until it has been reviewed again. */
  stale: boolean;
  loading?: Promise<void>; revalidating?: Promise<void>;
}

export const newServer = (id: string, ext: LoadedExtension, decl: McpServerDecl, entry: ServerIndexEntry): Server =>
  ({ id, ext, decl, entry, state: "idle", reason: "", tools: new Map(), allowed: new Set(), defs: [], secrets: [], stale: false });

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
export const redactWith = (server: Pick<Server, "secrets">, text: string): string => server.secrets.reduce((r, s) => r.split(s).join("[redacted]"), text);
