/**
 * Text analysis for the protected-paths decider. Pure apart from the injected `real` function (symlink resolution).
 *
 * Question answered: does this command text, run in `cwd`, name anything under the 0 state directory that holds
 * approvals, enablement, grants, audit, settings or the database? Covered as far as TEXT analysis allows:
 * absolute paths, `~`, `$HOME`, `${HOME}`, `cd`/`pushd` followed by relative paths, `..` segments, redirects, tee,
 * cp/mv/ln, `sed -i`, paths inside quoted python/node one-liners, glob segments (`ext*`), and symlinks that exist
 * when the check runs.
 *
 * NOT covered (documented limit, the sandbox is the boundary): paths assembled at run time (string concatenation,
 * base64, `printf` into a variable, `eval`), symlinks created and used inside the same command, and anything read
 * from a file the command itself writes. See docs/design/command-hook-architecture.md.
 */
import { isAbsolute, join, resolve, sep } from "node:path";

/** First segments under `<home>/.0` that must not be touched by an agent. `0.db*` is matched by prefix. */
export const PROTECTED_STATE_NAMES: readonly string[] = [
  "extensions", "plugins", "plugin-enablement", "executable-plugins", "harness-trust", "evolution-authority",
  "tui-settings.json", "workbench.json", "backends.json", "credentials.json", "access-upgrade.json", "cloud.env",
];
const isProtectedName = (name: string): boolean => PROTECTED_STATE_NAMES.includes(name) || name === "0.db" || name.startsWith("0.db.");

export interface ProtectedPathContext {
  readonly home: string;
  readonly cwd: string;
  /** Resolve symlinks of the deepest existing ancestor; identity in pure tests. */
  readonly real?: (path: string) => string;
}

export interface ProtectedHit { readonly path: string; readonly reason: string }

const OPERATORS = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);

/** Split a shell-ish command into words (quotes and escapes removed) and operator marks. No expansion. */
export function tokenize(command: string): Array<{ word: string } | { op: string }> {
  const out: Array<{ word: string } | { op: string }> = [];
  let cur = ""; let has = false; let i = 0;
  const flush = () => { if (has) out.push({ word: cur }); cur = ""; has = false; };
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") { const end = command.indexOf("'", i + 1); const stop = end < 0 ? command.length : end; cur += command.slice(i + 1, stop); has = true; i = stop + 1; continue; }
    if (c === '"') {
      i++; has = true;
      while (i < command.length && command[i] !== '"') { if (command[i] === "\\" && i + 1 < command.length) { cur += command[i + 1]; i += 2; } else cur += command[i++]; }
      i++; continue;
    }
    if (c === "\\" && i + 1 < command.length) { cur += command[i + 1]; has = true; i += 2; continue; }
    if (c === " " || c === "\t" || c === "\r") { flush(); i++; continue; }
    if (OPERATORS.has(c)) { flush(); out.push({ op: c }); i++; continue; }
    cur += c; has = true; i++;
  }
  flush();
  return out;
}

