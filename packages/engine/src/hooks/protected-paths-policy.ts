import { homedir } from "node:os";
import type { BeforeCommandDecision, BeforeCommandInput, BeforeCommandPolicy } from "./before-command.js";
import { RUN_BY_THREAD_MESSAGE } from "../shared/agent-session.js";
import { realpathLoose } from "./real-path.js";
import { findApprovalCommand, findProtectedPathUse } from "./protected-paths.js";

const GUARDED_KINDS = new Set(["bash", "process", "file-write", "file-read"]);

/**
 * Built-in decider: an agent may not touch the files that hold approvals, enablement, grants, audit, settings or the
 * database, and may not run the CLI commands that grant approvals. It denies with a reason that tells the agent to
 * ask the operator. Layered defence, not a boundary: the agent runs as the same OS user with bash, so text analysis
 * cannot see paths built at run time. The sandbox is the hard boundary.
 */
export const protectedPathsBeforeCommandPolicy: BeforeCommandPolicy = {
  id: "protected-paths",
  evaluate(input: BeforeCommandInput): BeforeCommandDecision {
    if (!GUARDED_KINDS.has(input.kind)) return { decision: "allow" };
    const approval = input.kind === "bash" || input.kind === "process" ? findApprovalCommand(input.command) : null;
    if (approval) return { decision: "deny", reason: `\`${approval}\` grants approvals or changes extension enablement. ${RUN_BY_THREAD_MESSAGE}` };
    const home = process.env["HOME"] || homedir();
    const hit = findProtectedPathUse(input.kind === "file-write" || input.kind === "file-read" ? "" : input.command, input.paths, { home, cwd: input.cwd, real: realpathLoose, extensionFilesReadable: input.kind === "bash" || input.kind === "process" || input.kind === "file-read", ...(input.kind === "process" && input.extensionDir ? { exemptDir: input.extensionDir } : {}) });
    if (hit) return { decision: "deny", reason: `${hit.reason}. Approvals, enablement, grants, audit, settings and database files are protected from agent commands; ask the operator to make this change.` };
    return { decision: "allow" };
  },
};
