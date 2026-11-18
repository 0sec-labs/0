/**
 * Which interface is running the one 0security engine.
 *
 * `0` (bare, or with a console flag such as `--headless`) and the old `0 web` are the `web` surface;
 * every other command is `cli`. Crash reports and anonymous usage events both
 * use this single function so the two can never disagree.
 */
export type TelemetrySurface = "cli" | "web";

/** The flags of the web console: `0 --headless` and `0 --port 8080` are `0 web ...` (see command-grammar.ts). */
export const CONSOLE_FLAGS: ReadonlySet<string> = new Set([
  "--db-path", "--port", "--host", "--asset-dir", "--dev-url", "--team-config", "--engine-token-env", "--engine-workspace", "--engine-scope", "--engine-target",
  "--engine-allow-apply", "--engine-time-cap", "--engine-cost-cap", "--server-mode", "--allowed-host", "--trusted-proxy", "--public-url", "--access-token-env",
  "--shutdown-timeout", "--ready-json", "--no-open", "--headless", "--engines-config", "--backends-config",
]);

export function surfaceFromArgv(argv: readonly string[]): TelemetrySurface {
  const first = argv[2];
  return first === undefined || first === "web" || CONSOLE_FLAGS.has(first.split("=")[0]!) ? "web" : "cli";
}
