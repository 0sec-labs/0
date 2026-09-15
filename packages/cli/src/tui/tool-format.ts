/**
 * Operator-facing tool-activity formatting.
 *
 * The console transcript used to print each tool call as its raw JSON
 * arguments and a truncated JSON result blob. An operator watching a scan
 * therefore read `{"query":"child_process","path":"packages/core/src",...}`
 * and a half-cut `{"matches":[{"path":"...` — neither of which answers the
 * only questions they have: what is this call doing, and did it find anything?
 *
 * This module turns a (call, result) pair into short, readable, single-line
 * text. It is PURE: no I/O, no `process`, no printing, no throwing. Every
 * public function is total over its input — `arguments` may be a string, null,
 * an array, or malformed JSON, and `output` may be any shape at all.
 *
 * The per-tool summaries below are derived from the ACTUAL argument and result
 * shapes in `@0sec/core`'s agent/tools registry (see the header comment on each
 * case for where the shape was read). Anything we could not pin to a source
 * shape falls through to the generic key=value / count path rather than
 * guessing — a wrong count is worse than an honest generic one.
 */

import { fitTuiText, fitTuiUrl, sanitizeTuiText } from "./text.js";
import { toolResultSummary } from "./tool-summary.js";

export interface ToolCallLike {
  name: string;
  arguments?: unknown;
}

export interface ToolResultLike {
  success: boolean;
  output?: unknown;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on every string this module returns. The transcript renders
 * these on a single line next to a status glyph, so a value that ran to the
 * width of a 50 kB argument would wrap or clip the whole row. `fitTuiText`
 * also strips control characters and collapses whitespace, so a bounded return
 * is additionally guaranteed single-line and blob-free.
 */
export const MAX_SUMMARY_CHARS = 120;

/** Detail lines sit under the summary; keep each shorter than the summary. */
const MAX_DETAIL_CHARS = 100;
const DEFAULT_DETAIL_LINES = 3;

/**
 * Per-value budget inside a multi-field summary (generic key=value list, save
 * finding, etc.). Smaller than the line cap so several fields can share a line.
 */
const VALUE_BUDGET = 48;

// ---------------------------------------------------------------------------
// Output-body truncation (OMP-style collapse / expand)
// ---------------------------------------------------------------------------

/**
 * Collapsed line cap for a tool/command OUTPUT body. oh-my-pi's default tool
 * renderer caps output to the FIRST N lines and draws a `… N more lines`
 * expander under it (see `@oh-my-pi/pi-coding-agent` `tools/default-renderer.ts`,
 * `maxOutputLines = expanded ? 12 : 4`). We keep a slightly roomier head window
 * so an ordinary command still shows in full, and reveal the full retained body
 * on expand. This is a HEAD window — the first `cap` lines — matching OMP.
 */
export const COLLAPSED_OUTPUT_LINES = 14;

/** The head window drawn for a (possibly long) output body. */
export interface OutputWindow {
  /** The first `cap` lines actually drawn — or all of them when they fit. */
  readonly visible: readonly string[];
  /** How many lines fall below the window; 0 when nothing was dropped. */
  readonly hidden: number;
}

/**
 * Keep the FIRST `cap` lines of an output body (the OMP head window) and report
 * how many were dropped, so the caller can draw a `… N more lines` expander.
 * Pure and total: a non-finite / negative cap collapses to 0.
 */
export function capOutputLines(lines: readonly string[], cap: number): OutputWindow {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : 0;
  if (lines.length <= limit) return { visible: lines, hidden: 0 };
  return { visible: lines.slice(0, limit), hidden: lines.length - limit };
}

/**
 * The muted expander line OMP draws beneath a capped body, e.g.
 * `… 47 more lines · [⌃R] to expand`. The leading `… ` and the `N more line(s)`
 * wording match oh-my-pi's default renderer; `hint` is the bracketed key legend
 * the caller assembles (via {@link keyGlyph}/{@link keyLegend}) and is appended
 * after a ` · ` when present. Returns `""` when nothing is hidden.
 */
export function moreLinesAffordance(hidden: number, hint = ""): string {
  const n = Number.isFinite(hidden) ? Math.max(0, Math.trunc(hidden)) : 0;
  if (n <= 0) return "";
  const base = `… ${n} more line${n === 1 ? "" : "s"}`;
  return hint ? `${base} · ${hint}` : base;
}

// ---------------------------------------------------------------------------
// Secrets discipline
// ---------------------------------------------------------------------------

/**
 * Keys whose VALUE is treated as credential-bearing and replaced before it can
 * reach the transcript. Matched case-insensitively as a substring of the key,
 * so `Authorization`, `X-API-Key`, `sessionToken`, and `db_password` are all
 * covered. The doctrine here is "when in doubt, redact": a bare `auth` or
 * `key` will over-match a few innocent keys, and that is the intended trade —
 * a redacted description of a real field beats leaking a bearer token into a
 * durable log.
 */
const CREDENTIAL_KEY_PATTERN =
  /(authorization|auth|bearer|api[\W_]*key|access[\W_]*key|secret|password|passwd|pwd|token|cookie|session|credential|private[\W_]*key|client[\W_]*secret|passphrase|x[\W_]*api[\W_]*key)/i;

const REDACTED = "[redacted]";

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// Defensive accessors — total over any input, never throw
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce a tool call's `arguments` into a record we can read fields off.
 * `arguments` reaches us as whatever the model/provider produced: an object in
 * the happy path, but also a JSON string, a bare string, null, or an array. A
 * JSON string that parses to an object is unwrapped; everything else yields an
 * empty record so field lookups are safe no-ops (the raw value is still
 * available to the generic path via {@link rawArguments}).
 */
function argRecord(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      /* not JSON — fall through to empty record */
    }
  }
  return {};
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

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Sanitize + cap to the summary line ceiling. */
function line(value: unknown): string {
  return fitTuiText(value, MAX_SUMMARY_CHARS);
}

