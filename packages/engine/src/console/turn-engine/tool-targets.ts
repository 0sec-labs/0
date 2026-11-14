import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { NETWORK_CAPABLE_TOOLS } from "../../plugins/capability-classification.js";
import type { ToolCall } from "../../agent/types.js";
import { normalizeScopeHostname, ScopePolicy } from "../../scope/scope.js";
import { shellTokens } from "../../agent/shell-tokens.js";

/**
 * Passive network-recon tools permitted in `"recon"` mode ON TOP OF every
 * {@link READ_ONLY_TOOLS} entry. This is a deliberately CONSERVATIVE allow-list
 * ("prefer passive; when unsure, deny"): a network tool earns a place here only
 * when its entire job is passive information gathering about the engagement
 * surface — spidering/crawling, fingerprinting, surface/API discovery, and
 * client-side JS reconnaissance. None of these mutate target state or exercise
 * an exploit.
 *
 * Deliberately EXCLUDED (and therefore refused in recon): everything that can
 * mutate, submit input, or exploit — `http_request` (carries any method/body),
 * `submit_form`, `browser` (drives clicks/forms), `send_prompt`,
 * `access_control_probe`, all `structural_sqli_probe`/`prompt_layer_probe`/
 * `auth_boundary_probe`/`cloud_*` probes, every `run_*` scanner
 * (sqlmap/nmap/ffuf/nuclei — active/intrusive), `oast_*`, `start_scan`, the
 * shell/interpreter tools (`bash`/`run_command`/`pty_session`/`python_exec`),
 * `apply_patch`, and agent-spawning (`spawn_agent`/`spawn_agents`). Recon is the
 * most capability-restricted mode by design.
 */
export const RECON_PASSIVE_NETWORK_TOOLS: Record<string, true> = {
  crawl: true,
  wp_fingerprint: true,
  discover_api_surface: true,
  surface_sweep: true,
  js_recon: true,
};


/**
 * Canonicalize an operator-facing or tool-requested path to an ABSOLUTE,
 * symlink-resolved real path. The deepest existing ancestor is passed through
 * `realpathSync` (resolving every symlink in the prefix — so a symlink can't be
 * used to make the operator approve one directory while the tool touches
 * another), then any not-yet-existing trailing segments are appended. Relative
 * inputs resolve against the process cwd ONLY to compute a concrete path to
 * SHOW the operator; nothing is authorized without explicit approval, so this
 * is not an implicit grant of the cwd. Throws when no ancestor exists.
 */
export function canonicalizeRealPath(input: string): string {
  const abs = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
  const missing: string[] = [];
  let existing = abs;
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        throw new Error(`Path has no existing ancestor: ${input}`);
      }
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  return missing.length > 0 ? resolve(existing, ...missing) : existing;
}

/**
 * Whether `child` lies within the `parent` directory subtree (or IS it). Both
 * must already be canonicalized absolute real paths. The `parent + sep` guard
 * defeats the sibling-prefix trap: `/a/bc` is NOT within `/a/b`.
 */
