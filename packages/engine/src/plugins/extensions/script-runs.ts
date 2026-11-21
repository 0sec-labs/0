/**
 * Scripts of an extension run through the ordinary bash tool. This is the one place that decides what such a run adds to
 * its environment: only the variables the extension declared AND the operator approved, filled from the process
 * environment (for plain declared names) and from the connection's stored secret (for a connector's names). A script of an
 * extension that is not enabled and approved gets nothing, and an extension whose approval does not cover a name it
 * declares is refused outright. The secret values are returned so the caller can mask them in what comes back.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionRunPort } from "../../agent/types.js";
import { BASE_ENV } from "./core/env.js";
import type { ConnectionSecrets, ExtensionStore } from "./ports.js";
import { loadable, type LoadedExtension } from "./runtime.js";

const KNOWN_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "python",
  "python3",
  "node",
  "bun",
]);

const FORBIDDEN_INTERPRETER_FLAGS = ["-c", "-e", "--eval", "-p", "--print", "-m", "-s", "-i"];

/**
 * Tokenize a single-command shell invocation. Rejects shell compounding (`;`, `&&`, `||`, `|`, `&`, `\n`, `\r`),
 * command substitution (`$(...)`, backticks), redirection (`<`, `>`), subshell grouping (`(`, `)`), and shell comments (`#`).
 * Fails closed (`null`) if any ambiguous, compound, or non-single-command construct is encountered.
 */
function parseShellCommand(command: string): string[] | null {
  if (command.includes("\0")) return null;
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
        hasToken = true;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\") {
        const next = command[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i++;
        } else {
          current += ch;
        }
        hasToken = true;
      } else if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
        return null;
      } else {
        current += ch;
        hasToken = true;
      }
      continue;
    }

    if (ch === "\\") {
      const next = command[i + 1];
      if (next !== undefined) {
        current += next;
        i++;
        hasToken = true;
      }
    } else if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === " " || ch === "\t") {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else if (ch === "\n" || ch === "\r") {
      return null;
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "<" || ch === ">" || ch === "(" || ch === ")" || ch === "`") {
      return null;
    } else if (ch === "$" && command[i + 1] === "(") {
      return null;
    } else if (ch === "#") {
      return null;
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (inSingle || inDouble) return null;
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Extract the script file path candidate from tokenized arguments.
 * Handles standard interpreters (sh, bash, python3, node, etc.), env wrappers (/usr/bin/env),
 * interpreter flags, and direct executable invocations.
 */
function extractScriptCandidate(tokens: string[]): string | null {
  if (tokens.length === 0) return null;

  let idx = 0;
  const firstBase = path.basename(tokens[0]);
  if (tokens[0] === "env" || firstBase === "env") {
    idx++;
    if (idx >= tokens.length) return null;
  }

  const prog = tokens[idx];
  const progBase = path.basename(prog);

  if (KNOWN_INTERPRETERS.has(prog) || KNOWN_INTERPRETERS.has(progBase)) {
    idx++;
    while (idx < tokens.length && tokens[idx].startsWith("-")) {
      const flag = tokens[idx];
      for (const forbidden of FORBIDDEN_INTERPRETER_FLAGS) {
        if (flag === forbidden || flag.startsWith(forbidden + "=") || (forbidden.length === 2 && flag.startsWith(forbidden))) {
          return null;
        }
      }
      idx++;
    }
    if (idx >= tokens.length) return null;
    return tokens[idx];
  }

  return tokens[0];
}

/**
 * Validate that candidate script path resolves to a real script declared in the manifest
 * of an active extension and strictly contained within the extension revision directory.
 */
function findAuthorizedExtension(
  candidate: string,
  loadedExtensions: LoadedExtension[],
  cwd: string = process.cwd()
): { ext: LoadedExtension; relScript: string } | null {
  let canonicalScript: string;
  try {
    const resolved = path.resolve(cwd, candidate);
    canonicalScript = fs.realpathSync(resolved);
  } catch {
    return null;
  }

  for (const ext of loadedExtensions) {
    let canonicalExtDir: string;
    try {
      canonicalExtDir = fs.realpathSync(ext.dir);
    } catch {
      continue;
    }

    const prefix = canonicalExtDir.endsWith(path.sep) ? canonicalExtDir : canonicalExtDir + path.sep;
    if (!canonicalScript.startsWith(prefix)) {
      continue;
    }

    const relScript = path.relative(canonicalExtDir, canonicalScript).split(path.sep).join("/");
    if (ext.manifest.scripts.includes(relScript)) {
      return { ext, relScript };
    }
  }

  return null;
}

export function createScriptRuns(options: {
  store: ExtensionStore;
  secrets: ConnectionSecrets;
  projectKey: string | null;
  parentEnv?: () => Readonly<Record<string, string | undefined>>;
  cwd?: string | (() => string | undefined);
}): ExtensionRunPort {
  return {
    prepare(command, context) {
      const state = options.store.read();
      if (!state.ok) return null;

      const tokens = parseShellCommand(command);
      if (!tokens || tokens.length === 0) return null;

      const candidate = extractScriptCandidate(tokens);
      if (!candidate) return null;

      const { extensions } = loadable(options.store, options.projectKey, options.secrets);
      if (!extensions.length) return null;

      const effectiveCwd = context?.cwd ?? (typeof options.cwd === "function" ? options.cwd() : options.cwd) ?? process.cwd();
      const match = findAuthorizedExtension(candidate, extensions, effectiveCwd);
      if (!match) return null;

      const { ext } = match;
      if (ext.unapprovedEnv.length) {
        return {
          ok: false,
          error: `extension ${ext.name} declares ${ext.unapprovedEnv.join(", ")} but the approval does not cover it: approve it again with \`0 skills extensions enable ${ext.name} --yes\``,
        };
      }

      const env: Record<string, string> = {};
      const secrets: string[] = [];
      for (const [name, value] of Object.entries(ext.env((options.parentEnv ?? (() => process.env))()))) {
        if (BASE_ENV.includes(name)) continue;
        env[name] = value;
        if (!name.startsWith("ZERO_EXTENSION_")) secrets.push(value);
      }

      return { ok: true, env, secrets };
    },
  };
}
