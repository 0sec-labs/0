/**
 * `0 probe <url>`: send adversarial messages to a live model or agent endpoint and report the ones it obeys.
 * Each probe carries a canary, so a hit is a check on the reply and not another model's opinion. You name the URL;
 * requests are slow by default and capped, and the target is printed before anything is sent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { exportReport, isReportExportFormat, PROBES, probeFindings, runProbes, selectProbes, type ProbeResult } from "@0/engine";
import type { Finding, ScanReport } from "@0/engine/shared";
import { osecDB, resolveOsecDbPath } from "@0/engine/storage";
import { finishWithError, UsageError } from "./output.js";

const FORMATS = ["json", "md", "sarif", "html", "pdf"] as const;
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export interface ProbeOptions {
  header?: string[]; body?: string; bodyFile?: string; model?: string; responsePath?: string; probes?: string; repeat: string; delay: string;
  timeout: string; maxRequests: string; secret?: string; format: string; output?: string; failOn?: string; save?: boolean;
}
export interface ProbeDeps {
  out(bytes: Uint8Array | string): void;
  err(text: string): void;
  writeBytes(path: string, bytes: Uint8Array): void;
  readText(path: string): string;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  save?(target: string, findings: Finding[]): string;
}
const defaults: ProbeDeps = {
  out: bytes => { process.stdout.write(bytes); },
  err: text => process.stderr.write(`${text}\n`),
  writeBytes: (path, bytes) => writeFileSync(path, bytes, { mode: 0o600 }),
  readText: path => readFileSync(path, "utf8"),
  env: process.env,
  save(target, findings) {
    const db = new osecDB(resolveOsecDbPath());
    try {
      const scanId = db.createScan({ target, depth: "default", format: "json", runtime: "probe", mode: "probe" } as never);
      for (const finding of findings) db.saveFinding(scanId, finding);
      db.completeScan(scanId, { totalFindings: findings.length });
      return scanId;
    } finally { db.close(); }
  },
};

/** `Name: value`, where the value may be `$ENV_VAR` so a key is read from the environment and never typed on the command line. */
export function parseHeaders(values: readonly string[] | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of values ?? []) {
    const colon = raw.indexOf(":");
    if (colon < 1) throw new UsageError(`Header '${raw}' must look like 'Name: value'.`);
    const name = raw.slice(0, colon).trim();
    let value = raw.slice(colon + 1).trim();
    value = value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_match, key: string) => { if (env[key] === undefined) throw new UsageError(`Header '${name}' refers to $${key}, which is not set.`); return env[key]!; });
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value)) throw new UsageError(`Header '${name}' is not valid.`);
    headers[name] = value;
  }
  return headers;
}

const positive = (name: string, value: string, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new UsageError(`${name} must be a number from 0 to ${max}.`);
  return n;
};

export function toReport(target: string, results: ProbeResult[], started: Date, completed: Date, findings: Finding[]): ScanReport {
  const count = (severity: string) => findings.filter(finding => finding.severity === severity).length;
  return {
    target, scanDepth: "default", startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime(), warnings: [],
    summary: { totalAttacks: results.reduce((sum, result) => sum + result.attempts.length, 0), totalFindings: findings.length, critical: count("critical"), high: count("high"), medium: count("medium"), low: count("low"), info: count("info") },
    findings,
  } as unknown as ScanReport;
}