export function isWithinDir(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Whether `dir` (a canonicalized real path) is a root too dangerous to ever
 * offer as a scan scope: the filesystem root itself (or any drive/mount root,
 * detected as a path that is its own parent) and the user's home directory
 * itself. Subdirectories of home (e.g. `~/code/proj`) are fine — only the bare
 * home root is refused, so a stray `.` / `~` approval can't hand the tools the
 * operator's entire home tree.
 */
export function isDangerousLocalRoot(dir: string): boolean {
  if (dirname(dir) === dir) return true;
  try {
    if (dir === realpathSync(homedir())) return true;
  } catch {
    // homedir unresolvable — fall through; the root check above still applies.
  }
  return false;
}

/**
 * The concrete path a filesystem-scoped tool wants to touch, pulled from its
 * arguments. read_file/list_files/search_files use `path`; run_command uses
 * `cwd`; apply_patch carries its targets inside the patch envelope and
 * analyze_binary uses `binary_path`. When nothing path-like is present we fall
 * back to "." so the operator is still asked about a concrete directory.
 */
export function extractLocalPath(call: ToolCall): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  for (const key of ["path", "cwd", "binary_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return ".";
}

/**
 * Parse a URL's hostname as a normalized lowercase string for scope-decision
 * memory. Returns null when the URL cannot be parsed — callers MUST fail safe
 * on null (never record it in, nor match it against, the denied set) so an
 * unparseable URL can neither poison the denied set nor be mistaken for a
 * previously-declined host.
 */
export function hostOf(url: string): string | null {
  try {
    return normalizeScopeHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * The host of the engagement anchor (the current session target), lowercased, or
 * null when no usable target is set. Accepts both a full URL and a bare
 * `host[:port]`, so a target configured either way yields the same anchor host.
 */
export function anchorHostFromTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  return hostOf(trimmed) ?? hostOf(`https://${trimmed}`);
}

/**
 * A target-only operator message is an explicit selection, not a URL extracted
 * from prose. Never call this on history, peer messages, or model/tool output.
 */
export function operatorTargetFromMessage(text: string): string | undefined {
  const value = text.trim();
  if (!value || /[\s\x00-\x1f\x7f"'`<>\\]/u.test(value)) return undefined;
  const absolute = /^https?:\/\//i.test(value);
  if (!absolute && !/^[^:/?#]+(?::\d+)?(?:[/?#].*)?$/.test(value)) return undefined;
  try {
    const url = new URL(absolute ? value : `https://${value}`);
    if (url.username || url.password) return undefined;
    if (!absolute && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Whether `host` belongs to the current engagement — the conservative predicate
 * that decides what copilot may AUTO-EXPAND to, and what stays inside the yolo
 * TARGET ANCHOR. A host belongs when it is:
 *   - already authorized by the established scope, OR
 *   - the anchor host itself, OR
 *   - a sub-domain of the anchor host (matched on the dot boundary, so
 *     `notexample.com` is NOT a sub-domain of `example.com`, and
 *     `example.com.evil.com` is not one either).
 * Deliberately narrow: an unrelated host requires an operator scope decision,
 * never silent auto-authorization.
 */
export function hostBelongsToEngagement(
  host: string | null,
  anchorHost: string | null,
  scope: ScopePolicy | undefined,
): boolean {
  if (!host) return false;
  if (scope?.match(`https://${host}`).allowed) return true;
  if (!anchorHost) return false;
  if (host === anchorHost) return true;
  return anchorHost.includes(".") && host.endsWith(`.${anchorHost}`);
}

/**
 * The nearest existing directory at or above `p` (an absolute real path). Used
 * to ground an AUTO-GRANTED local scope on a directory that actually exists,
 * even when the tool asked for a not-yet-created file. Walks up to a mount/drive
 * root at worst.
 */
function nearestExistingDir(p: string): string {
  let current = p;
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // does not exist / not stat-able — climb.
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * The directory subtree to auto-grant so a filesystem-scoped tool call can touch
 * `requestedPath` (an absolute real path): the path itself when it is a
 * directory, otherwise its containing directory — grounded on the nearest
 * directory that exists so the grant is always a real subtree covering the
 * request.
 */
export function directoryToGrantFor(requestedPath: string): string {
  try {
    if (statSync(requestedPath).isDirectory()) return requestedPath;
  } catch {
    // Missing (e.g. a file to be created) — grant its parent instead.
  }
  return nearestExistingDir(dirname(requestedPath));
}

/**
 * Whether `requestedPath` belongs to the engagement whose established local
 * scope is `scopePath`: it lies within the PARENT of the established scope
 * (a sibling/descendant subtree of the same project root), provided that parent
 * is not a dangerous root. Returns false when no local scope is established yet
 * (the first local root is an operator decision, never auto-expanded) or when
 * broadening to the parent would reach the filesystem/home root.
 */
export function pathBelongsToEngagement(requestedPath: string, scopePath: string | undefined): boolean {
  if (!scopePath) return false;
  const parent = dirname(scopePath);
  if (isDangerousLocalRoot(parent)) return false;
  return isWithinDir(requestedPath, parent);
}

// ── Target extraction from tool arguments ──
//
// HONEST LIMIT — READ THIS BEFORE TRUSTING ANYTHING BELOW.
//
// A regex (or a hand-rolled tokenizer) over a shell command CANNOT be a
// security boundary, and this code does not pretend to be one. A shell command
// is a program in a Turing-complete language whose destination is decided at
// RUNTIME, not at parse time. Every one of these defeats the extractor below,
// trivially and by design of the shell, not by a bug here:
//
//   H=evil.example; curl "$H"          — variable indirection
//   curl $(cat /tmp/h)                 — command substitution
//   echo Y3VybCBldmls | base64 -d | sh — encoded payload piped to a shell
//   python3 -c 'import socket; ...'    — any interpreter with a socket API
//   curl -K /tmp/cfg                   — destination read from a config file
//   ./fetch.sh                         — a script whose contents we never see
//   printf '\\x63url evil.example' | sh — escaped/obfuscated program name
//
// The extractor is defence in depth, not an egress sandbox. Standard/copilot
// escalate unresolved shell destinations. YOLO permits opaque local commands,
// but named unrelated hosts still require an operator scope decision.
//
// Real enforcement, if it is ever wanted, has to happen where the syscalls
// happen: a network namespace, a filtering proxy the tools are forced through,
// or a seccomp/LSM policy. None of that is in this file.

/**
 * Tools whose arguments are (or contain) a shell command line — the payload
 * class the schemeless extraction below understands, and the ONLY class the
 * unresolved-target escalation in `maybeResolveScope` applies to. Structured
 * tools (`http_request`, `crawl`, `read_file`, …) keep their previous
 * behaviour exactly: explicit `http(s)://` extraction plus the session-target
 * fallback.
 *
 * `python_exec` is deliberately NOT here: its payload is Python, not shell.
 * Shell target extraction cannot establish its network destinations.
 */
const SHELL_PAYLOAD_TOOLS: Record<string, true> = {
  bash: true,
  run_command: true,
  pty_session: true,
};

/**
 * Programs that speak to the network with a destination in argv. A bare
 * `host`, `host:port` or `host/path` argument to one of these is treated as an
 * engagement target even without a scheme. Restricting schemeless host
 * detection to these argument windows is the central FALSE-POSITIVE control:
 * scanning every shell token for "something with a dot in it" would classify
 * `package.json`, `app.ts` and `README.md` as hosts.
 */
const NETWORK_CLIENTS: Record<string, true> = {
  curl: true,
  wget: true,
  wget2: true,
  nc: true,
  ncat: true,
  netcat: true,
  socat: true,
  ssh: true,
  scp: true,
  sftp: true,
  rsync: true,
  ftp: true,
  telnet: true,
  dig: true,
  nslookup: true,
  host: true,
  ping: true,
  ping6: true,
  openssl: true,
};

/**
 * Clients whose remote operand is a `[user@]host:path` / `host::module` spec.
 * For these, a token is only read as a host when it carries `@` or `:` — the
 * syntax that actually makes it remote. Without this, `scp report.txt srv:/tmp`
 * would report `report.txt` as a target host.
 */
const REMOTE_SPEC_CLIENTS: Record<string, true> = { scp: true, sftp: true, rsync: true };

/** Clients that take a bare positional port after the host (`nc host 443`). */
const PORT_POSITIONAL_CLIENTS: Record<string, true> = {
  nc: true,
  ncat: true,
  netcat: true,
  telnet: true,
};

/** Command prefixes that wrap another command; the real program follows. */
const COMMAND_WRAPPERS: Record<string, true> = {
  sudo: true,
  doas: true,
  env: true,
  time: true,
  timeout: true,
  nohup: true,
  nice: true,
  ionice: true,
  stdbuf: true,
  command: true,
  builtin: true,
  exec: true,
  xargs: true,
  then: true,
  do: true,
  else: true,
};

/** Interpreters that execute whatever text is piped into them. */
const SHELL_INTERPRETERS: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ksh: true,
  python: true,
  python3: true,
  perl: true,
  ruby: true,
  node: true,
};

/**
 * Flags whose NEXT token is a value, not a destination. Skipping them stops
 * `curl -d @payload.json host` from reporting `payload.json` as a host. The set
 * is a union across clients on purpose: over-skipping can only LOSE a host,
 * which downgrades the call to "unresolved" and still gates it, whereas
 * under-skipping invents targets the operator then has to reject.
 */
const VALUE_FLAGS: Record<string, true> = {
  "-H": true, "--header": true,
  "-d": true, "--data": true, "--data-raw": true, "--data-binary": true, "--data-urlencode": true,
  "--post-data": true, "--post-file": true,
  "-o": true, "--output": true, "-O": true, "--output-document": true,
  "-u": true, "--user": true, "--proxy-user": true,
  "-X": true, "--request": true,
  "-A": true, "--user-agent": true, "-U": true,
  "-b": true, "--cookie": true, "-c": true, "--cookie-jar": true,
  "-e": true, "--referer": true,
  "-F": true, "--form": true,
  "-T": true, "--upload-file": true, "--timeout": true,
  "-x": true, "--proxy": true,
  "-m": true, "--max-time": true, "--connect-timeout": true, "--retry": true,
  "-w": true, "--write-out": true,
  "-K": true, "--config": true,
  "--cacert": true, "--cert": true, "--key": true,
  "-p": true, "-l": true, "-P": true,
};

/** Flags whose next token IS the destination. */
const TARGET_VALUE_FLAGS: Record<string, true> = {
  "--url": true,
  "-connect": true,
  "--connect": true,
  "--connect-to": true,
};

/** `>/dev/tcp/host/port` — bash's built-in socket, no external binary needed. */
const DEV_SOCKET_RE = /\/dev\/(?:tcp|udp)\/([^\s/'"`;|&()<>]+)\/(\d{1,5})/gi;

/** A bare IPv4 literal (optionally `:port` and `/path`), not part of a longer word. */
const BARE_IPV4_RE =
  /(?<![\w.-])((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?::(\d{1,5}))?((?:\/[^\s'"`<>|;&)]*)?)(?![\w.-])/g;

/** A bracketed IPv6 literal (`[::1]`, `[2001:db8::1]:8443`). */
const BRACKET_IPV6_RE = /\[([0-9a-f:]{2,}(?:%[0-9a-z]+)?)\](?::(\d{1,5}))?/gi;

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%[0-9a-z]+)?$/i;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)+$/i;

/** A destination recovered from a shell token. */
interface ParsedHost {
  host: string;
  ipv6: boolean;
  port?: number;
  path?: string;
}

/** Bound a payload fragment before it is embedded in an operator-facing reason. */
function truncateForReason(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The program name of a command token (`/usr/bin/curl` → `curl`). */
function programName(token: string): string {
  const cleaned = token.replace(/^\.\//, "");
  const slash = cleaned.lastIndexOf("/");
  return (slash >= 0 ? cleaned.slice(slash + 1) : cleaned).toLowerCase();
}

/**
 * Interpret one shell token as a network destination, or return null when it is
 * not host-shaped. Accepts `host`, `host:port`, `host/path`, `user@host`,
 * `user@host:/path`, `[v6]:port` and bare IPv4/IPv6 literals. A single-label
 * name is rejected (it is far more likely a file or a subcommand) with the sole
 * exception of `localhost`.
 */
function parseHostToken(rawToken: string): ParsedHost | null {
  let token = rawToken.trim();
  if (!token || token.startsWith("-")) return null;
  // A token that still carries a scheme is handled by the URL regex; report it
  // as "resolved" to the caller without duplicating it.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return null;
  // Strip userinfo (`user:pass@host`).
  const at = token.lastIndexOf("@");
  if (at >= 0) token = token.slice(at + 1);
  if (!token) return null;

  // Bracketed IPv6 first — its colons are not a port separator.
  const bracket = token.match(/^\[([^\]]+)\](?::(\d{1,5}))?(\/.*)?$/);
  if (bracket) {
    const inner = bracket[1];
    if (!IPV6_RE.test(inner)) return null;
    return { host: inner.toLowerCase(), ipv6: true, port: clampPort(bracket[2]), path: bracket[3] };
  }

  // Bare IPv6 (two or more colons and nothing but hex/colon characters).
  const beforeSlashV6 = token.split("/")[0];
  if ((beforeSlashV6.match(/:/g) ?? []).length >= 2 && IPV6_RE.test(beforeSlashV6)) {
    return { host: beforeSlashV6.toLowerCase(), ipv6: true };
  }

  // Split off a path, then a `:port` or an rsync `::module` / scp `:path`.
  const slash = token.indexOf("/");
  let authority = slash >= 0 ? token.slice(0, slash) : token;
  const path = slash >= 0 ? token.slice(slash) : undefined;
  let port: number | undefined;
  const colon = authority.indexOf(":");
  if (colon >= 0) {
    const tail = authority.slice(colon + 1);
    authority = authority.slice(0, colon);
    if (/^\d{1,5}$/.test(tail)) port = clampPort(tail);
  }
  const host = authority.toLowerCase();
  if (!host) return null;
  if (IPV4_RE.test(host)) return { host, ipv6: false, port, path };
  if (host === "localhost") return { host, ipv6: false, port, path };
  if (!HOSTNAME_RE.test(host)) return null;
  // Require an alphabetic, >=2 char final label so `1.2.3` / `v1.0` are not hosts.
  const last = host.slice(host.lastIndexOf(".") + 1);
  if (!/^[a-z]{2,}$/.test(last)) return null;
  return { host, ipv6: false, port, path };
}

function clampPort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Normalize a recovered destination into a URL `ScopePolicy.match` can parse.
 * The scheme is cosmetic — the policy only ever reads the hostname — but it has
 * to be present and the host has to be bracketed when it is IPv6, or `new URL`
 * throws and the policy fails closed on a target we actually did resolve.
 */
function hostToUrl(parsed: ParsedHost): string {
  const authority = parsed.ipv6 ? `[${parsed.host}]` : parsed.host;
  const scheme = parsed.port === 80 || parsed.port === 8080 ? "http" : "https";
  const port = parsed.port !== undefined ? `:${parsed.port}` : "";
  const path = parsed.path ?? "";
  const url = `${scheme}://${authority}${port}${path}`;
  try {
    // Round-trip so an unparseable synthesis never reaches the policy.
    new URL(url);
    return url;
  } catch {
    return `${scheme}://${authority}`;
  }
}

/** Shell separators the tokenizer emits as standalone tokens. */
function isSeparator(token: string): boolean {
  return token === "|" || token === "||" || token === "&" || token === "&&" ||
    token === ";" || token === ";;" || token === "\n";
}


/** Accumulator threaded through the shell scan. */
interface ShellScanSink {
  urls: Set<string>;
  unresolved: Set<string>;
}

/**
 * Read one network client's argument window (up to the next separator) and add
 * every destination it names. When the window names none — `curl "$H"`,
 * `wget -i list.txt`, a destination hidden behind a substitution — the client is
 * recorded as UNRESOLVED so the caller escalates instead of approving.
 */
function scanClientWindow(program: string, window: string[], sink: ShellScanSink): void {
  if (program === "openssl" && !window.some((t) => t === "s_client" || t === "s_time")) {
    // `openssl rand`, `openssl x509`, … are not network clients.
    return;
  }
  const remoteSpecOnly = REMOTE_SPEC_CLIENTS[program] === true;
  let found = 0;
  for (let i = 0; i < window.length; i++) {
    const token = window[i];
    const eq = token.match(/^(--[a-z][a-z0-9-]*)=(.*)$/i);
    if (eq && TARGET_VALUE_FLAGS[eq[1].toLowerCase()]) {
      const parsed = parseHostToken(eq[2]);
      if (parsed) { sink.urls.add(hostToUrl(parsed)); found += 1; }
      else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(eq[2])) found += 1;
      continue;
    }
    if (TARGET_VALUE_FLAGS[token.toLowerCase()]) {
      const value = window[++i];
      if (value !== undefined) {
        const parsed = parseHostToken(value);
        if (parsed) { sink.urls.add(hostToUrl(parsed)); found += 1; }
        else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) found += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      if (VALUE_FLAGS[token]) i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) { found += 1; continue; }
    if (remoteSpecOnly && !token.includes("@") && !token.includes(":")) continue;
    const parsed = parseHostToken(token);
    if (!parsed) continue;
    // `nc host 443` / `telnet host 23`: a bare number right after the host is
    // the port, not another argument.
    if (
      parsed.port === undefined &&
      PORT_POSITIONAL_CLIENTS[program] &&
      i + 1 < window.length &&
      /^\d{1,5}$/.test(window[i + 1])
    ) {
      parsed.port = clampPort(window[i + 1]);
      i += 1;
    }
    sink.urls.add(hostToUrl(parsed));
    found += 1;
  }
  if (found === 0) {
    sink.unresolved.add(
      `"${program}" is invoked with no destination this gate can read (${truncateForReason([program, ...window].join(" "))})`,
    );
  }
}

/**
 * Scan a shell payload for engagement destinations and for constructs that hide
 * one. Recurses into quoted sub-commands (`bash -c '…'`) up to a small depth.
 *
 * This is best-effort pattern recognition, NOT parsing and NOT enforcement —
 * see the honesty note at the top of this section.
 */
function scanShellPayload(payload: string, sink: ShellScanSink, depth = 0): void {
  if (depth > 3 || !payload) return;

  // bash's built-in socket: `exec 3<>/dev/tcp/host/port`.
  for (const match of payload.matchAll(DEV_SOCKET_RE)) {
    const parsed = parseHostToken(`${match[1]}:${match[2]}`);
    if (parsed) sink.urls.add(hostToUrl(parsed));
    else sink.unresolved.add(`a /dev/tcp socket to an unreadable host (${truncateForReason(match[0])})`);
  }

  // Bare IP literals anywhere in the payload — high signal, and not confusable
  // with a filename the way a bare hostname is.
  for (const match of payload.matchAll(BARE_IPV4_RE)) {
    sink.urls.add(hostToUrl({ host: match[1], ipv6: false, port: clampPort(match[2]), path: match[3] || undefined }));
  }
  for (const match of payload.matchAll(BRACKET_IPV6_RE)) {
    if (!IPV6_RE.test(match[1])) continue;
    sink.urls.add(hostToUrl({ host: match[1].toLowerCase(), ipv6: true, port: clampPort(match[2]) }));
  }

  const tokens = shellTokens(payload);
  let commandPosition = true;
  let afterPipe = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (isSeparator(token)) {
      afterPipe = token === "|" || token === "||";
      commandPosition = true;
      continue;
    }
    if (commandPosition) {
      if (token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (/\s/.test(token)) {
        // A whole quoted command sat in command position (`sh -c` with the
        // body quoted as one word, `xargs "curl host"`, …).
        commandPosition = false;
        afterPipe = false;
        scanShellPayload(token, sink, depth + 1);
        continue;
      }
      const program = programName(token);
      if (COMMAND_WRAPPERS[program]) continue;
      commandPosition = false;
      const window: string[] = [];
      for (let j = i + 1; j < tokens.length && !isSeparator(tokens[j]); j++) window.push(tokens[j]);

      if (afterPipe && SHELL_INTERPRETERS[program]) {
        sink.unresolved.add(`output is piped into "${program}", which executes text this gate never sees`);
      }
      if (program === "eval") {
        sink.unresolved.add(`"eval" executes a string this gate cannot resolve (${truncateForReason(window.join(" "))})`);
      }
      if (program === "base64" && window.some((t) => t === "-d" || t === "-D" || t === "--decode")) {
        sink.unresolved.add(`"base64 --decode" hides the payload from this gate`);
      }
      if (NETWORK_CLIENTS[program]) scanClientWindow(program, window, sink);
      afterPipe = false;
      continue;
    }
    // A quoted sub-command (`sh -c 'curl evil.example'`) survives tokenization
    // as one token containing whitespace; scan it as a payload in its own right.
    if (/\s/.test(token)) scanShellPayload(token, sink, depth + 1);
  }
}

/** What the scope gate learned about a pending tool call. */
interface ToolTargets {
  /** Destinations normalized to URLs, ready for `ScopePolicy.match`. */
  urls: string[];
  /**
   * Human-readable descriptions of shell constructs that reach the network (or
   * execute opaque text) WITHOUT naming a destination this gate could read.
   * Non-empty means "we do not know where this goes" — which is precisely the
   * case that must not be silently approved.
   */
  unresolved: string[];
  /** The raw shell payloads seen, used as the key for declined-payload memory. */
  shellPayloads: string[];
}

/**
 * Extract candidate targets from nested tool arguments.
 *
 * Structured (non-shell) tools behave exactly as before: explicit `http(s)://`
 * URLs, plus the session target as a fallback when nothing was found — correct
 * for `crawl`/`surface_sweep`/… which really do operate on the session target.
 *
 * Shell-payload tools additionally get schemeless extraction, and deliberately
 * DROP the session-target fallback: substituting the session target for a shell
 * command validated a host the command was never going to contact, which made
 * the gate look like it had done its job when it had not.
 */
export function extractToolTargets(
  call: ToolCall,
  target: string,
  networkCapable: boolean = NETWORK_CAPABLE_TOOLS[call.name] === true,
): ToolTargets {
  const urls = new Set<string>();
  const unresolved = new Set<string>();
  const shellPayloads: string[] = [];
  const shellShaped = SHELL_PAYLOAD_TOOLS[call.name] === true;

  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) urls.add(value);
      for (const embedded of value.match(/https?:\/\/[^\s'"`<>|]+/gi) ?? []) urls.add(embedded);
      if (shellShaped && value.trim()) {
        shellPayloads.push(value);
        scanShellPayload(value, { urls, unresolved });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(call.arguments);

  if (
    !shellShaped &&
    urls.size === 0 &&
    unresolved.size === 0 &&
    target.trim() &&
    networkCapable
  ) {
    urls.add(target);
  }
  return { urls: [...urls], unresolved: [...unresolved], shellPayloads };
}
