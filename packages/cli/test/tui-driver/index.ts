/**
 * In-process TUI self-test framework.
 *
 * Mounts the real console into OpenTUI's headless test renderer so scenarios can
 * drive it with synthetic input and assert on rendered frames — no node-pty, no
 * tmux, no real terminal.
 */

export { launch } from "./driver.js";
export type { TuiHandle, LaunchOptions, KeyModifiers, ConsoleRoute } from "./driver.js";
export { withDeterministicEnv } from "./env.js";
export type { DeterministicEnv } from "./env.js";
export { normalizeFrame } from "./normalize.js";
