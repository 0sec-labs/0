// `0sec hackstore` creates extension source and validates manifests.
// These authoring commands do not install, enable, or execute plugin code.
// `0sec plugin` handles installation, project approval, and direct tool calls.
// Manifest validation is shared with the loader; runnable code is checked
// separately by loading and calling the installed plugin.
//
// HackstoreCorePort lets command tests use the real validator without importing
// the full core barrel. Production resolves it lazily from @0sec/core.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import type { ValidationResult } from "@0sec/core";

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

// ── Core port ─────────────────────────────────────────────────────────────────

/**
 * Everything this command needs from `@0sec/core`. Injected so tests supply the
 * real validator from core source; {@link defaultCorePort} lazily imports the
 * barrel in production.
 */
export interface HackstoreCorePort {
  validatePluginManifest(
    raw: unknown,
    opts?: { reservedToolNames?: readonly string[] },
  ): ValidationResult;
}

let cachedCore: HackstoreCorePort | undefined;
async function defaultCorePort(): Promise<HackstoreCorePort> {
  if (cachedCore) return cachedCore;
  const mod = (await import("@0sec/core")) as unknown as HackstoreCorePort;
  cachedCore = { validatePluginManifest: mod.validatePluginManifest };
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
  if (!existsSync(target)) {
    return { ok: false, error: `path does not exist: ${target}` };
  }
  const stat = statSync(target);
  const file = stat.isDirectory() ? join(target, MANIFEST_FILE) : target;
  if (!existsSync(file)) {
    return { ok: false, error: `no ${MANIFEST_FILE} found at: ${file}` };
  }
  return { ok: true, file };
}

/**
 * `0sec hackstore validate <path>` — read + parse + validate a manifest against
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
    raw = JSON.parse(readFileSync(located.file, "utf8"));
  } catch (err) {
    fail([`${MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
    return;
  }

  const result = deps.core.validatePluginManifest(raw);
  if (!result.ok) {
    fail(result.errors);
    return;
  }

  const { id, version, tools } = result.manifest;
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
  return s;
}

/** The scaffolded manifest — a minimal, VALID PluginManifest with one tool. */
function scaffoldManifest(name: string): Record<string, unknown> {
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

A [Hackstore](https://${HACKSTORE_REGISTRY_REPO}) extension for 0sec.
The included \`sha256\` tool hashes its \`input\` string.

## Develop and test

Edit \`manifest.json\` and \`plugin.js\` together. The installer writes the
manifest as \`plugin.json\`; the program reads that file when it starts.

\`\`\`sh
0sec hackstore validate .
\`\`\`

Follow the [local installation guide](https://github.com/0sec-labs/0sec/blob/main/docs/HACKSTORE.md#run-locally)
to test with an isolated home and project. After installing and enabling:

\`\`\`sh
0sec plugin run ${id} sha256 input=hello
\`\`\`

Name the tool before passing arguments. Validate arguments in the implementation,
return failures explicitly, and keep stdout for protocol frames. Capability
declarations inform approvals; they do not sandbox the code.

## Publish

Follow the [submission instructions](https://${HACKSTORE_REGISTRY_REPO}/blob/main/CONTRIBUTING.md).
Add the source under \`extensions/\` in that repository and run \`npm run build\`
to generate the registry entry. Do not hand-copy source into \`index.json\`.
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

/** Is `dir` an existing, non-empty directory? */
function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const stat = statSync(dir);
  if (!stat.isDirectory()) return true; // a file at that path counts as "occupied"
  return readdirSync(dir).length > 0;
}

/**
 * `0sec hackstore init <name>` — scaffold a new extension directory `<name>/`
 * containing a minimal valid manifest.json, a README, and an example tool
 * source file. Refuses to write into a non-empty directory unless `--force`.
 */
export function runInit(name: string, deps: InitDeps): void {
  const base = deps.dir ? resolve(deps.dir) : process.cwd();
  const targetDir = join(base, name);

  if (existsSync(targetDir) && statSync(targetDir).isFile()) {
    console.error(chalk.red(`Cannot scaffold: a file already exists at ${targetDir}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  if (deps.force !== true && isNonEmptyDir(targetDir)) {
    console.error(
      chalk.red(`Refusing to overwrite non-empty directory: ${targetDir}`) +
        chalk.dim("\n  Pass --force to write into it anyway."),
    );
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  const manifest = scaffoldManifest(name);
  const id = manifest.id as string;

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(targetDir, "README.md"), scaffoldReadme(name, id), "utf8");
  writeFileSync(join(targetDir, "plugin.js"), scaffoldPluginSource(), "utf8");

  console.log(chalk.green(`Scaffolded Hackstore extension ${chalk.bold(id)} in ${targetDir}`));
  console.log("");
  console.log(chalk.bold("  Files:"));
  console.log(`    ${MANIFEST_FILE}      the extension manifest (edit this)`);
  console.log(`    README.md          how to develop, validate, and submit`);
  console.log(`    plugin.js          self-contained plugin (NDJSON protocol over stdio)`);
  console.log("");
  console.log(chalk.bold("  Next steps:"));
  console.log(`    1. Edit ${join(name, MANIFEST_FILE)} — declare your tools + capabilities`);
  console.log(`    2. Validate:  ${chalk.cyan(`0sec hackstore validate ${name}`)}`);
  console.log(`    3. Test locally and submit: https://${HACKSTORE_REGISTRY_REPO}/blob/main/CONTRIBUTING.md`);
  process.exitCode = EXIT_OK;
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerHackstoreCommand(program: Command): void {
  const hackstore = program
    .command("hackstore")
    .aliases(["hack", "store"])
    .description("Author extensions for Hackstore, the 0sec extension store");

  hackstore
    .command("init <name>")
    .description("Scaffold a new extension directory ready to edit, validate, and submit")
    .option("--dir <path>", "Parent directory to create the extension in (default: cwd)")
    .option("--force", "Write into a non-empty target directory")
    .action((name: string, opts: { dir?: string; force?: boolean }) => {
      runInit(name, { dir: opts.dir, force: opts.force === true });
    });

  hackstore
    .command("validate <path>")
    .description("Validate a manifest.json (or a directory containing one) against the store contract")
    .option("--json", "Emit machine-readable JSON")
    .action(async (pathArg: string, opts: { json?: boolean }) => {
      runValidate(pathArg, { core: await defaultCorePort(), json: opts.json === true });
    });
}
