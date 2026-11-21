/**
 * `0 sbom generate [folder]` writes a CycloneDX SBOM from the lockfiles in a folder; `0 sbom check <file>` looks every
 * component up in the public OSV advisory database. Nothing is installed or run: lockfiles are read as text.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { checkBomAgainstOsv, generateSbom, LOCKFILES, type Advisory } from "@0/engine";
import { VERSION } from "@0/engine/shared";
import { finishWithError, UsageError } from "./output.js";

const MAX_SBOM_BYTES = 50 * 1024 * 1024;

export interface SbomDeps {
  out(text: string): void;
  err(text: string): void;
  write(path: string, text: string): void;
  read(path: string): string;
  fetch?: typeof fetch;
}
const defaults: SbomDeps = {
  out: text => process.stdout.write(text),
  err: text => process.stderr.write(`${text}\n`),
  write: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
  read(path) {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_SBOM_BYTES) throw new UsageError("The SBOM must be a regular file of at most 50 MB.");
    return readFileSync(path, "utf8");
  },
};

export function runGenerate(folder: string, options: { output?: string; name?: string }, deps: SbomDeps): void {
  const target = resolve(folder);
  let isFolder = false;
  try { isFolder = statSync(target).isDirectory(); } catch { /* reported below */ }
  if (!isFolder) throw new UsageError(`'${folder}' is not a folder.`);
  const result = generateSbom(target, { toolVersion: VERSION, ...(options.name ? { name: options.name } : {}) });
  if (!result.lockfiles.length || !result.bom.components.length) {
    const supported = [...new Set(LOCKFILES.map(lock => lock.file))].join(", ");
    throw new UsageError(`No supported lockfile with packages in ${folder}. Supported: ${supported}. For Maven, Gradle, NuGet or container images, generate the SBOM with syft or cdxgen.`);
  }
  const text = `${JSON.stringify(result.bom, null, 2)}\n`;
  if (options.output) { deps.write(resolve(options.output), text); deps.err(`Wrote ${options.output}`); } else deps.out(text);
  deps.err(`${result.bom.components.length} components from ${result.lockfiles.length} lockfile${result.lockfiles.length === 1 ? "" : "s"}: ${result.lockfiles.map(lock => `${lock.path} (${lock.label}, ${lock.components})`).join(", ")}`);
}

export async function runCheck(file: string, options: { format?: string }, deps: SbomDeps): Promise<number> {
  let bom: unknown;
  try { bom = JSON.parse(deps.read(resolve(file))); } catch (error) { if (error instanceof UsageError) throw error; throw new UsageError(`'${file}' is not a JSON SBOM.`); }
  const result = await checkBomAgainstOsv(bom, deps.fetch ? { fetch: deps.fetch } : {}).catch(error => { throw new Error(`Could not check against OSV: ${error instanceof Error ? error.message : String(error)}`); });
  if (options.format === "json") deps.out(`${JSON.stringify(result, null, 2)}\n`);
  else if (!result.advisories.length) deps.out(`No known advisories for ${result.checked} components (OSV).\n`);
  else {
    const byComponent = new Map<string, Advisory[]>();
    for (const advisory of result.advisories) byComponent.set(advisory.purl, [...(byComponent.get(advisory.purl) ?? []), advisory]);
    const lines = [`${result.advisories.length} advisories affect ${byComponent.size} of ${result.checked} components (OSV):`, ""];
    for (const [purl, list] of byComponent) {
      lines.push(purl);
      for (const item of list) lines.push(`  ${item.id}${item.aliases.length ? ` (${item.aliases.join(", ")})` : ""}${item.severity ? `  ${item.severity}` : ""}${item.fixed.length ? `  fixed in ${item.fixed.join(", ")}` : ""}${item.summary ? `\n    ${item.summary}` : ""}`);
    }
    deps.out(`${lines.join("\n")}\n`);
    if (result.withoutDetails) deps.err(`${result.withoutDetails} advisories are listed by id only (details unavailable or over the limit).`);
  }
  return result.advisories.length ? 1 : 0;
}

export function registerSbomCommand(program: Command, deps: SbomDeps = defaults): void {
  const sbom = program.command("sbom").description("Generate an SBOM from lockfiles, and check one against known advisories");
  sbom.command("generate")
    .description("Write a CycloneDX 1.5 SBOM from the lockfiles in a folder (npm, pnpm, yarn, Cargo, Go, Python)")
    .argument("[folder]", "Folder to read lockfiles from", ".")
    .option("-o, --output <file>", "Write the SBOM to a file instead of stdout")
    .option("--name <name>", "Name of the application the SBOM describes (default: the folder's name)")
    .addHelpText("after", "\nNothing is installed or run; lockfiles are read as text. Exit 2 when the folder has no supported lockfile.")
    .action((folder: string, options: { output?: string; name?: string }) => {
      try { runGenerate(folder, options, deps); } catch (error) { finishWithError(error, { err: deps.err }, false); }
    });
  sbom.command("check")
    .description("Look every component of an SBOM up in the public OSV database and list the advisories")
    .argument("<file>", "CycloneDX SBOM (JSON), for example from `0 sbom generate`")
    .option("--format <format>", "Output: text or json", "text")
    .addHelpText("after", "\nThe only network use is the lookup at https://api.osv.dev (package URLs go out; nothing else does).\nExit codes: 0 no advisories, 1 advisories found, 2 usage error.")
    .action(async (file: string, options: { format?: string }) => {
      try { const code = await runCheck(file, options, deps); if (code) process.exitCode = code; }
      catch (error) { finishWithError(error, { err: deps.err }, options.format === "json"); }
    });
}
