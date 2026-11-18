// Source-review tool allowlist.
import { LIST_TOOLS_NAME, LOAD_TOOL_NAME } from "../deferred-tools.js";

// A source review processes attacker-controlled package contents. Do not
// offer generic process, network, or write capability inside that trust boundary.
// agent-runner routes these roles through the tool-mediated API loop; this list
// supplies only source browsing, and findings.
export const SCOPED_SOURCE_AUDIT_TOOLS: Record<string, true> = {
  // Deferred controls disclose definitions only; actual calls still pass this gate.
  [LIST_TOOLS_NAME]: true,
  [LOAD_TOOL_NAME]: true,
  // Methodology reads return bounded registry text, never execute its contents.
  load_skill: true,
  finding: true,
  memory: true,
  // Delegation shares the audit's tool capabilities, budget and worker tree.
  spawn_agent: true,
  report_status: true,
  send_message: true,
  check_messages: true,
};

// Source-audit authority may include opt-in executable analysis; read-only
// delegation must never inherit that launcher or count it as mutation-free.
export function isCheckoutReadOnlyTool(name: string): boolean {
  return Object.hasOwn(SCOPED_SOURCE_AUDIT_TOOLS, name);
}