/** Sanitize + cap a value fragment, keeping the middle of long paths/URLs. */
function frag(value: unknown, budget = VALUE_BUDGET): string {
  return fitTuiText(value, budget, { mode: "middle" });
}

/** Human byte size, e.g. `312 B`, `4.2 kB`, `1.3 MB`. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 byte length; falls back to code-unit count if TextEncoder is absent. */
function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A single flat token for an arbitrary value, WITHOUT recursing — a scanner
 * result can carry cyclic or megabyte-deep objects, and `JSON.stringify` would
 * throw on the former and blow the line budget on the latter. Containers
 * collapse to their size; scalars render (redacted when the key demands it).
 */
function briefValue(key: string, value: unknown): string {
  if (isCredentialKey(key)) return REDACTED;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return `{${Object.keys(value as object).length}}`;
  return frag(str(value) ?? "");
}

/**
 * Render a record as `key=value` fragments, most-salient first. "Salient" is a
 * fixed priority list of the fields an operator cares about across tools
 * (target/url/path/command/…); the rest follow in insertion order. Longest
 * values are already bounded by {@link briefValue}.
 */
const SALIENT_KEYS = [
  "url",
  "path",
  "query",
  "command",
  "task",
  "binary_path",
  "title",
  "name",
  "action",
  "target",
  "method",
  "id",
];

function kvSummary(record: Record<string, unknown>, maxPairs = 4): string {
  const keys = Object.keys(record);
  keys.sort((a, b) => {
    const ia = SALIENT_KEYS.indexOf(a);
    const ib = SALIENT_KEYS.indexOf(b);
    const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
    const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
    return ra - rb;
  });

  const pairs: string[] = [];
  for (const key of keys) {
    if (pairs.length >= maxPairs) break;
    const rendered = briefValue(key, record[key]);
    if (rendered === "") continue;
    pairs.push(`${key}=${rendered}`);
  }
  return line(pairs.join(" "));
}

