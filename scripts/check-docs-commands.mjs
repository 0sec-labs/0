#!/usr/bin/env node
// Verifies that every `0 ...` command shown in the docs and README matches the
// real command tree: path, flags, enumerated choices and required options.
// Also checks internal links/anchors, ZERO_* environment variables and config
// file names mentioned in docs. Needs `pnpm --filter '@0/cli...' build` first.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(root, "docs/src/content/docs");
const IMPLICIT_FLAGS = new Set(["-h", "--help", "-V", "--version"]);
const SHELL_FENCES = new Set(["", "bash", "sh", "shell", "zsh", "text", "console", "terminal"]);

export function listDocFiles(rootDir = root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.mdx?$/.test(name)) out.push(path);
    }
  };
  walk(join(rootDir, "docs/src/content/docs"));
  if (existsSync(join(rootDir, "README.md"))) out.push(join(rootDir, "README.md"));
  return out;
}

/** Split a shell-ish line into tokens, honouring quotes; stops at pipes, redirects and comments. */
export function tokenize(line) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) tokens.push(cur); cur = ""; has = false; continue; }
    if (ch === "#" && !cur && !has) break;
    if (ch === "|" || ch === ";" || ch === "&" || ch === ">" || ch === "<" && line[i + 1] !== undefined && /\s/.test(line[i + 1])) break;
    cur += ch; has = true;
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}

/** Extract { line, text } command invocations that begin with `0 `. */
export function extractCommands(markdown) {
  const found = [];
  const lines = markdown.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const open = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(raw);
    if (open) {
      if (!fence) fence = { marker: open[1][0], lang: open[2].toLowerCase() };
      else if (open[1][0] === fence.marker && !open[2]) fence = null;
      continue;
    }
    if (fence) {
      if (!SHELL_FENCES.has(fence.lang)) continue;
      const m = /^\s*(?:\$\s+)?(0\s.*)$/.exec(raw);
      if (!m || /\S {3,}\S/.test(m[1])) continue; // aligned help output, not an invocation
      let text = m[1];
      const start = i + 1;
      while (/\\\s*$/.test(text) && i + 1 < lines.length) text = text.replace(/\\\s*$/, " ") + lines[++i].trim();
      found.push({ line: start, text });
      continue;
    }
    for (const span of raw.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
      const body = span[1].trim().replace(/^\$\s+/, "");
      if (/^0\s+\S/.test(body) && !body.includes("\\|")) found.push({ line: i + 1, text: body });
    }
  }
  return found;
}

const isPlaceholder = (value) => /[<>]|\.\.\.|\$|\{|\}|\[|\]/.test(value) || /^[A-Z][A-Z0-9_]+$/.test(value);

function takesValue(option) { return option.required || option.optional; }

function findOption(chain, flag) {
  for (const command of [...chain].reverse()) {
    const hit = command.options.find((o) => o.long === flag || o.short === flag);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Validate one invocation against the tree.
 * @returns {string[]} problems (empty when the example is accurate)
 */
export function checkInvocation(program, text, moved = () => undefined) {
  const tokens = tokenize(text);
  if (tokens[0] !== "0") return [];
  const problems = [];
  const args = tokens.slice(1);
  if (!args.length || args[0].startsWith("-")) return problems;
  const rewrite = moved(args);
  if (rewrite) return [`deprecated command \`0 ${args[0]}\`; use \`${rewrite}\``];
  let command = program;
  const chain = [program];
  const used = [];
  const positionals = [];
  const placeholderLine = args.some(isPlaceholder);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") break;
    if (token.startsWith("--") || (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token))) {
      const isLong = token.startsWith("--");
      const eq = token.indexOf("=");
      const names = isLong
        ? [eq < 0 ? token : token.slice(0, eq)]
        : token.slice(1).split("").map((c) => `-${c}`);
      let inlineValue = isLong && eq >= 0 ? token.slice(eq + 1) : undefined;
      for (let n = 0; n < names.length; n++) {
        const flag = names[n];
        if (IMPLICIT_FLAGS.has(flag)) continue;
        const negated = isLong && flag.startsWith("--no-");
        const option = findOption(chain, flag) ?? (negated ? findOption(chain, `--${flag.slice(5)}`) : undefined);
        if (!option) {
          const known = chain.flatMap((c) => c.options.map((o) => o.long ?? o.short)).filter(Boolean);
          const near = known.find((k) => k.startsWith(flag.slice(0, 4))) ?? known[0];
          problems.push(`unknown option ${flag} for \`${path(chain)}\`${near ? ` (did you mean ${near}?)` : ""}`);
          continue;
        }
        used.push(option);
        if (takesValue(option) && !negated) {
          let value = inlineValue;
          if (value === undefined && n === names.length - 1 && option.required && i + 1 < args.length) value = args[++i];
          if (value === undefined && !isLong && n < names.length - 1) value = names.slice(n + 1).join("").replaceAll("-", "");
          if (value !== undefined && option.argChoices && !isPlaceholder(value) && !option.argChoices.includes(value)) {
            problems.push(`invalid value "${value}" for ${option.long ?? option.short}; choices: ${option.argChoices.join(", ")}`);
          }
          if (value !== undefined && !isLong && n < names.length - 1) break;
        }
      }
      continue;
    }
    if (!positionals.length) {
      const sub = command.commands.find((c) => c.name() === token || c.aliases().includes(token));
      if (sub) { command = sub; chain.push(sub); continue; }
      // `0 scan <target> ...` is smart-routed to the right module (see rewriteScanArgs), so the target and
      // the flags after it belong to a module chosen at run time: accept and stop validating this example.
      if (command.name() === "scan" && command.parent === program && !isPlaceholder(token) && !token.startsWith("-")) break;
      if (command.commands.length && command !== program && !isPlaceholder(token)
          && command.registeredArguments.length === 0 && !command._defaultCommandName) {
        problems.push(`unknown subcommand "${token}" under \`${path(chain)}\``);
        continue;
      }
      if (command === program && !isPlaceholder(token)) {
        problems.push(`unknown command \`0 ${token}\``);
        break;
      }
    }
    positionals.push(token);
  }
  // A bare mention such as `0 research hunt` names a command; only complete-looking examples need required options.
  const completeLooking = used.length > 0 || positionals.length > 0;
  if (!command.commands.length && !placeholderLine && completeLooking && !args.every((a) => IMPLICIT_FLAGS.has(a) || chain.some((c) => c.name() === a))) {
    const missing = chain.flatMap((c) => c.options)
      .filter((o) => o.mandatory && !used.includes(o) && !hasEnvDefault(o)).map((o) => o.long ?? o.short);
    if (missing.length) problems.push(`missing required option${missing.length > 1 ? "s" : ""} ${missing.join(", ")} for \`${path(chain)}\``);
  }
  for (const [i, arg] of command.registeredArguments.entries()) {
    const value = positionals[i];
    if (value && arg.argChoices && !isPlaceholder(value) && !arg.argChoices.includes(value)) {
      problems.push(`invalid value "${value}" for <${arg.name()}>; choices: ${arg.argChoices.join(", ")}`);
    }
  }
  return problems;
}