const expandHome = (text: string, home: string): string =>
  text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home).replace(/(^|[=:,'"(\s])~(?=\/|$)/g, (_m, pre: string) => `${pre}${home}`);

const GLOB = /[*?[]/;
const globRegex = (segment: string): RegExp => new RegExp(`^${segment.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);

function realOf(path: string, real: (p: string) => string): string {
  try { return real(path); } catch { return path; }
}

/** Is `path` (absolute, normalised, may contain glob segments) inside or equal to a protected location? */
function protectedReason(path: string, states: readonly string[]): string | null {
  const segs = path.split(sep).filter(Boolean);
  for (const state of states) {
    const base = state.split(sep).filter(Boolean);
    if (segs.length <= base.length) continue;
    let prefixMatches = true;
    for (let i = 0; i < base.length; i++) {
      const s = segs[i]!;
      if (s === base[i]) continue;
      if (GLOB.test(s) && globRegex(s).test(base[i]!)) continue;
      prefixMatches = false; break;
    }
    if (!prefixMatches) continue;
    const first = segs[base.length]!;
    if (GLOB.test(first)) {
      const re = globRegex(first);
      if ([...PROTECTED_STATE_NAMES, "0.db"].some(name => re.test(name))) return `${state}${sep}${first}`;
    } else if (isProtectedName(first)) return `${state}${sep}${first}`;
  }
  return null;
}

const DESTRUCTIVE = /^(rm|mv|chmod|chown|ln|cp|rsync|tar|find|truncate|shred|unlink|rmdir)$/;

/** Find the first protected location the command names, or null. */
export function findProtectedPathUse(command: string, extraPaths: readonly string[], ctx: ProtectedPathContext): ProtectedHit | null {
  const real = ctx.real ?? (p => p);
  const states = [...new Set([join(ctx.home, ".0"), realOf(join(ctx.home, ".0"), real)])];
  const check = (candidate: string, cwd: string): ProtectedHit | null => {
    if (!candidate) return null;
    const expanded = expandHome(candidate, ctx.home);
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    for (const variant of new Set([abs, realOf(abs, real)])) {
      const why = protectedReason(variant, states);
      if (why) return { path: abs, reason: `touches ${why}` };
    }
    return null;
  };
  let cwd = ctx.cwd;
  for (const p of extraPaths) { const hit = check(p, cwd); if (hit) return hit; }
  const tokens = tokenize(command);
  let atStart = true; let verb = ""; let verbs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if ("op" in t) { atStart = true; continue; }
    if (atStart) { verb = t.word.replace(/^.*\//, ""); verbs = [verb]; atStart = false; }
    else verbs.push(t.word);
    const word = expandHome(t.word, ctx.home);
    // The word itself, then every path-like piece inside it (python -c "open('~/.0/extensions/x')").
    const pieces = new Set<string>([word, ...word.split(/[\s'"`=:,;()[\]{}<>|&!]+/).filter(p => p.length > 0)]);
    for (const piece of pieces) {
      const hit = check(piece, cwd); if (hit) return hit;
      // `$(...)`/backtick pieces and ${VAR} remain unresolved text; nothing more can be said here.
    }
    if ((verb === "cd" || verb === "pushd") && verbs.length === 2) {
      const target = word; cwd = target === "-" ? cwd : isAbsolute(target) ? resolve(target) : resolve(cwd, target);
    }
    // `rm -rf ~/.0` style: the state directory itself, only for verbs that destroy or rewrite.
    if (DESTRUCTIVE.test(verb)) {
      const abs = isAbsolute(word) ? resolve(word) : resolve(cwd, word);
      if (states.includes(abs) || states.includes(realOf(abs, real))) return { path: abs, reason: `${verb} on the 0 state directory ${abs}` };
    }
  }
  return null;
}

/** Commands that grant an approval or change enablement. An agent must never run these; the operator does. */
const APPROVAL_SUBCOMMANDS = new Set(["add", "enable", "disable", "update", "import", "remove", "install", "uninstall"]);

export function findApprovalCommand(command: string): string | null {
  const segments: string[][] = []; let cur: string[] = [];
  for (const t of tokenize(command)) { if ("op" in t) { if (cur.length) segments.push(cur); cur = []; } else cur.push(t.word); }
  if (cur.length) segments.push(cur);
  for (const raw of segments) {
    let words = raw;
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ["env", "sudo", "command", "exec", "nohup", "time"].includes(words[0]!))) words = words.slice(1);
    const exe = (words[0] ?? "").replace(/^.*\//, "");
    if (!["0", "zero", "node"].includes(exe) && !/^0(\.js)?$/.test(exe)) continue;
    const rest = words.slice(1).filter(w => !w.startsWith("-"));
    const [group, sub, sub2] = rest;
    if (group === "skills" && (sub === "add" || (sub === "extensions" && sub2 && APPROVAL_SUBCOMMANDS.has(sub2)))) return `0 skills ${sub}${sub === "extensions" ? ` ${sub2}` : ""}`;
    if (group === "skills" && words.includes("--yes")) return "0 skills ... --yes";
    if (group === "plugin" && sub && APPROVAL_SUBCOMMANDS.has(sub)) return `0 plugin ${sub}`;
    if (group === "plugins" && sub && APPROVAL_SUBCOMMANDS.has(sub)) return `0 plugins ${sub}`;
  }
  return null;
}
