/**
 * Who may grant an approval. Approving an extension (install, update, enable, import, enablement of a built-in) is an
 * operator act. The CLI asks this gate before it changes anything:
 *
 *   - refuse when the agent-session marker is set (the process was started by an agent's bash, run_command, ...);
 *   - otherwise an explicit `--yes` (or an interactive "y" at a terminal) approves, so a person can install from CI or a
 *     script. The marker, not the TTY, tells a person from an agent: a flag alone never approves from an agent session.
 *
 * Layered defence, not a boundary: an agent has bash as the same OS user and can unset the marker. The beforeCommand
 * protected-paths decider (hooks/protected-paths*.ts) and the sandbox are the other layers.
 */
import { AGENT_SESSION_ENV } from "../../shared/agent-session.js";

export interface ApprovalEnvironment { readonly env: Readonly<Record<string, string | undefined>>; readonly stdinIsTTY: boolean }

export const currentApprovalEnvironment = (): ApprovalEnvironment => ({ env: process.env, stdinIsTTY: process.stdin.isTTY === true });

/** The refusal message, or null when the operator may proceed. */
export function approvalRefusal(what: string, environment: ApprovalEnvironment = currentApprovalEnvironment()): string | null {
  if (environment.env[AGENT_SESSION_ENV]) return `Refusing to ${what} from an agent session. Approvals are the operator's: ask the operator to run this in their own shell (--yes works there) or approve it on the Extensions page.`;
  return null;
}