const hasEnvDefault = (option) => option.envVar && process.env[option.envVar];
const path = (chain) => chain.map((c) => c.name()).join(" ");

async function loadProgram() {
  const requireCli = createRequire(resolve(root, "packages/cli/package.json"));
  const { Command } = requireCli("commander");
  const registrations = await import(pathToFileURL(resolve(root, "packages/cli/dist/commands/index.js")));
  const program = new Command().name("0");
  registrations.registerCommandTree(program);
  let moved = () => undefined;
  try {
    const aliases = await import(pathToFileURL(resolve(root, "packages/cli/dist/command-aliases.js")));
    moved = (args) => {
      const r = aliases.rewriteMovedCommand(args);
      return r ? `0 ${r.args.slice(0, r.args.length - (args.length - 1)).join(" ")}` : undefined;
    };
  } catch { /* aliases optional */ }
  return { program, moved };
}

// ---- links, anchors, env vars, config names -------------------------------

const slugify = (heading) => heading.toLowerCase().trim()
  .replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

export function headingSlugs(markdown) {
  const slugs = new Set();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) slugs.add(slugify(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")));
    for (const id of line.matchAll(/\bid=["']([^"']+)["']/g)) slugs.add(id[1]);
  }
  return slugs;
}

function resolveDocTarget(file, target, rootDir) {
  const docs = join(rootDir, "docs/src/content/docs");
  const clean = target.length > 1 ? target.replace(/\/+$/, "") : target;
  // Site-style relative links (no .md/.mdx extension) resolve against the page URL, which is the file path without its extension.
  const stem = /^index\.mdx?$/.test(basename(file)) ? dirname(file) : join(dirname(file), basename(file).replace(/\.mdx?$/, ""));
  const urlStyle = !/\.mdx?$/.test(clean);
  const base = clean.startsWith("/") ? join(docs, clean) : resolve(urlStyle && file.startsWith(docs) ? stem : dirname(file), clean);
  const candidates = [base, `${base}.md`, `${base}.mdx`, join(base, "index.md"), join(base, "index.mdx")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

export function checkLinks(file, markdown, rootDir = root) {
  const problems = [];
  const lines = markdown.split("\n");
  let fence = false;
  const ownSlugs = headingSlugs(markdown);
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = m[1];
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
      const [rawPath, anchor] = href.split("#");
      const at = `${relative(rootDir, file)}:${i + 1}`;
      if (!rawPath) {
        if (anchor && !ownSlugs.has(anchor)) problems.push(`${at}: stale anchor #${anchor}`);
        continue;
      }
      const clean = decodeURIComponent(rawPath.split("?")[0]);
      let target;
      if (file.endsWith("README.md") && dirname(file) === rootDir) {
        const p = resolve(rootDir, clean);
        target = existsSync(p) && statSync(p).isFile() ? p : resolveDocTarget(file, clean, rootDir);
        if (!target && existsSync(p)) continue; // directory link
      } else {
        target = resolveDocTarget(file, clean, rootDir);
        const asFile = resolve(dirname(file), clean);
        if (!target && existsSync(asFile)) continue; // non-doc asset in repo
        if (!target && clean.startsWith("/") && existsSync(join(rootDir, "docs/public", clean))) continue;
      }
      if (!target) { problems.push(`${at}: broken link ${href}`); continue; }
      if (anchor && /\.mdx?$/.test(target) && !headingSlugs(readFileSync(target, "utf8")).has(anchor)) {
        problems.push(`${at}: stale anchor ${href}`);
      }
    }
  });
  return problems;
}