/** Distinct entries of `field` across an array of result rows. */
function distinctCount(rows: unknown[], field: string): number {
  const seen = new Set<string>();
  for (const row of rows) {
    if (isPlainObject(row)) {
      const v = row[field];
      if (typeof v === "string") seen.add(v);
    }
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// formatToolArgs
// ---------------------------------------------------------------------------

/**
 * One-line summary of what a call is about to do.
 *
 * Each covered case reads the argument schema of the matching tool in
 * `@0sec/core` agent/tools; unknown tools use {@link kvSummary}.
 */
export function formatToolArgs(call: ToolCallLike): string {
  const name = typeof call?.name === "string" ? call.name : "";
  const a = argRecord(call?.arguments);

  switch (name) {
    // search_files — args { query, path?, case_sensitive?, max_results? }
    // (packages/core/src/agent/tools/system.ts). Matches the transcript sample
    // exactly: `"child_process" in packages/core/src`.
    case "search_files": {
      const query = str(a.query) ?? "";
      const path = str(a.path);
      const q = `"${query}"`;
      return line(path ? `${q} in ${path}` : q);
    }

    // list_files — args { path?, limit? }.
    case "list_files": {
      const path = str(a.path);
      return line(path ?? "(scope root)");
    }

    // read_file — args { path, max_lines?, offset? }. Offset is 1-based.
    case "read_file": {
      const path = frag(str(a.path) ?? "", 90);
      const offset = num(a.offset);
      return line(offset && offset > 1 ? `${path} @${offset}` : path);
    }

    // run_command — args { command, cwd?, timeout? }.
    case "run_command":
    case "bash": {
      return line(str(a.command) ?? "(no command)");
    }

    // http_request — args { url, method?, body?, headers? }. Method defaults to
    // POST server-side (recon.ts). Headers can carry credentials → never shown
    // here; only method + url are.
    case "http_request": {
      const method = (str(a.method) ?? "POST").toUpperCase();
      const url = frag(str(a.url) ?? "", 90);
      return line(`${method} ${url}`);
    }

    // apply_patch — arg { patch } is a string envelope; count its file ops
    // (Add/Update/Delete File markers) rather than dumping the DSL.
    case "apply_patch": {
      const patch = str(a.patch) ?? "";
      const ops = (patch.match(/^\*\*\*\s+(Add|Update|Delete)\s+File:/gim) ?? []).length;
      return line(ops > 0 ? `${plural(ops, "file")}` : "patch");
    }

    // save_finding — args { title, severity, category, ... }.
    case "save_finding": {
      const severity = str(a.severity);
      const category = str(a.category);
      const title = str(a.title);
      const head = [severity, category].filter(Boolean).join(" ");
      if (title && head) return line(`${head}: ${title}`);
      return line(title ?? head ?? "finding");
    }

    // spawn_agent — args { task, max_turns? }.
    case "spawn_agent": {
      return line(str(a.task) ?? "(no task)");
    }

    // spawn_agents — args { tasks: Array<{ task, max_turns? }> }.
    case "spawn_agents": {
      const tasks = arr(a.tasks) ?? [];
      const first = tasks.length > 0 && isPlainObject(tasks[0]) ? str(tasks[0].task) : undefined;
      const count = plural(tasks.length, "agent");
      return line(first ? `${count}: ${frag(first, 70)}` : count);
    }

    // analyze_binary — args { binary_path, bug_class?, backend?, timeout_s? }
    // (packages/core/src/agent/tools/0verse.ts).
    case "analyze_binary": {
      const path = frag(str(a.binary_path) ?? "", 80);
      const bugClass = str(a.bug_class);
      return line(bugClass ? `${path} (${bugClass})` : path);
    }

    // query_findings — args { limit?, severity?, category?, status?,
    // all_sessions?, scan_id? } (packages/core/src/agent/tools/findings.ts).
    case "query_findings": {
      const filters = [str(a.severity), str(a.category), str(a.status)].filter(Boolean);
      if (a.all_sessions === true) filters.push("all sessions");
      const scan = str(a.scan_id);
      if (scan) filters.push(`scan ${scan}`);
      const limit = num(a.limit);
      const lim = limit !== undefined ? `(limit ${limit})` : "";
      return line([filters.join(" "), lim].filter(Boolean).join(" "));
    }

    // update_todos / write_todos — args { todos: Array<{ content, status? }> }
    // (packages/core/src/agent/tools/todos.ts).
    case "update_todos":
    case "write_todos": {
      const todos = arr(a.todos) ?? [];
      return line(plural(todos.length, "task"));
    }

    // intel — one tool discriminated by `action`; the action leads the summary
    // so the card can promote it to the title verb (see `toolActionTitle`).
    // args { action, cve_id?, ghsa_id?, ecosystem?, package_name?, version?,
    // repository?, terms?, cwe?, keywords? } (agent/tools/intel.ts).
    case "intel": {
      const action = str(a.action) ?? "";
      const inputs: string[] = [];
      const pkg = str(a.package_name);
      if (pkg) {
        const eco = str(a.ecosystem);
        const ver = str(a.version);
        inputs.push(`${eco ? `${eco}:` : ""}${pkg}${ver ? `@${ver}` : ""}`);
      }
      const repo = str(a.repository);
      if (repo) inputs.push(repo);
      const cve = str(a.cve_id);
      if (cve) inputs.push(cve);
      const ghsa = str(a.ghsa_id);
      if (ghsa) inputs.push(ghsa);
      const terms = str(a.terms);
      if (terms) inputs.push(`"${terms}"`);
      const cwe = str(a.cwe);
      if (cwe) inputs.push(cwe);
      const keywords = str(a.keywords);
      if (keywords && !cwe) inputs.push(keywords);
      return line([action, frag(inputs.join(" "), 80)].filter(Boolean).join(" "));
    }

    // run_scanner — one tool discriminated by `tool` (sqlmap/nmap/ffuf/nuclei);
    // the scanner name leads so the card can promote it to the title verb.
    // args { tool, url?, target?, ports?, ... } (agent/tools/scanner.ts).
    case "run_scanner": {
      const tool = str(a.tool) ?? "";
      const target = str(a.url) ?? str(a.target);
      return line([tool, target ? frag(target, 70) : ""].filter(Boolean).join(" "));
    }

    // crawl — args { url, depth? } (packages/core/src/agent/tools/recon.ts).
    case "crawl": {
      const url = frag(str(a.url) ?? "", 80);
      const depth = num(a.depth);
      return line(depth !== undefined ? `${url} (depth ${depth})` : url);
    }

    // web_search — args { query } (packages/core/src/agent/tools/recon.ts).
    case "web_search": {
      const query = str(a.query) ?? "";
      return line(`"${query}"`);
    }

    // browser — one tool discriminated by `action`; the action leads so the
    // card can promote it to the title verb. args { action, url?, selector?,
    // value? } (packages/core/src/agent/tools/browser.ts).
    case "browser": {
      const action = str(a.action) ?? "";
      const what = str(a.url) ?? str(a.selector);
      return line([action, what ? frag(what, 70) : ""].filter(Boolean).join(" "));
    }

    // use_loot — args { kind?, search?, id? }
    // (packages/core/src/agent/tools/findings.ts).
    case "use_loot": {
      const parts = [str(a.kind), str(a.id), str(a.search)].filter(Boolean);
      return line(parts.length > 0 ? parts.join(" ") : "(all loot)");
    }

    // plan — args { action, title?, id?, detail? }
    // (packages/core/src/agent/tools/findings.ts).
    case "plan": {
      const action = str(a.action) ?? "";
      const title = str(a.title) ?? str(a.id);
      return line([action, title ? frag(title, 70) : ""].filter(Boolean).join(" "));
    }

    // start_scan — args { target, ecosystem?, mode? }
    // (packages/core/src/agent/tools/orchestrator.ts).
    case "start_scan": {
      const target = frag(str(a.target) ?? "", 70);
      const eco = str(a.ecosystem);
      return line(eco ? `${target} (${eco})` : target);
    }

    // str_replace — args { path, old_string, new_string, replace_all? }.
    case "str_replace": {
      return line(frag(str(a.path) ?? "", 90));
    }

    default: {
      // Unknown tool: fall back to the generic key=value summary. A bare/JSON
      // string that did not parse to a record is shown directly (bounded),
      // which beats an empty summary for tools we have not modelled.
      const summary = kvSummary(a);
      if (summary) return summary;
      if (typeof call?.arguments === "string") return line(call.arguments);
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// formatToolResult
// ---------------------------------------------------------------------------

/**
 * One-line summary of the OUTCOME of a call.
 *
 * Failures are first-class: when `success` is false the line leads with the
 * failure and carries the error text, trimmed to one bounded line — the
 * operator never has to expand a detail view to learn a call failed.
 */
export function formatToolResult(call: ToolCallLike, result: ToolResultLike): string {
  if (!result || result.success !== true) {
    const err = str(result?.error) ?? "";
    return line(err ? `failed: ${err}` : "failed");
  }

  const name = typeof call?.name === "string" ? call.name : "";
  const out = result.output;

  switch (name) {
    // search_files → { matches: Array<{ path, line, content }>, truncated }
    // (packages/core/src/agent/tools/scoped-source.ts).
    case "search_files": {
      if (isPlainObject(out)) {
        const matches = arr(out.matches) ?? [];
        const files = distinctCount(matches, "path");
        const base = `${plural(matches.length, "match", "matches")} in ${plural(files, "file")}`;
        return line(out.truncated === true ? `${base} (truncated)` : base);
      }
      return genericResult(out);
    }

    // list_files → { files: string[], truncated }.
    case "list_files": {
      if (isPlainObject(out)) {
        const files = arr(out.files) ?? [];
        const base = plural(files.length, "file");
        return line(out.truncated === true ? `${base} (truncated)` : base);
      }
      return genericResult(out);
    }

    // read_file → { content, totalLines, truncated, startLine, endLine, ... }.
    case "read_file": {
      if (isPlainObject(out)) {
        const total = num(out.totalLines);
        if (total !== undefined) {
          const base = plural(total, "line");
          return line(out.truncated === true ? `${base} (windowed)` : base);
        }
      }
      return genericResult(out);
    }

    // run_command / bash → output is a plain string (executePipeline returns
    // stdout). Summarize its size so a big grep does not paste into the log.
    case "run_command":
    case "bash": {
      const text = str(out) ?? "";
      if (text.trim().length === 0) return line("no output");
      return line(`${plural(countLines(text), "line")} · ${formatBytes(byteLength(text))}`);
    }

    // http_request → { status, headers, body, waf? }. Body is already
    // credential-redacted server-side; we report status + body size.
    case "http_request": {
      if (isPlainObject(out)) {
        const status = num(out.status);
        const body = str(out.body) ?? "";
        const size = formatBytes(byteLength(body));
        const waf = isPlainObject(out.waf) && out.waf.blocked === true ? " · WAF blocked" : "";
        return line(`${status ?? "?"} · ${size}${waf}`);
      }
      return genericResult(out);
    }

    // apply_patch → { applied: Array<{ kind, path }> }.
    case "apply_patch": {
      if (isPlainObject(out)) {
        const applied = arr(out.applied) ?? [];
        return line(`${plural(applied.length, "file")} patched`);
      }
      return genericResult(out);
    }

    // save_finding → { findingId, message }.
    case "save_finding": {
      if (isPlainObject(out)) {
        const id = str(out.findingId);
        return line(id ? `saved ${id}` : "saved");
      }
      return genericResult(out);
    }

    // spawn_agent → { turns, findings, summary, done }.
    case "spawn_agent": {
      if (isPlainObject(out)) {
        const findings = num(out.findings) ?? 0;
        const turns = num(out.turns) ?? 0;
        return line(`${plural(findings, "finding")} in ${plural(turns, "turn")}`);
      }
      return genericResult(out);
    }

    // spawn_agents → { spawned, succeeded, failed, agents }.
    case "spawn_agents": {
      if (isPlainObject(out)) {
        const spawned = num(out.spawned) ?? 0;
        const ok = num(out.succeeded) ?? 0;
        const failed = num(out.failed) ?? 0;
        return line(`${plural(spawned, "agent")}: ${ok} ok, ${failed} failed`);
      }
      return genericResult(out);
    }

    // analyze_binary → { confirmed: [], hypotheses: [], note, stats, ... }.
    case "analyze_binary": {
      if (isPlainObject(out)) {
        const confirmed = (arr(out.confirmed) ?? []).length;
        const hypotheses = (arr(out.hypotheses) ?? []).length;
        return line(`${confirmed} confirmed, ${hypotheses} hypotheses`);
      }
      return genericResult(out);
    }

    default: {
      // The domain tools (findings ledger, intel lookups, scanner fan-out,
      // crawler, …) carry their own bespoke one-liner; fall back to the
      // generic count only when even that has nothing truthful to say.
      const summary = toolResultSummary(name, out);
      return summary || genericResult(out);
    }
  }
}


/**
 * Generic result summary for unknown tools / unexpected shapes. Prefers a
 * count of array entries or object keys over the underlying text — the whole
 * point of this module is to never repaint a JSON blob.
 */
function genericResult(out: unknown): string {
  if (out === null || out === undefined) return line("ok");
  if (Array.isArray(out)) return line(plural(out.length, "item"));
  if (typeof out === "string") {
    if (out.trim().length === 0) return line("ok");
    return line(`${plural(countLines(out), "line")} · ${formatBytes(byteLength(out))}`);
  }
  if (typeof out === "object") return line(plural(Object.keys(out as object).length, "field"));
  return line(str(out) ?? "ok");
}

// ---------------------------------------------------------------------------
// toolResultDetail
// ---------------------------------------------------------------------------

/**
 * Extra detail lines shown UNDER the summary; may be empty. Bounded to
 * `maxLines` short lines. Only the tools where a couple of concrete rows help
 * an operator triage (which files matched, which child failed) return detail;
 * everything else returns `[]` deliberately.
 */
export function toolResultDetail(
  call: ToolCallLike,
  result: ToolResultLike,
  maxLines = DEFAULT_DETAIL_LINES,
): string[] {
  const cap = Number.isFinite(maxLines) ? Math.max(0, Math.trunc(maxLines)) : DEFAULT_DETAIL_LINES;
  if (cap === 0) return [];
  if (!result || result.success !== true) return [];

  const name = typeof call?.name === "string" ? call.name : "";
  const out = result.output;
  const detail = (value: unknown): string => fitTuiText(value, MAX_DETAIL_CHARS, { mode: "middle" });

  switch (name) {
    // Show where the first matches landed, `path:line`.
    case "search_files": {
      if (!isPlainObject(out)) return [];
      const matches = arr(out.matches) ?? [];
      const lines: string[] = [];
      for (const m of matches) {
        if (lines.length >= cap) break;
        if (isPlainObject(m)) {
          const path = str(m.path) ?? "?";
          const ln = num(m.line);
          lines.push(detail(ln !== undefined ? `${path}:${ln}` : path));
        }
      }
      return lines;
    }

    // Show the first files listed.
    case "list_files": {
      if (!isPlainObject(out)) return [];
      const files = arr(out.files) ?? [];
      return files.slice(0, cap).map((f) => detail(str(f) ?? "?"));
    }

    // Show each patched file with its op kind.
    case "apply_patch": {
      if (!isPlainObject(out)) return [];
      const applied = arr(out.applied) ?? [];
      const lines: string[] = [];
      for (const op of applied) {
        if (lines.length >= cap) break;
        if (isPlainObject(op)) {
          const kind = str(op.kind) ?? "edit";
          const path = str(op.path) ?? "?";
          lines.push(detail(`${kind} ${path}`));
        }
      }
      return lines;
    }

    // Surface any child agent that failed, so a partial fan-out is visible.
    case "spawn_agents": {
      if (!isPlainObject(out)) return [];
      const agents = arr(out.agents) ?? [];
      const lines: string[] = [];
      for (const child of agents) {
        if (lines.length >= cap) break;
        if (isPlainObject(child) && child.ok === false) {
          lines.push(detail(`agent ${str(child.index) ?? "?"} failed: ${str(child.error) ?? ""}`));
        }
      }
      return lines;
    }

    // Confirmed PoVs are the operator's headline; list their titles.
    case "analyze_binary": {
      if (!isPlainObject(out)) return [];
      const confirmed = arr(out.confirmed) ?? [];
      const lines: string[] = [];
      for (const f of confirmed) {
        if (lines.length >= cap) break;
        if (isPlainObject(f)) {
          const title = str(f.title) ?? str(f.bug_class) ?? sanitizeTuiText(f);
          lines.push(detail(title));
        }
      }
      return lines;
    }

    default:
      return [];
  }
}

/**
 * One inline image found in a tool result.
 *
 * Every field except `index` is OPTIONAL and is populated only when the datum
 * genuinely appeared in (or could be read straight out of) the result payload.
 * `pixelWidth`/`pixelHeight` in particular are decoded from the image's own
 * header bytes, or copied from explicit numeric width/height fields the result
 * carried — they are never estimated, and a payload whose header we cannot read
 * yields an entry with no dimensions at all rather than a plausible guess.
 *
 * No I/O happens to produce one of these: the bytes must already be inline in
 * the tool output. A result that references an image by URL keeps the `url` and
 * is never fetched.
 */
export interface ToolPreviewImage {
  /** 1-based position among the images found in this result, in encounter order. */
  index: number;
  /** The media type the result declared, verbatim (e.g. "image/png"). */
  mimeType?: string;
  /** Short format token, from the declared media type or the sniffed header. */
  format?: string;
  /** Actual decoded pixel width, read from the payload header or an explicit field. */
  pixelWidth?: number;
  /** Actual decoded pixel height, read from the payload header or an explicit field. */
  pixelHeight?: number;
  /** Exact decoded size of the inline payload in bytes, when it is inline. */
  byteSize?: number;
  /** The base64 payload exactly as the result carried it, when inlined. */
  data?: string;
  /** A URL the result referenced instead of inlining bytes. Never fetched here. */
  url?: string;
  /** Alt / caption text the result supplied alongside the image. */
  alt?: string;
}

/** A bounded, already-redacted presentation projection, not raw tool output. */
export interface ToolPreview {
  kind: "code" | "tree" | "text";
  language?: string;
  lines: readonly string[];
  truncated: boolean;
  /**
   * Inline images carried by the result, in encounter order. Absent (rather
   * than empty) when the result carried none, so existing consumers and
   * snapshots of image-free previews are byte-identical.
   */
  images?: readonly ToolPreviewImage[];
}

const PREVIEW_CHARS = 32_768;
const PREVIEW_LINES = 128;
const PREVIEW_LINE_CHARS = 512;
const PREVIEW_DEPTH = 4;
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  json: "json", py: "python", sh: "bash", bash: "bash", yaml: "yaml", yml: "yaml",
  rs: "rust", go: "go", c: "c", h: "c", cpp: "cpp", css: "css", html: "html",
};

/** Inspect only data properties; a preview must not invoke output getters. */
function previewProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function scrubPreviewText(text: string): string {
  return text
    .replace(/-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/^(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gim, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [redacted]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?key|secret|password|passwd|token|cookie|credential|passphrase)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
}

/**
 * Project actual output before it enters the transcript. Traversal, strings,
 * depth and line lengths are bounded before formatting; no whole-object JSON.
 */
export function projectToolPreview(call: ToolCallLike, result: ToolResultLike): ToolPreview {
  const lines: string[] = [];
  const rawOutput = previewProperty(result, "output");
  let remaining = PREVIEW_CHARS;
  let truncated = previewProperty(rawOutput, "truncated") === true;
  let nodes = 0;
  const visited = new WeakSet<object>();
  const append = (text: string) => {
    if (remaining <= 0 || lines.length >= PREVIEW_LINES) { truncated = true; return; }
    const cap = Math.min(remaining, PREVIEW_LINE_CHARS);
    if (text.length > cap) truncated = true;
    const safe = fitTuiText(sanitizeTuiText(text.slice(0, cap + 1)), cap);
    lines.push(safe);
    remaining -= safe.length;
  };
  const textLines = (text: string, prefix = "") => {
    const cap = Math.min(remaining, PREVIEW_CHARS);
    if (text.length > cap) truncated = true;
    const bounded = scrubPreviewText(text.slice(0, cap));
    let start = 0;
    while (start <= bounded.length && lines.length < PREVIEW_LINES && remaining > 0) {
      const end = bounded.indexOf("\n", start);
      append(prefix + bounded.slice(start, end < 0 ? bounded.length : end));
      if (end < 0) return;
      start = end + 1;
    }
    if (start < bounded.length) truncated = true;
  };
  const visit = (value: unknown, prefix: string, key: string, depth: number) => {
    if (++nodes > PREVIEW_LINES || lines.length >= PREVIEW_LINES || remaining <= 0) { truncated = true; return; }
    const label = key ? `${sanitizeTuiText(key.slice(0, 128))}: ` : "";
    if (key && (key.length > 128 || isCredentialKey(key))) { append(`${prefix}${label}${REDACTED}`); return; }
    if (typeof value === "string") {
      // A large inline binary payload (a base64 image, say) is not readable
      // text: spelling 32 kB of it into the card tells the operator nothing and
      // buries the rest of the result. Report what it actually is instead.
      const binary = binaryPayloadNote(key, value);
      if (binary) { append(`${prefix}${label}${binary}`); return; }
      textLines(value, prefix + label); return;
    }
    if (value === undefined) return; // an absent field renders nothing, never "undefined"
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      append(`${prefix}${label}${String(value)}`); return; // a real null stays "null"
    }
    if (typeof value !== "object") { append(`${prefix}${label}[${typeof value}]`); return; }
    if (visited.has(value)) { append(`${prefix}${label}[circular]`); return; }
    if (depth >= PREVIEW_DEPTH) { append(`${prefix}${label}…`); truncated = true; return; }
    visited.add(value);
    append(`${prefix}${label}${Array.isArray(value) ? "[]" : "{}"}`);
    try {
      const childPrefix = prefix.endsWith("├─ ") ? `${prefix.slice(0, -3)}│  `
        : prefix.endsWith("└─ ") ? `${prefix.slice(0, -3)}   ` : prefix;
      // Stop enumerating at the remaining node budget; do not allocate Object.keys.
      const keys: string[] = [];
      for (const child in value) {
        if (!Object.hasOwn(value, child)) continue;
        // A data property explicitly set to `undefined` is an ABSENT field, not
        // a value: drop it before it can render as the literal "undefined". A
        // real `null` is a value and is kept (rendered below). Accessors — where
        // `"value"` is absent from the descriptor — are left in and reported as
        // "[accessor omitted]". Reading the descriptor never invokes a getter.
        const descriptor = Object.getOwnPropertyDescriptor(value, child);
        if (descriptor && "value" in descriptor && descriptor.value === undefined) continue;
        if (keys.length >= PREVIEW_LINES - nodes) { truncated = true; break; }
        keys.push(child);
      }
      keys.forEach((child, index) => {
        if (nodes >= PREVIEW_LINES || remaining <= 0 || lines.length >= PREVIEW_LINES) { truncated = true; return; }
        const descriptor = Object.getOwnPropertyDescriptor(value, child);
        visit(descriptor && "value" in descriptor ? descriptor.value : "[accessor omitted]",
          `${childPrefix}${index === keys.length - 1 ? "└─ " : "├─ "}`, child, depth + 1);
      });
    } catch {
      append(`${prefix}└─ [unreadable value]`);
    }
  };

  let output = rawOutput;
  let language: string | undefined;
  let kind: ToolPreview["kind"] = typeof output === "object" && output !== null ? "tree" : "text";
  const name = previewProperty(call, "name");
  if (name === "read_file") {
    const content = previewProperty(output, "content");
    if (typeof content === "string") output = content;
    const path = previewProperty(previewProperty(call, "arguments"), "path");
    if (typeof path === "string") language = LANGUAGE_BY_EXTENSION[path.slice(-32).split(".").pop()?.toLowerCase() ?? ""];
    if (typeof output === "string") kind = language ? "code" : "text";
  } else if (name === "apply_patch") {
    const diff = typeof output === "string" ? output : previewProperty(output, "diff");
    if (typeof diff === "string") {
      output = diff;
      language = "diff";
      kind = "text";
    }
  } else if ((name === "run_command" || name === "bash") && typeof output === "string") {
    language = "bash";
    kind = "code";
  } else if (name === "http_request") {
    const body = previewProperty(output, "body");
    if (typeof body === "string") {
      output = body;
      kind = "text";
    }
  }
  const error = previewProperty(result, "error");
  if (typeof error === "string" && error) textLines(error);
  if (output !== undefined) visit(output, "", "", 0);
  const images = extractPreviewImages(rawOutput);
  return {
    kind,
    ...(language ? { language } : {}),
    lines,
    truncated,
    ...(images.length > 0 ? { images } : {}),
  };
}


// ---------------------------------------------------------------------------
// Inline images
// ---------------------------------------------------------------------------

/**
 * Ceiling on images reported from one result. A tool that returns a contact
 * sheet must not be able to turn one transcript row into fifty cards.
 */
const MAX_PREVIEW_IMAGES = 8;

/** Bounds on the defensive walk that looks for image blocks. */
const IMAGE_SCAN_DEPTH = 6;
const IMAGE_SCAN_NODES = 512;

/**
 * How much of a base64 payload is decoded to read its header. PNG, GIF, BMP and
 * WebP declare their size in the first 32 bytes; JPEG hides it behind a marker
 * chain, which this covers for every ordinary encoder. A payload whose header
 * is further in simply reports no dimensions.
 */
const IMAGE_HEADER_B64_CHARS = 8192;

/** Keys whose string value is a binary blob rather than readable text. */
const BINARY_VALUE_KEYS = /^(data|base64|b64|b64_json|bytes|blob|content_base64|image_data)$/i;

const IMAGE_MIME_FORMAT: Record<string, string> = {
  "image/png": "png",
  "image/apng": "apng",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

/** Exact decoded length of a base64 string, or undefined when it is not base64. */
export function base64ByteLength(value: string): number | undefined {
  // Bound the scan: a megabyte payload need not be regex-scrubbed in full to
  // be measured, but its length is what we are measuring, so count instead.
  let chars = 0;
  let padding = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c === 32) continue;
    if (c === 61) { padding++; chars++; continue; }
    const ok =
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 43 || c === 47 || c === 45 || c === 95;
    if (!ok) return undefined;
    chars++;
  }
  if (chars === 0 || chars % 4 !== 0) {
    // Unpadded base64 is still measurable, but reject obvious non-payloads.
    if (chars < 8) return undefined;
  }
  const bytes = Math.floor((chars * 3) / 4) - Math.min(2, padding);
  return bytes > 0 ? bytes : undefined;
}

/**
 * A one-line stand-in for a long inline binary value, e.g.
 * `[binary, 84.2 kB base64]`. Returns "" when the value is ordinary text and
 * should be printed as-is.
 */
function binaryPayloadNote(key: string, value: string): string {
  if (value.length < 512) return "";
  const looksKeyed = BINARY_VALUE_KEYS.test(key);
  const dataUri = /^data:[^;,]*;base64,/i.test(value);
  if (!looksKeyed && !dataUri) return "";
  const payload = dataUri ? value.slice(value.indexOf(",") + 1) : value;
  const bytes = base64ByteLength(payload);
  return bytes === undefined ? "" : `[binary, ${formatBytes(bytes)}]`;
}

/** Decode the leading `chars` characters of a base64 payload, defensively. */
function decodeBase64Prefix(value: string, chars: number): Uint8Array | undefined {
  try {
    const head = value.slice(0, Math.max(4, chars * 2)).replace(/[^A-Za-z0-9+/_=-]/g, "");
    const normalized = head.replace(/-/g, "+").replace(/_/g, "/");
    const usable = normalized.slice(0, Math.min(chars, normalized.length - (normalized.length % 4)));
    if (usable.length < 4) return undefined;
    return new Uint8Array(Buffer.from(usable, "base64"));
  } catch {
    return undefined;
  }
}

function be16(b: Uint8Array, i: number): number { return (b[i]! << 8) | b[i + 1]!; }
function be32(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
}
function le16(b: Uint8Array, i: number): number { return b[i]! | (b[i + 1]! << 8); }
function le24(b: Uint8Array, i: number): number { return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16); }
function le32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}

/**
 * Read the REAL pixel size out of an image's own header bytes.
 *
 * Supports the container formats whose dimensions live in a fixed-position
 * header (PNG, GIF, BMP, WebP) plus JPEG, whose size sits behind a marker walk.
 * Anything else — or a truncated prefix — returns `undefined`, and the caller
 * then renders no dimensions at all. Total over any input; never throws.
 */
export function imagePixelSize(
  bytes: Uint8Array | undefined,
): { width: number; height: number; format: string } | undefined {
  if (!bytes || bytes.length < 16) return undefined;
  const b = bytes;
  // PNG: \x89PNG\r\n\x1a\n, then an IHDR chunk whose payload starts at 16.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a &&
      b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    const width = be32(b, 16);
    const height = be32(b, 20);
    if (width > 0 && height > 0) return { width, height, format: "png" };
    return undefined;
  }
  // GIF87a / GIF89a: little-endian logical screen size at offset 6.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    const width = le16(b, 6);
    const height = le16(b, 8);
    if (width > 0 && height > 0) return { width, height, format: "gif" };
    return undefined;
  }
  // BMP: "BM", then a DIB header with signed 32-bit dimensions at 18 / 22.
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const width = le32(b, 18) | 0;
    const height = le32(b, 22) | 0;
    if (width > 0 && height !== 0) return { width, height: Math.abs(height), format: "bmp" };
    return undefined;
  }
  // WebP: "RIFF" .... "WEBP" then a VP8X / VP8L / VP8 chunk.
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8X" && b.length >= 30) {
      const width = le24(b, 24) + 1;
      const height = le24(b, 27) + 1;
      if (width > 0 && height > 0) return { width, height, format: "webp" };
    } else if (chunk === "VP8 " && b.length >= 30) {
      const width = le16(b, 26) & 0x3fff;
      const height = le16(b, 28) & 0x3fff;
      if (width > 0 && height > 0) return { width, height, format: "webp" };
    } else if (chunk === "VP8L" && b.length >= 25) {
      const bits = le32(b, 21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height, format: "webp" };
    }
    return undefined;
  }
  // JPEG: walk the marker chain to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    // Every iteration advances by at least two bytes, so the walk is linear.
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      let marker = b[i + 1]!;
      let j = i + 1;
      while (marker === 0xff && j + 1 < b.length) { j++; marker = b[j]!; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i = j + 1; continue; }
      const segment = j + 1;
      if (segment + 1 >= b.length) break;
      const length = be16(b, segment);
      if (length < 2) break;
      const isFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isFrame) {
        if (segment + 7 >= b.length) break;
        const height = be16(b, segment + 3);
        const width = be16(b, segment + 5);
        if (width > 0 && height > 0) return { width, height, format: "jpeg" };
        break;
      }
      if (marker === 0xda) break; // start of scan: no frame header ahead of it
      i = segment + length;
    }
    return undefined;
  }
  return undefined;
}

