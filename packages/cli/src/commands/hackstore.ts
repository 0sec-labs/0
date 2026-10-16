// `0 hackstore` creates, validates, and prepares extension source for review.
// These authoring commands do not install, enable, publish, or execute plugin code.
// `0 plugin` handles installation, project approval, and direct tool calls.
// Manifest validation is shared with the loader; runnable code is checked
// separately by loading and calling the installed plugin.
//
// HackstoreCorePort lets command tests use the real validator without importing
// the full core barrel. Production resolves it lazily from @0/core.

import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import type { PluginManifest, ValidationResult } from "@0/core";

// ── Decided constants ─────────────────────────────────────────────────────────

/** The community registry repo authors fork + PR to submit an extension. */
export const HACKSTORE_REGISTRY_REPO = "github.com/0sec-labs/hackstore";
/** The published registry index the CLI reads. */
export const HACKSTORE_INDEX_URL =
  "https://raw.githubusercontent.com/0sec-labs/hackstore/main/index.json";
/** `$id` of the manifest JSON Schema; used as the scaffold's `$schema` value. */
export const HACKSTORE_SCHEMA_ID =
  "https://raw.githubusercontent.com/0sec-labs/hackstore/main/hackstore-manifest.schema.json";

const MANIFEST_FILE = "manifest.json";
const EXIT_OK = 0;
const EXIT_USER_ERROR = 1;
// Bound author-controlled files before reading; installed manifests have the same limit.
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

// ── Core port ─────────────────────────────────────────────────────────────────

/**
 * Everything this command needs from `@0/core`. Injected so tests supply the
 * real validator from core source; {@link defaultCorePort} lazily imports the
 * barrel in production.
 */
export interface HackstoreCorePort {
  validatePluginManifest(
    raw: unknown,
    opts?: { reservedToolNames?: readonly string[] },
  ): ValidationResult;
  reservedToolNames?: readonly string[];
  reservedPluginIds?: readonly string[];
}

let cachedCore: HackstoreCorePort | undefined;
async function defaultCorePort(): Promise<HackstoreCorePort> {
  if (cachedCore) return cachedCore;
  // Keep command registration/help independent of core's native DB/provider initialization.
  const mod = await import("@0/core");
  cachedCore = {
    validatePluginManifest: mod.validatePluginManifest,
    reservedToolNames: Object.values(mod.TOOL_DEFINITIONS).map((tool) => tool.name),
    reservedPluginIds: mod.BUILTIN_PLUGINS.map((plugin) => plugin.id),
  };
  return cachedCore;
}

// ── validate ──────────────────────────────────────────────────────────────────

export interface ValidateDeps {
  core: HackstoreCorePort;
  json?: boolean;
}

/**
 * Resolve the manifest.json path from a user-supplied `<path>`, which may be the
 * manifest file itself or a directory containing one. Returns the resolved file
 * path, or an error string when it cannot be located.
 */
