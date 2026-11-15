/**
 * Which interface is running the one 0security engine.
 *
 * `0 web` (and a bare `0`, which opens the web console) is the `web` surface;
 * every other command is `cli`. Crash reports and anonymous usage events both
 * use this single function so the two can never disagree.
 */
export type TelemetrySurface = "cli" | "web";

export function surfaceFromArgv(argv: readonly string[]): TelemetrySurface {
  const first = argv[2];
  return first === undefined || first === "web" ? "web" : "cli";
}