/** Split a `data:` URI into its media type and base64 payload, or undefined. */
function parseDataUri(value: string): { mimeType?: string; data: string } | undefined {
  const match = /^data:([^;,]*)?(?:;[^,]*)?;base64,/i.exec(value);
  if (!match) return undefined;
  const data = value.slice(match[0].length);
  if (data.length === 0) return undefined;
  const mimeType = match[1]?.toLowerCase();
  return { ...(mimeType ? { mimeType } : {}), data };
}

function positiveInt(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined) return undefined;
  const rounded = Math.round(n);
  return rounded > 0 && rounded <= 1_000_000 ? rounded : undefined;
}

/**
 * Build one image record from an already-identified payload, filling in only
 * what is knowable: the declared media type, the exact byte length, and the
 * header-decoded pixel size. Explicit numeric `width`/`height` fields carried
 * alongside the payload are used when the header could not be read.
 */
function buildPreviewImage(
  index: number,
  fields: { data?: string; url?: string; mimeType?: string; alt?: string },
  record: Record<string, unknown> | undefined,
): ToolPreviewImage | undefined {
  const image: ToolPreviewImage = { index };
  let data = fields.data;
  let mimeType = fields.mimeType;
  if (data) {
    const uri = parseDataUri(data);
    if (uri) {
      data = uri.data;
      mimeType = mimeType ?? uri.mimeType;
    }
  }
  if (fields.url) {
    const uri = parseDataUri(fields.url);
    if (uri) {
      data = uri.data;
      mimeType = mimeType ?? uri.mimeType;
    } else {
      image.url = fitTuiUrl(fields.url, 200);
    }
  }
  if (mimeType) {
    const clean = sanitizeTuiText(mimeType).toLowerCase();
    if (clean.startsWith("image/")) {
      image.mimeType = clean;
      const short = IMAGE_MIME_FORMAT[clean];
      if (short) image.format = short;
    }
  }
  if (data) {
    const bytes = base64ByteLength(data);
    if (bytes !== undefined) {
      image.data = data;
      image.byteSize = bytes;
      const size = imagePixelSize(decodeBase64Prefix(data, IMAGE_HEADER_B64_CHARS));
      if (size) {
        image.pixelWidth = size.width;
        image.pixelHeight = size.height;
        image.format = size.format;
      }
    }
  }
  if (image.pixelWidth === undefined || image.pixelHeight === undefined) {
    // No readable header. Fall back ONLY to dimensions the result stated itself.
    const width = positiveInt(record?.["width"] ?? record?.["pixelWidth"] ?? record?.["pixel_width"]);
    const height = positiveInt(record?.["height"] ?? record?.["pixelHeight"] ?? record?.["pixel_height"]);
    if (width !== undefined && height !== undefined) {
      image.pixelWidth = width;
      image.pixelHeight = height;
    } else {
      delete image.pixelWidth;
      delete image.pixelHeight;
    }
  }
  const alt = fields.alt ?? str(record?.["alt"] ?? record?.["caption"] ?? record?.["title"]);
  if (alt) {
    const clean = fitTuiText(alt, MAX_DETAIL_CHARS);
    if (clean) image.alt = clean;
  }
  // An image record with neither bytes nor a URL says nothing; drop it.
  if (!image.data && !image.url) return undefined;
  return image;
}

