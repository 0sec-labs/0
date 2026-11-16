/**
 * The one-time telemetry disclosure.
 *
 * Telemetry is automatic by default, so every install is told exactly once, on
 * the first interactive run of the CLI or `0`, what is sent and how to turn
 * it off. The notice goes to STDERR only, and only when it cannot corrupt
 * machine output or a pipeline: stderr must be a TTY, the arguments must not
 * ask for a machine format, CI is silent, and nothing is printed when
 * telemetry is already off. "Once" is a flag file in the state directory,
 * written before printing so a read-only home never produces a nag on every run.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { analyticsOptedOut } from "@0/engine";
import { homeStateDir } from "@0/engine/shared";

/** Flag file under the state directory (`~/.0`). Delete it to see the notice again. */
export const TELEMETRY_NOTICE_FILENAME = "telemetry-notice";

export const TELEMETRY_DOCS_URL = "https://docs.0.security/configuration/#telemetry";

export const TELEMETRY_NOTICE_TEXT = [
  "0security sends anonymous usage counts and crash reports (no targets, findings or code).",
  `Learn more and opt out: ${TELEMETRY_DOCS_URL}`,
  "Disable both with ZERO_NO_TELEMETRY=1, or run `0 config set analyticsLevel off` and `0 config set diagnosticReporting off`.",
].join("\n");

const MACHINE_FLAGS = new Set(["--json", "--ndjson", "--jsonl", "--ready-json", "--sarif"]);
const MACHINE_FORMAT = /json|sarif|csv|xml|yaml|junit/i;
const QUIET_COMMANDS = new Set(["config", "reports", "workbench"]);
const INFO_FLAGS = new Set(["-h", "--help", "-V", "--version"]);

function truthy(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/** True when the arguments ask for output a machine will parse. */
export function wantsMachineOutput(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (/json/i.test(env["ZERO_LOG_FORMAT"] ?? "")) return true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (MACHINE_FLAGS.has(arg)) return true;
    if (arg === "--format" || arg === "-f") {
      if (MACHINE_FORMAT.test(args[i + 1] ?? "")) return true;
    } else if (arg.startsWith("--format=") && MACHINE_FORMAT.test(arg.slice("--format=".length))) return true;
  }
  return false;
}

export interface TelemetryNoticeOptions {
  /** User arguments (argv after the script). */
  args: readonly string[];
  /** True when analytics or crash reports could actually be sent. */
  telemetryActive: boolean;
  env?: NodeJS.ProcessEnv;
  stderrIsTTY?: boolean;
  write?: (text: string) => void;
  homeDir?: string;
}

/** Print the notice if (and only if) it is due. Returns whether it printed. Never throws. */
export function maybePrintTelemetryNotice(options: TelemetryNoticeOptions): boolean {
  try {
    const env = options.env ?? process.env;
    if (!(options.stderrIsTTY ?? process.stderr.isTTY === true)) return false;
    if (!options.telemetryActive || analyticsOptedOut(env)) return false;
    if (truthy(env["CI"]) || wantsMachineOutput(options.args, env)) return false;
    if (options.args.some((arg) => INFO_FLAGS.has(arg)) || QUIET_COMMANDS.has(options.args[0] ?? "")) return false;
    const dir = homeStateDir(options.homeDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const fd = openSync(join(dir, TELEMETRY_NOTICE_FILENAME), "wx", 0o600);
      try { writeSync(fd, `${new Date().toISOString()}\n`); } finally { closeSync(fd); }
    } catch {
      return false; // already shown, or the state directory is not writable
    }
    (options.write ?? ((text: string) => { process.stderr.write(text); }))(`${TELEMETRY_NOTICE_TEXT}\n\n`);
    return true;
  } catch {
    return false;
  }
}
