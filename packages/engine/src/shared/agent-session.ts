/**
 * Marker placed in the environment of every child process an agent starts (bash, run_command, monitor, pty,
 * python). Approval-bearing CLI paths refuse when it is set. It is a tripwire for honest and accidental use, not a
 * boundary: the agent runs as the same OS user and can unset it. See docs/design/extension-architecture.md.
 */
export const AGENT_SESSION_ENV = "ZERO_AGENT_SESSION";

/** The one sentence a person sees when an approval command is refused because a thread ran it. Never name the variable or say "agent session" to users. */
export const RUN_BY_THREAD_MESSAGE = "This command was run by a thread, not by you. Run it yourself in a terminal to approve.";