/**
 * Recognise the inline-image block shapes that actually occur in tool results:
 * the MCP content block (`{type:"image", data, mimeType}`), the Anthropic
 * content block (`{type:"image", source:{media_type, data}}`), the OpenAI
 * `image_url` block, and a bare `data:image/...;base64,` string. Anything else
 * is left alone — a guessed image is worse than no image.
 */
function imageFromRecord(
  record: Record<string, unknown>,
  index: number,
): ToolPreviewImage | undefined {
  const type = str(record["type"])?.toLowerCase();
  const declaredMime = str(record["mimeType"] ?? record["mime_type"] ?? record["media_type"] ?? record["mediaType"]);
  const alt = str(record["alt"] ?? record["caption"]);

  if (type === "image" || type === "input_image" || type === "output_image") {
    const source = record["source"];
    if (isPlainObject(source)) {
      const nestedMime = str(source["media_type"] ?? source["mediaType"] ?? source["mimeType"] ?? source["mime_type"]);
      const nestedData = str(source["data"] ?? source["base64"] ?? source["b64_json"]);
      const nestedUrl = str(source["url"]);
      return buildPreviewImage(index, {
        ...(nestedData ? { data: nestedData } : {}),
        ...(nestedUrl ? { url: nestedUrl } : {}),
        ...(nestedMime ?? declaredMime ? { mimeType: (nestedMime ?? declaredMime)! } : {}),
        ...(alt ? { alt } : {}),
      }, record);
    }
    const data = str(record["data"] ?? record["base64"] ?? record["b64_json"] ?? record["image"]);
    const url = str(record["url"] ?? record["image_url"]);
    if (data || url) {
      return buildPreviewImage(index, {
        ...(data ? { data } : {}),
        ...(url ? { url } : {}),
        ...(declaredMime ? { mimeType: declaredMime } : {}),
        ...(alt ? { alt } : {}),
      }, record);
    }
    return undefined;
  }

  if (type === "image_url") {
    const holder = record["image_url"];
    const url = isPlainObject(holder) ? str(holder["url"]) : str(holder);
    const holderAlt = isPlainObject(holder) ? str(holder["alt"] ?? holder["detail"]) : undefined;
    if (!url) return undefined;
    return buildPreviewImage(index, {
      url,
      ...(declaredMime ? { mimeType: declaredMime } : {}),
      ...(alt ?? holderAlt ? { alt: (alt ?? holderAlt)! } : {}),
    }, record);
  }

  // An untyped block that nonetheless declares an image media type and carries
  // a payload — the shape several scanners emit for a captured screenshot.
  if (declaredMime && declaredMime.toLowerCase().startsWith("image/")) {
    const data = str(record["data"] ?? record["base64"] ?? record["b64_json"] ?? record["content"]);
    const url = str(record["url"] ?? record["path"]);
    if (data || url) {
      return buildPreviewImage(index, {
        ...(data ? { data } : {}),
        ...(url && !data ? { url } : {}),
        mimeType: declaredMime,
        ...(alt ? { alt } : {}),
      }, record);
    }
  }
  return undefined;
}