export async function runProbe(url: string, options: ProbeOptions, deps: ProbeDeps = defaults): Promise<number> {
  if (!(FORMATS as readonly string[]).includes(options.format)) throw new UsageError(`--format must be one of: ${FORMATS.join(", ")}.`);
  if (options.format === "pdf" && !options.output) throw new UsageError("PDF is binary; supply -o <file>.");
  if (options.failOn !== undefined && !(SEVERITIES as readonly string[]).includes(options.failOn)) throw new UsageError(`--fail-on must be one of: ${SEVERITIES.join(", ")}.`);
  if (options.body && options.bodyFile) throw new UsageError("Use --body or --body-file, not both.");
  const repeat = positive("--repeat", options.repeat, 10), delay = positive("--delay", options.delay, 60_000), timeout = positive("--timeout", options.timeout, 600), max = positive("--max-requests", options.maxRequests, 1000);
  let probes; try { probes = selectProbes(options.probes ? [options.probes] : undefined); } catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  const bodyTemplate = options.bodyFile ? deps.readText(resolve(options.bodyFile)) : options.body ?? (options.model ? `{"model":${JSON.stringify(options.model)},"messages":[{"role":"user","content":"{{prompt}}"}]}` : undefined);
  const headers = parseHeaders(options.header, deps.env);
  let host = url; try { host = new URL(url).host; } catch { /* reported by the runner */ }
  deps.err(`probing ${url} with up to ${Math.min(max, probes.length * Math.max(1, repeat))} requests (${probes.length} probes x ${Math.max(1, repeat)}), ${delay} ms apart`);
  const started = new Date();
  let run;
  try {
    run = await runProbes({ url, headers, probes, repeat, delayMs: delay, timeoutMs: timeout * 1000, maxRequests: max, ...(bodyTemplate ? { bodyTemplate } : {}), ...(options.responsePath ? { responsePath: options.responsePath } : {}), ...(options.secret ? { secret: options.secret } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), onProgress: line => deps.err(`  ${line}`) });
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  const findings = probeFindings(url, run.results);
  const errors = run.results.flatMap(result => result.attempts.filter(attempt => attempt.error));
  if (errors.length === run.requests) throw new Error(`Every request to ${host} failed: ${errors[0]!.error}`);
  if (errors.length) deps.err(`${errors.length} of ${run.requests} requests failed (${errors[0]!.error}); those probes were not judged.`);
  const report = toReport(url, run.results, started, new Date(), findings);
  const format = options.format === "md" ? "markdown" : options.format;
  if (!isReportExportFormat(format)) throw new UsageError(`--format must be one of: ${FORMATS.join(", ")}.`);
  const body = options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : (await exportReport(report, format, `0-probe-${host}`)).body;
  if (options.output) { const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body; deps.writeBytes(resolve(options.output), bytes); deps.err(`Wrote ${options.output} (${bytes.byteLength} bytes)`); } else deps.out(body);
  if (options.save && deps.save && findings.length) deps.err(`saved ${findings.length} findings as ${deps.save(url, findings).slice(0, 8)}; see \`0 findings list\``);
  deps.err(`${findings.length} of ${probes.length} probes got the attack through (${run.requests} requests)`);
  if (options.failOn && findings.some(finding => SEVERITIES.indexOf(finding.severity as typeof SEVERITIES[number]) <= SEVERITIES.indexOf(options.failOn as typeof SEVERITIES[number]))) return 1;
  return 0;
}

export function registerProbeCommand(program: Command, deps: ProbeDeps = defaults): void {
  const collect = (value: string, previous: string[] = []) => [...previous, value];
  program.command("probe <url>")
    .description("Send adversarial messages to a live model or agent endpoint and report the ones it obeys")
    .option("-H, --header <header>", "Request header, `Name: value`; the value may be $ENV_VAR so a key is not typed on the command line (repeatable)", collect)
    .option("--body <json>", "Request body as JSON with {{prompt}} where the message goes (default: an OpenAI-style chat body)")
    .option("--body-file <file>", "Read the request body from a file")
    .option("--model <name>", "Add this model name to the default chat body")
    .option("--response-path <path>", "Where the reply is in a JSON response, such as choices.0.message.content (default: tried automatically)")
    .option("--probes <ids>", `Only these probes, comma separated (${PROBES.map(probe => probe.id).join(", ")})`)
    .option("--repeat <n>", "Times each probe is sent; models vary, and a hit in any attempt counts", "2")
    .option("--delay <ms>", "Pause between requests", "300")
    .option("--timeout <seconds>", "Seconds to wait for each reply", "30")
    .option("--max-requests <n>", "Send at most this many requests", "100")
    .option("--secret <text>", "A secret known to be in the endpoint's prompt; a reply that contains it is a definite leak")
    .option("--format <format>", `Report format: ${FORMATS.join(", ")}`, "md")
    .option("-o, --output <file>", "Write the report to a file instead of stdout")
    .option("--fail-on <severity>", "Exit 1 when a finding is at or above this severity")
    .option("--save", "Also store the findings, so they show in `0 findings list`")
    .addHelpText("after", "\nA hit means the reply shows the endpoint did what the attacker asked. Exit codes: 0 done, 1 a finding at or above --fail-on, 2 usage error or the endpoint could not be reached.\nResponses are read as JSON or plain text; streamed event responses are supported for chat completions.")
    .action(async (url: string, options: ProbeOptions) => {
      try { const code = await runProbe(url, options, deps); if (code) process.exitCode = code; }
      catch (error) { finishWithError(error, { err: deps.err }, false); }
    });
}
