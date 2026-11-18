
/** Shared built-in gate tables. Session contributions extend copies, never these defaults. */
export const NETWORK_CAPABLE_TOOLS: Readonly<Record<string, true>> = Object.freeze({
  bash: true,
  spawn_agent: true,
  start_scan: true,
});

/** Copilot-exempt reads and authority-free session bookkeeping. */
export const READ_ONLY_TOOLS: Readonly<Record<string, true>> = Object.freeze({
  load_skill: true,
  ask_operator: true,
});

export interface ToolGateFlags { networkCapable: boolean; readOnly: boolean }