function resolveManifestPath(pathArg: string): { ok: true; file: string } | { ok: false; error: string } {
  const target = resolve(pathArg);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) return { ok: false, error: `refusing symbolic link: ${target}` };
    return { ok: true, file: stat.isDirectory() ? join(target, MANIFEST_FILE) : target };
  } catch (error) {
    return { ok: false, error: `cannot locate manifest at ${target}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Read only bounded, regular files, without following an author-controlled symlink. */
function readAuthorFile(file: string, maxBytes: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${file} exceeds ${maxBytes} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export type LocalExtensionResult =
  | { ok: true; dir: string; manifest: PluginManifest; source: string }
  | { ok: false; errors: string[] };

/** The same manifest checks as the host, plus the fixed two-file install contract. */
export function readLocalExtension(pathArg: string, core: HackstoreCorePort): LocalExtensionResult {
  const located = resolveManifestPath(pathArg);
  if (!located.ok) return { ok: false, errors: [located.error] };
  try {
    const result = core.validatePluginManifest(
      JSON.parse(readAuthorFile(located.file, MAX_MANIFEST_BYTES)),
      { reservedToolNames: core.reservedToolNames },
    );
    if (!result.ok) return result;
    const dir = dirname(located.file);
    if (core.reservedPluginIds?.includes(result.manifest.id)) {
      return { ok: false, errors: [`"${result.manifest.id}" is reserved for built-in host authorization`] };
    }
    const source = readAuthorFile(join(dir, "plugin.js"), MAX_SOURCE_BYTES);
    if (source.trim().length === 0) return { ok: false, errors: ["plugin.js must not be empty"] };
    const index = { entries: [{
      id: result.manifest.id, version: result.manifest.version, manifest: result.manifest,
      source: { kind: "inline", files: { "plugin.js": source } },
    }] };
    if (Buffer.byteLength(JSON.stringify(index), "utf8") > MAX_SOURCE_BYTES) {
      return { ok: false, errors: ["extension exceeds the registry's 4 MiB inline index limit"] };
    }
    return { ok: true, dir, manifest: result.manifest, source };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * `0 hackstore validate <path>` — read + parse + validate a manifest against
 * the same contract the store enforces. Sets a non-zero exit code on any
 * failure (missing file, bad JSON, invalid manifest).
 */
export function runValidate(pathArg: string, deps: ValidateDeps): void {
  const asJson = deps.json === true;
  const fail = (errors: string[]): void => {
    if (asJson) {
      console.log(JSON.stringify({ ok: false, errors }, null, 2));
    } else {
      console.error(chalk.red(`Invalid extension (${errors.length} error${errors.length === 1 ? "" : "s"}):`));
      for (const e of errors) console.error(`  ${chalk.red("•")} ${e}`);
    }
    process.exitCode = EXIT_USER_ERROR;
  };

  const located = resolveManifestPath(pathArg);
  if (!located.ok) {
    fail([located.error]);
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readAuthorFile(located.file, MAX_MANIFEST_BYTES));
  } catch (err) {
    fail([`cannot read manifest: ${err instanceof Error ? err.message : String(err)}`]);
    return;
  }

  const result = deps.core.validatePluginManifest(raw, { reservedToolNames: deps.core.reservedToolNames });
  if (!result.ok) {
    fail(result.errors);
    return;
  }

  const { id, version, tools } = result.manifest;
  if (deps.core.reservedPluginIds?.includes(result.manifest.id)) {
    fail([`"${result.manifest.id}" is reserved for built-in host authorization`]);
    return;
  }
  const n = tools.length;
  if (asJson) {
    console.log(
      JSON.stringify(
        { ok: true, id, version, tools: n, capabilities: [...new Set(tools.flatMap((t) => t.capabilities))].sort() },
        null,
        2,
      ),
    );
  } else {
    console.log(chalk.green(`OK: ${id}@${version}, ${n} tool${n === 1 ? "" : "s"}`));
  }
  process.exitCode = EXIT_OK;
}

// ── init ──────────────────────────────────────────────────────────────────────

export interface InitDeps {
  /** Parent directory the `<name>/` extension dir is created inside. Default cwd. */
  dir?: string;
  /** Overwrite / write into a non-empty target directory. */
  force?: boolean;
  reservedPluginIds?: readonly string[];
}

/**
 * Turn an arbitrary extension name into a valid plugin id (see PLUGIN_ID_RE in
 * core): lowercase, ASCII, dotted/hyphenated, starting with a letter. Always
 * returns something the validator accepts so the scaffolded manifest is valid.
 */
export function slugifyId(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s || !/^[a-z]/.test(s)) s = `ext-${s}`.replace(/-+$/g, "");
  return s.slice(0, 64).replace(/-+$/g, "");
}

/** The scaffolded manifest — a minimal, VALID PluginManifest with one tool. */
function scaffoldManifest(name: string): PluginManifest & { $schema: string } {
  return {
    $schema: HACKSTORE_SCHEMA_ID,
    id: slugifyId(name),
    name,
    version: "0.1.0",
    tools: [
      {
        name: "sha256",
        description: `Compute the SHA-256 hash of a text input. Example tool for the "${name}" extension.`,
        parameters: {
          input: {
            type: "string",
            description: "Text to hash.",
          },
        },
        required: ["input"],
        // Declares the tool's behavior; it does not sandbox the process.
        capabilities: ["compute"],
      },
    ],
  };
}

function scaffoldReadme(name: string, id: string): string {
  return `# ${name}

A [Hackstore](https://${HACKSTORE_REGISTRY_REPO}) extension for 0.
The included \`sha256\` tool hashes its \`input\` string.

## Develop and test

Edit \`manifest.json\` and \`plugin.js\` together. The installer writes the
manifest as \`plugin.json\`; the program reads that file when it starts.

\`\`\`sh
0 hackstore validate .
0 plugin install . --local
0 plugin info ${id}
0 plugin enable ${id}
0 plugin run ${id} sha256 input=hello
\`\`\`

Installation copies only the manifest and entry point; it neither runs nor enables
code. Enablement approves this code for the current project. The plugin runs under
your account, not in an OS sandbox. Use an isolated home/project for untrusted code.
Name the tool before passing arguments. Validate arguments in the implementation,
return failures explicitly, and keep stdout for protocol frames. Capability
declarations inform approvals; they do not sandbox the code.

Full author guide: https://docs.0.security/hackstore/

## Prepare and submit

\`\`\`sh
0 hackstore prepare-submission . --out ../${id}-submission
\`\`\`

This creates \`extensions/${id}/\` with the validated manifest, source, and this
README. Nothing is uploaded or published. Inspect the files, fork and clone
[Hackstore](https://${HACKSTORE_REGISTRY_REPO}), copy that extension directory into
the fork, and follow its [contribution instructions](https://${HACKSTORE_REGISTRY_REPO}/blob/main/CONTRIBUTING.md).
Run \`npm ci\`, \`npm run build\`, \`npm run check\`, and \`npm test\` there, then
submit the extension and rebuilt \`index.json\` in a pull request.
Include evidence of a successful call and a real failure, prerequisites, limits,
and the reason for each capability. Do not hand-copy source into \`index.json\`.
`;
}

/** A self-contained protocol program with one working compute tool. */
function scaffoldPluginSource(): string {
  return `"use strict";
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");

// Read the installed manifest so version and description edits stay in sync.
const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
function send(message) {
  process.stdout.write(JSON.stringify({ v: 1, ...message }) + "\\n");
}

send({ kind: "handshake", pluginId: manifest.id, version: manifest.version, manifest });
const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || message.v !== 1 || typeof message.id !== "string") return;
  if (message.kind === "list_tools") {
    send({ kind: "list_tools", id: message.id, tools: manifest.tools });
  } else if (message.kind === "call_tool") {
    try {
      if (message.tool !== "sha256") throw new Error("Unknown tool.");
      if (typeof message.args?.input !== "string") {
        throw new Error("input must be a string.");
      }
      const hash = createHash("sha256").update(message.args.input, "utf8").digest("hex");
      send({ kind: "tool_result", id: message.id, ok: true, content: hash, truncated: false });
    } catch (error) {
      send({ kind: "tool_result", id: message.id, ok: false, content: error.message, truncated: false });
    }
  }
});
`;
}


/**
 * `0 hackstore init <name>` — scaffold a new extension directory `<name>/`
 * containing a minimal valid manifest.json, a README, and an example tool
 * source file. Refuses to write into a non-empty directory unless `--force`.
 */
export function runInit(name: string, deps: InitDeps): void {
  const base = deps.dir ? resolve(deps.dir) : process.cwd();
  if (!name.trim() || name.length > 2000 || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    console.error(chalk.red("Extension name must be a single non-empty directory name (at most 2000 characters)."));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const targetDir = join(base, name);
  const manifest = scaffoldManifest(name);
  const id = manifest.id;
  if (deps.reservedPluginIds?.includes(id)) {
    console.error(chalk.red(`"${id}" is reserved for built-in host authorization; choose another extension name.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  try {
    const target = lstatSync(targetDir, { throwIfNoEntry: false });
    if (target && !target.isDirectory()) throw new Error(`refusing non-directory or symbolic link: ${targetDir}`);
    if (deps.force !== true && target && readdirSync(targetDir).length > 0) {
      throw new Error(`refusing to overwrite non-empty directory: ${targetDir}; pass --force to replace scaffold files`);
    }
    const files = {
      [MANIFEST_FILE]: `${JSON.stringify(manifest, null, 2)}\n`,
      "README.md": scaffoldReadme(name, id),
      "plugin.js": scaffoldPluginSource(),
    };
    for (const filename of Object.keys(files)) {
      const file = join(targetDir, filename);
      const existing = lstatSync(file, { throwIfNoEntry: false });
      if (existing && !existing.isFile()) throw new Error(`refusing non-regular file or symbolic link: ${file}`);
    }
    mkdirSync(targetDir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      const fd = openSync(join(targetDir, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, content); } finally { closeSync(fd); }
    }
  } catch (error) {
    console.error(chalk.red(`Cannot scaffold: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  console.log(chalk.green(`Scaffolded Hackstore extension ${chalk.bold(id)} in ${targetDir}`));
  console.log("");
  console.log(chalk.bold("  Files:"));
  console.log(`    ${MANIFEST_FILE}      the extension manifest (edit this)`);
  console.log(`    README.md          how to develop, validate, and submit`);
  console.log(`    plugin.js          self-contained plugin (NDJSON protocol over stdio)`);
  console.log("");
  console.log(chalk.bold("  Next steps:"));
  console.log(`    1. Edit ${join(name, MANIFEST_FILE)} and plugin.js — declare actual tools + capabilities`);
  console.log(`    2. Validate: ${chalk.cyan(`0 hackstore validate ${JSON.stringify(name)}`)}`);
  console.log(`    3. Install locally: ${chalk.cyan(`0 plugin install ${JSON.stringify(name)} --local`)}`);
  console.log(`    4. Inspect and approve: ${chalk.cyan(`0 plugin info ${id} && 0 plugin enable ${id}`)}`);
  console.log(`    5. Run: ${chalk.cyan(`0 plugin run ${id} sha256 input=hello`)}`);
  console.log(`    6. Prepare review: ${chalk.cyan(`0 hackstore prepare-submission ${JSON.stringify(name)}`)}`);
  process.exitCode = EXIT_OK;
}

/** Produce only the source layout accepted by Hackstore; publishing remains a reviewed PR. */
export function runPrepareSubmission(pathArg: string, deps: { core: HackstoreCorePort; out?: string }): void {
  const extension = readLocalExtension(pathArg, deps.core);
  if (!extension.ok) {
    for (const error of extension.errors) console.error(chalk.red(error));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const output = resolve(deps.out ?? `${extension.manifest.id}-submission`);
  let created = false;
  try {
    const readme = readAuthorFile(join(extension.dir, "README.md"), MAX_MANIFEST_BYTES);
    if (!readme.trim()) throw new Error("README.md must explain prerequisites, arguments, results, and limits");
    if (existsSync(output) || lstatSync(output, { throwIfNoEntry: false })) {
      throw new Error(`refusing to overwrite existing submission path: ${output}`);
    }
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(output, { mode: 0o700 });
    created = true;
    const target = join(output, "extensions", extension.manifest.id);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const files = {
      "manifest.json": `${JSON.stringify({ $schema: HACKSTORE_SCHEMA_ID, ...extension.manifest }, null, 2)}\n`,
      "plugin.js": extension.source,
      "README.md": readme,
    };
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(target, name), content, { mode: 0o600, flag: "wx" });
    }
    console.log(chalk.green(`Prepared ${extension.manifest.id}@${extension.manifest.version}: ${target}`));
    for (const [name, content] of Object.entries(files)) {
      console.log(`  SHA-256 ${name}: ${createHash("sha256").update(content).digest("hex")}`);
    }
    console.log("Not published. No code was executed and nothing was uploaded.");
    console.log(`Fork and clone https://${HACKSTORE_REGISTRY_REPO}, then copy this extensions directory into your fork.`);
    console.log("In the fork: npm ci && npm run build && npm run check && npm test");
    console.log("Review and commit extensions/<id>/ plus the rebuilt index.json, then open a pull request.");
    console.log("Include tested versions, successful and failing tool calls, capability rationale, prerequisites, and limits.");
    console.log(`Submission policy: https://${HACKSTORE_REGISTRY_REPO}/blob/main/CONTRIBUTING.md`);
    process.exitCode = EXIT_OK;
  } catch (error) {
    if (created) rmSync(output, { recursive: true, force: true });
    console.error(chalk.red(`Could not prepare submission: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = EXIT_USER_ERROR;
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerHackstoreCommand(program: Command): void {
  const hackstore = program
    .command("hackstore")
    .aliases(["hack", "store"])
    .description("Author extensions for Hackstore, the 0 extension store");

  hackstore
    .command("init <name>")
    .description("Scaffold a new extension directory ready to edit, validate, and submit")
    .option("--dir <path>", "Parent directory to create the extension in (default: cwd)")
    .option("--force", "Write into a non-empty target directory")
    .action(async (name: string, opts: { dir?: string; force?: boolean }) => {
      const core = await defaultCorePort();
      runInit(name, { dir: opts.dir, force: opts.force === true, reservedPluginIds: core.reservedPluginIds });
    });

  hackstore
    .command("validate <path>")
    .description("Validate a manifest.json (or a directory containing one) against the store contract")
    .option("--json", "Emit machine-readable JSON")
    .action(async (pathArg: string, opts: { json?: boolean }) => {
      runValidate(pathArg, { core: await defaultCorePort(), json: opts.json === true });
    });

  hackstore
    .command("prepare-submission <path>")
    .description("Create a reproducible extensions/<id> source bundle for a reviewed Hackstore PR (does not publish)")
    .option("--out <directory>", "New output directory (default: <id>-submission)")
    .action(async (pathArg: string, opts: { out?: string }) => {
      runPrepareSubmission(pathArg, { core: await defaultCorePort(), out: opts.out });
    });
}
