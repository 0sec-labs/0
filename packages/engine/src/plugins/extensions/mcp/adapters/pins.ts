import { applyMcpPins, type McpPinRecord } from "../../core/state.js";
import { ok, type Result } from "../../core/result.js";
import type { Clock, ExtensionStore } from "../../ports.js";
import type { McpPinStore } from "../ports.js";

/** Pins live in the sealed extension state, on the revision record, so a new revision starts with none. */
export class StatePinStore implements McpPinStore {
  constructor(private readonly store: ExtensionStore, private readonly clock: Clock = { now: () => new Date() }) {}
  pins(extension: string, revision: string): Readonly<Record<string, McpPinRecord>> {
    const state = this.store.read();
    return state.ok ? state.value.extensions[extension]?.revisions[revision]?.mcpPins ?? {} : {};
  }
  approve(extension: string, revision: string, server: string, tools: Record<string, string>): Result<void> {
    return this.store.update(
      state => { const r = applyMcpPins(state, extension, revision, server, tools, this.clock.now().toISOString()); return r.ok ? ok(undefined) : r; },
      () => ({ event: "extension.mcp.approve", name: extension, revision, server, tools: Object.keys(tools).length }),
    );
  }
}
