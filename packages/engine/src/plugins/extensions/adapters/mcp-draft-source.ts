import { gitTreeHash, type FolderFile } from "../core/files.js";
import { isExtensionName, sanitizeName } from "../core/manifest.js";
import { err, ok, type Result } from "../core/result.js";
import type { ExtensionSource, Snapshot } from "../ports.js";

export interface McpDraft { name: string; command?: string; args?: string[]; url?: string }

/**
 * One MCP server the operator typed (a command or an https URL) as a one-file local extension. It goes through the same
 * prepare, install prompt and commit as any folder, so it is shown, pinned by content and approved the same way.
 */
export class McpDraftSource implements ExtensionSource {
  readonly pinned = false;
  readonly label: string; readonly suggestedName: string;
  constructor(private readonly draft: McpDraft) { this.suggestedName = sanitizeName(draft.name); this.label = `MCP server ${this.suggestedName}`; }
  async fetch(): Promise<Result<Snapshot>> {
    const { command, url } = this.draft; const name = this.suggestedName;
    if (!isExtensionName(name)) return err("bad_source", "Name the server with lowercase letters, digits and . _ - (start with a letter).");
    if (Boolean(command?.trim()) === Boolean(url?.trim())) return err("bad_source", "Give either a command or a URL.");
    if (url && !/^https:\/\//i.test(url.trim())) return err("bad_source", "A URL must start with https://.");
    const server = url ? { url: url.trim() } : { command: command!.trim(), args: (this.draft.args ?? []).filter(Boolean) };
    const bytes = Buffer.from(`${JSON.stringify({ name, description: `Local MCP server ${name}`, mcpServers: { [name]: server } }, null, 2)}\n`);
    const files: FolderFile[] = [{ path: "extension.json", size: bytes.length, executable: false, bytes }];
    const treeHash = gitTreeHash(files);
    return ok({ revision: `local-${treeHash.slice(0, 16)}`, files, treeHash, source: { type: "local", path: `mcp:${name}` } });
  }
}