/**
 * Walk a tool result for inline images. Bounded in depth, node count and
 * result count, cycle-safe, and total over any input — the same discipline as
 * {@link projectToolPreview}'s own traversal, for the same reason: this runs on
 * whatever a provider handed back.
 */
export function extractPreviewImages(output: unknown): ToolPreviewImage[] {
  const found: ToolPreviewImage[] = [];
  if (output === undefined || output === null) return found;
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (value: unknown, depth: number): void => {
    if (found.length >= MAX_PREVIEW_IMAGES) return;
    if (++nodes > IMAGE_SCAN_NODES || depth > IMAGE_SCAN_DEPTH) return;
    if (typeof value === "string") {
      const uri = parseDataUri(value);
      if (uri && uri.mimeType?.startsWith("image/")) {
        const image = buildPreviewImage(found.length + 1, { data: uri.data, mimeType: uri.mimeType }, undefined);
        if (image) found.push(image);
      }
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (found.length >= MAX_PREVIEW_IMAGES) return;
        visit(item, depth + 1);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    // A tool result can carry throwing accessors; recognising a block must
    // never be able to execute one into an exception that kills the render.
    let direct: ToolPreviewImage | undefined;
    try {
      direct = imageFromRecord(record, found.length + 1);
    } catch {
      direct = undefined;
    }
    if (direct) { found.push(direct); return; }
    try {
      for (const key in record) {
        if (!Object.hasOwn(record, key)) continue;
        if (found.length >= MAX_PREVIEW_IMAGES) return;
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !("value" in descriptor)) continue;
        visit(descriptor.value, depth + 1);
      }
    } catch {
      /* unreadable container — nothing to report */
    }
  };

  visit(output, 0);
  return found;
}
