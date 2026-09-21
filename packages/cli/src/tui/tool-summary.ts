/**
 * Per-tool RESULT summaries — the "what it found" half of a tool row.
 *
 * `formatToolArgs` (tool-format.ts) already answers *what a call is about to
 * do*; this module answers *what it found*, in one bounded line, from the
 * ACTUAL `ToolResult.output` shapes in `@0/core`'s agent/tools registry.
 * OMP gives every tool a bespoke result line (`7 matches · 3 files`, `5
 * sources`, `Exit: 0`); this is the 0sec equivalent for our domain tools —
 * findings ledgers, the intel lookups, the scanner fan-out, the crawler.
 *
 * It is PURE and total: `output` may be any shape at all (a bare array, a
 * string, null, a cyclic megabyte blob), and every branch reads only the
 * fields it can prove are present. A shape we cannot pin to a source returns
 * `""`, and the caller (`formatToolResult`) then falls back to its own generic
 * count path — a wrong count is worse than an honest generic one.
 *
 * The `output` shapes were read from (file · symbol):
 *   - findings.ts / tools.ts `queryFindings`     → query_findings
 *   - todos.ts / tools.ts `updateTodos`          → update_todos, write_todos
 *   - findings.ts / tools.ts `useLoot`,`planTool`→ use_loot, plan
 *   - intel.ts `executeIntel*`                   → intel (action-discriminated)
 *   - scanner.ts / tools.ts `executeScanner`     → run_scanner (tool-discriminated)
 *   - recon.ts / tools.ts `crawl`,`webSearch`    → crawl, web_search
 *   - browser.ts / tools.ts `browserAction`      → browser (action-discriminated)
 *   - orchestrator.ts `executeStartScan`         → start_scan
 *   - system.ts / tools.ts `strReplace`,`python` → str_replace, python_exec
 */

import { fitTuiText } from "./text.js";

/** Hard ceiling on every string this module returns. Kept short: a result
 * summary rides a single transcript row next to the title + duration. */
export const MAX_RESULT_SUMMARY_CHARS = 96;

