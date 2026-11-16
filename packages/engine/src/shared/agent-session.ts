/**
 * Marker placed in the environment of every child process an agent starts (bash, run_command, monitor, pty,
 * python). Approval-bearing CLI paths refuse when it is set. It is a tripwire for honest and accidental use, not a
 * boundary: the agent runs as the same OS user and can unset it. See docs/design/extension-architecture.md.
 */
export const AGENT_SESSION_ENV = "ZERO_AGENT_SESSION";