function sourceHas(name, rootDir) {
  try {
    execFileSync("git", ["grep", "-q", "-F", "-e", name, "--", ":(glob)packages/*/src/**", ":(glob)scripts/**", ":(glob).github/**", "install.sh", ":(exclude,glob)**/*.test.*", ":(exclude,glob)**/__tests__/**"], { cwd: rootDir, stdio: "ignore" });
    return true;
  } catch { return false; }
}

/** Names that docs may mention although no shipped source reads them, each with the reason. */
export const UNREAD_ENV_ALLOWLIST = new Map([
  ["ZERO_ENGINE_TOKEN", "operator-chosen name passed to --engine-token-env"],
  ["ZERO_AGENT_TOKEN", "operator-chosen name passed to --engine-token-env"],
  ["ZERO_REMOTE_ENGINE_TOKEN", "operator-chosen name passed to --engine-token-env"],
  ["ZERO_TEAM_OIDC_SECRET", "operator-chosen name referenced by clientSecretEnv"],
  ["ZERO_FINDINGS_API_TOKEN", "operator shell variable in a curl example"],
  ["ZERO_TEST_BROWSER_ORACLES", "read only by the engine's opt-in test suite"],
  ["ZERO_FEATURE_EGATS", "docs state it is not a current toggle"],
  ["ZERO_FEATURE_TRIAGE_MEMORIES", "docs state it is not a current toggle"],
  ["ZERO_FEATURE_DEBATE", "docs state the debate layer is planned, not implemented"],
  ["ZERO_FEATURE_JOURNAL_LOOP", "historical proposal vocabulary, labelled as such"],
]);

export function checkEnvVars(files, rootDir = root, has = (n) => sourceHas(n, rootDir), allow = UNREAD_ENV_ALLOWLIST) {
  const problems = [];
  const cache = new Map();
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bZERO_[A-Z0-9_]*[A-Z0-9]\b/g)) {
        const name = m[0];
        if (allow.has(name)) continue;
        if (!cache.has(name)) cache.set(name, has(name));
        if (!cache.get(name)) problems.push(`${relative(rootDir, file)}:${i + 1}: ${name} is documented but no source reads it`);
      }
    });
  }
  return problems;
}

/** File names the docs deliberately mention as retired. */
const RETIRED_CONFIG_NAMES = new Set(["dogfood-review.yml"]);

function trackedBasename(name, rootDir) {
  try {
    const out = execFileSync("git", ["ls-files", "--", `:(glob)**/${name}`], { cwd: rootDir, encoding: "utf8" });
    return out.trim().length > 0;
  } catch { return false; }
}

/** Repo paths must exist, workflow/config file names must be tracked, ~/.0 files must be referenced by source. */
export function checkConfigNames(files, rootDir = root, has = (n) => sourceHas(n, rootDir), tracked = (n) => trackedBasename(n, rootDir)) {
  const problems = [];
  for (const file of files) {
    // research notes are dated snapshots of other repositories and past revisions
    if (relative(rootDir, file).split("\\").join("/").startsWith("docs/src/content/docs/research/")) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/`([~/A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)*\.(?:ya?ml|toml|jsonc?))`/g)) {
        const name = m[1];
        const at = `${relative(rootDir, file)}:${i + 1}`;
        if (RETIRED_CONFIG_NAMES.has(name) || name.includes("*") || name.includes("...") || name.startsWith("/tmp/") || name.startsWith("~/.codex/")) continue;
        if (/^(packages|scripts|\.github|docs)\//.test(name)) {
          if (!existsSync(join(rootDir, name))) problems.push(`${at}: ${name} does not exist in the repository`);
        } else if (name.startsWith("~/.0/")) {
          if (!has(basename(name))) problems.push(`${at}: ${name} is not referenced by any source`);
        } else if (/\.ya?ml$/.test(name) && !name.includes("/")) {
          if (!tracked(name)) problems.push(`${at}: ${name} is not a tracked file`);
        }
      }
    });
  }
  return problems;
}

export async function main() {
  const files = listDocFiles();
  const { program, moved } = await loadProgram();
  const problems = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file);
    for (const cmd of extractCommands(text)) {
      for (const p of checkInvocation(program, cmd.text, moved)) problems.push(`${rel}:${cmd.line}: ${p}\n    > ${cmd.text}`);
    }
    problems.push(...checkLinks(file, text));
  }
  problems.push(...checkEnvVars(files), ...checkConfigNames(files));
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} documentation drift problem(s).`);
    process.exitCode = 1;
  } else console.log(`Docs match the CLI: ${files.length} files checked.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    console.error("Build the CLI first: pnpm --filter '@0/cli...' build");
    process.exitCode = 1;
  });
}
