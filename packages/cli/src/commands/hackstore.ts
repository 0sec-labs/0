// `0sec hackstore` — the community authoring toolkit for Hackstore, the 0sec
// extension store.
//
// A Hackstore extension is a `PluginManifest` (declaring one or more tools, each
// gated by a closed set of capabilities) plus its source files. This command is
// the AUTHOR's surface — it never installs, enables, or runs anything:
//
//   init <name>      — scaffold a new extension directory, ready to edit.
//   validate <path>  — run a manifest.json through the SAME validator
//                      (`validatePluginManifest`) the loader uses, so what
//                      passes here is exactly what the store will accept.
//
// Installing, enabling, and running extensions is the job of `0sec plugin`; the
// trust model (installed = bytes on disk, nothing runs; enabled = one operator
// json record; running = only at scan time for enabled ids) lives there.
//
// DEPENDENCY NOTE
// ───────────────
// The one core primitive this command needs — `validatePluginManifest` — is
// consumed through an injected {@link HackstoreCorePort} so the subcommands are
// unit-testable with the real validator imported directly from core source
// (no barrel round-trip), matching the technique in commands/__tests__/. The
// production port lazily imports the `@0sec/core` barrel, which re-exports it.

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
    minCoreVersion: "0.9.0",
    tools: [
      {
        name: "example_tool",
        description: `An example tool for the "${name}" extension. Replace this with a real tool.`,
        parameters: {
          input: {
            type: "string",
            description: "Example input parameter.",
          },
        },
        required: ["input"],
        // "compute" is the least-privileged capability: no network, no
        // filesystem, no process spawn, no findings mutation. See docs/HACKSTORE.md.
        capabilities: ["compute"],
      },
    ],
  };
}

function scaffoldReadme(name: string, id: string): string {
  return `# ${name}

A [Hackstore](${HACKSTORE_INDEX_URL}) extension for the 0sec CLI.

- **id**: \`${id}\`
- **manifest**: [\`manifest.json\`](./manifest.json)

## Develop

Edit \`manifest.json\` to declare your tools and their capabilities, then implement
them in your source files (see \`example_tool.mjs\`). Every tool MUST declare a
non-empty \`capabilities\` list from the closed set (compute, model-call, network,
filesystem-read, filesystem-write, process-exec, findings-write).

## Validate

\`\`\`sh
0sec hackstore validate .
\`\`\`

## Submit to the community index

1. Fork ${HACKSTORE_REGISTRY_REPO}
2. Add your manifest entry to \`index.json\`
3. Open a pull request

See the author guide, \`docs/HACKSTORE.md\`, for the full contract and trust model.
`;
}

function scaffoldToolSource(): string {
  return `// Example tool source for a Hackstore extension.
//
// Each tool your manifest declares needs an implementation. This stub shows the
// shape: a named export that receives the validated arguments and returns a
// result. Wire your real logic here and declare only the capabilities you use.

export async function example_tool(args) {
  const { input } = args ?? {};
  return { ok: true, echo: input };
}
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
  writeFileSync(join(targetDir, "example_tool.mjs"), scaffoldToolSource(), "utf8");

  console.log(chalk.green(`Scaffolded Hackstore extension ${chalk.bold(id)} in ${targetDir}`));
  console.log("");
  console.log(chalk.bold("  Files:"));
  console.log(`    ${MANIFEST_FILE}      the extension manifest (edit this)`);
  console.log(`    README.md          how to develop, validate, and submit`);
  console.log(`    example_tool.mjs   example tool implementation`);
  console.log("");
  console.log(chalk.bold("  Next steps:"));
  console.log(`    1. Edit ${join(name, MANIFEST_FILE)} — declare your tools + capabilities`);
  console.log(`    2. Validate:  ${chalk.cyan(`0sec hackstore validate ${name}`)}`);
  console.log(`    3. Submit:    fork ${HACKSTORE_REGISTRY_REPO}, add your entry to`);
  console.log(`                  index.json, and open a pull request`);
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