// ---------------------------------------------------------------------------
// Defensive accessors — total over any input, never throw
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function line(value: unknown): string {
  return fitTuiText(value, MAX_RESULT_SUMMARY_CHARS);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Byte size, e.g. `312 B`, `4.2 kB`, `1.3 MB`. Mirrors tool-format's helper. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Count how many advisory/lead ids are GHSA- vs CVE-. Reads each element's
 * `id` (the primary identifier on both `VulnerabilityIntel` and `AdvisoryLead`
 * in `@0/core`'s intel/types.ts) and classifies by its prefix. Ids that are
 * neither (a public-report URL, say) are not counted in either bucket.
 */
function countAdvisoryIds(rows: unknown[]): { ghsa: number; cve: number } {
  let ghsa = 0;
  let cve = 0;
  for (const row of rows) {
    const id = isPlainObject(row) ? str(row.id) : undefined;
    if (!id) continue;
    const upper = id.toUpperCase();
    if (upper.startsWith("GHSA-")) ghsa++;
    else if (upper.startsWith("CVE-")) cve++;
  }
  return { ghsa, cve };
}

/**
 * Summarise the `intel` tool result. `intel` is one tool discriminated by an
 * `action` argument, so the shape is detected from the output rather than the
 * (constant) tool name: advisory_sweep carries `counts`, lookup_cve a `found`
 * flag, search_public_reports a `reports` array, and the advisory/similar/
 * dossier/history actions an `advisories` array.
 */
function summariseIntel(out: Record<string, unknown>): string {
  // advisory_sweep → { counts:{ total, advisories, publicReports, … }, leads[] }
  const counts = out.counts;
  if (isPlainObject(counts)) {
    const leads = arr(out.leads) ?? [];
    const { ghsa, cve } = countAdvisoryIds(leads);
    const publicReports = num(counts.publicReports) ?? 0;
    const parts: string[] = [];
    if (ghsa > 0) parts.push(`${ghsa} GHSA`);
    if (cve > 0) parts.push(`${cve} CVE`);
    parts.push(`${publicReports} public`);
    const total = num(counts.total);
    if (parts.length === 1 && total !== undefined) return line(plural(total, "lead"));
    return line(parts.join(" · "));
  }
  // lookup_cve → { found:true, advisory } | { cve_id|ghsa_id, found:false }
  if ("found" in out) {
    if (out.found !== true) return line("not found");
    const advisory = out.advisory;
    const id = isPlainObject(advisory) ? str(advisory.id) : undefined;
    return line(id ? `found ${id}` : "found");
  }
  // search_public_reports → { count, totalCount, reports[] }
  const reports = arr(out.reports);
  if (reports) {
    const shown = num(out.count) ?? reports.length;
    const total = num(out.totalCount);
    return line(total !== undefined && total > shown ? `${plural(shown, "report")} of ${total}` : plural(shown, "report"));
  }
  // search_advisories / search_similar / build_dossier / search_target_history
  const advisories = arr(out.advisories);
  if (advisories) {
    const count = num(out.count) ?? advisories.length;
    const { ghsa, cve } = countAdvisoryIds(advisories);
    // The advisory array may be sliced below the true `count`; only break the
    // count down by id when the slice accounts for every advisory counted.
    if (count === advisories.length && ghsa + cve > 0) {
      const parts: string[] = [];
      if (ghsa > 0) parts.push(`${ghsa} GHSA`);
      if (cve > 0) parts.push(`${cve} CVE`);
      return line(parts.join(" · "));
    }
    return line(plural(count, "advisory", "advisories"));
  }
  return "";
}

/**
 * Summarise `run_scanner`. One tool discriminated by a `tool` argument
 * (sqlmap/nmap/ffuf/nuclei). The handler already computes a human `summary`
 * string (`summarizeScannerResult` in scanner-tools.ts), so prefer it; else
 * derive from the parsed `result` subtype, and report a skipped scanner.
 */
function summariseScanner(out: Record<string, unknown>): string {
  if (out.skipped === true) {
    const scanner = str(out.scanner);
    const reason = str(out.reason);
    return line(`skipped${scanner ? ` ${scanner}` : ""}${reason ? `: ${reason}` : ""}`);
  }
  const summary = str(out.summary);
  if (summary && summary.trim()) return line(summary.trim());
  const result = out.result;
  if (isPlainObject(result)) {
    const openPorts = arr(result.openPorts);
    if (openPorts) return line(plural(openPorts.length, "open port"));
    const findings = arr(result.findings);
    if (findings) return line(plural(findings.length, "finding"));
    const hits = arr(result.hits);
    if (hits) return line(plural(hits.length, "hit"));
    if (typeof result.vulnerable === "boolean") return line(result.vulnerable ? "injectable" : "no injection");
  }
  return "";
}

/** Summarise the `browser` tool (one tool, an `action` argument). */
function summariseBrowser(out: Record<string, unknown>): string {
  if (str(out.clicked)) return line(`clicked ${str(out.clicked)}`);
  if (str(out.filled)) return line(`filled ${str(out.filled)}`);
  const status = num(out.status);
  const title = str(out.title);
  if (status !== undefined || title) {
    return line([status !== undefined ? String(status) : undefined, title].filter(Boolean).join(" · "));
  }
  return "";
}

// ---------------------------------------------------------------------------
// toolResultSummary
// ---------------------------------------------------------------------------

/**
 * A concise one-line summary of a tool's OUTPUT, or `""` when the output shape
 * is not one we have modelled (the caller then falls back to a generic count).
 *
 * `output` is `ToolResult.output` exactly as the tool returned it — never the
 * failure branch, which the caller handles first. Only the domain tools that
 * `formatToolResult` does not already summarise are covered here.
 */
export function toolResultSummary(name: string, output: unknown): string {
  const out = output;

  switch (name) {
    // query_findings → the bare `Finding[]` array itself (not wrapped).
    case "query_findings": {
      const rows = arr(out);
      if (rows) return line(plural(rows.length, "finding"));
      return "";
    }

    // update_todos / write_todos → { done, total, todos[], line, … }.
    case "update_todos":
    case "write_todos": {
      if (!isPlainObject(out)) return "";
      const total = num(out.total);
      const done = num(out.done);
      if (total !== undefined) {
        const base = plural(total, "todo");
        return line(done !== undefined ? `${base} · ${done} done` : base);
      }
      const todos = arr(out.todos);
      if (todos) return line(plural(todos.length, "todo"));
      return "";
    }

    // use_loot → { count, items[] }.
    case "use_loot": {
      if (!isPlainObject(out)) return "";
      const count = num(out.count);
      const items = arr(out.items);
      const n = count ?? (items ? items.length : undefined);
      return n !== undefined ? line(plural(n, "loot item")) : "";
    }

    // plan → { message, open[], total }.
    case "plan": {
      if (!isPlainObject(out)) return "";
      if (out.enabled === false) return line("plan disabled");
      const total = num(out.total);
      const open = arr(out.open);
      if (total !== undefined) {
        const base = plural(total, "task");
        return line(open ? `${base} · ${open.length} open` : base);
      }
      return "";
    }

    // update_finding → { message: "Finding <id> updated to <status>" }.
    case "update_finding": {
      if (!isPlainObject(out)) return "";
      const message = str(out.message);
      return message ? line(message) : "";
    }

    // done → { done:true, summary }.
    case "done":
      return line("done");

    // intel (action-discriminated): shape-detected.
    case "intel":
      return isPlainObject(out) ? summariseIntel(out) : "";

    // run_scanner (tool-discriminated): prefer the handler's own summary.
    case "run_scanner":
      return isPlainObject(out) ? summariseScanner(out) : "";

    // crawl → { pages[], totalPages, totalLinks, totalForms }.
    case "crawl": {
      if (!isPlainObject(out)) return "";
      const pages = num(out.totalPages) ?? (arr(out.pages)?.length);
      if (pages === undefined) return "";
      const links = num(out.totalLinks);
      const forms = num(out.totalForms);
      const parts = [plural(pages, "page")];
      if (links !== undefined) parts.push(`${links} links`);
      if (forms !== undefined) parts.push(`${forms} forms`);
      return line(parts.join(" · "));
    }

    // web_search → { message, formatted, results[] }.
    case "web_search": {
      if (!isPlainObject(out)) return "";
      const results = arr(out.results);
      return results ? line(plural(results.length, "result")) : "";
    }

    // browser (action-discriminated).
    case "browser":
      return isPlainObject(out) ? summariseBrowser(out) : "";

    // start_scan → { child_scan_id, status, scan_mode, … }.
    case "start_scan": {
      if (!isPlainObject(out)) return "";
      const status = str(out.status);
      const id = str(out.child_scan_id);
      if (status || id) return line([status, id].filter(Boolean).join(" · "));
      return "";
    }

    // str_replace → { path, replacements } (+ meta.edit card).
    case "str_replace": {
      if (!isPlainObject(out)) return "";
      const n = num(out.replacements);
      return n !== undefined ? line(plural(n, "replacement")) : "";
    }

    // python_exec → { stdout, value?, stderr? }.
    case "python_exec": {
      if (!isPlainObject(out)) return "";
      const stdout = str(out.stdout) ?? "";
      const stderr = str(out.stderr);
      const errNote = stderr && stderr.trim() ? " · stderr" : "";
      if (stdout.trim().length === 0) return line(errNote ? `no output${errNote}` : "no output");
      return line(`${plural(countLines(stdout), "line")} · ${formatBytes(stdout.length)}${errNote}`);
    }

    default:
      return "";
  }
}
