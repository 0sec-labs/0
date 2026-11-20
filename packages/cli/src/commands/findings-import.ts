import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { resolveOsecDbPath } from "@0/engine/storage";
import { importSarif } from "../report-import.js";
import { assertLocalEngineAvailable } from "../local-engine.js";
import { finishWithError, UsageError } from "./output.js";

const MAX_BYTES = 20 * 1024 * 1024;

function readInput(path: string): string {
  if (path === "-") {
    const text = readFileSync(0, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new UsageError("The SARIF input exceeds 20 MB.");
    return text;
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new UsageError("The SARIF file must be a regular file of at most 20 MB.");
  return readFileSync(path, "utf8");
}

/** `0 findings import`: bring another scanner's SARIF results in as findings. */
export function registerFindingsImportCommand(parent: Command): void {
  parent.command("import")
    .description("Import findings from another scanner's SARIF 2.1.0 file (use - for stdin). Nothing in the file is executed.")
    .argument("<file>", "SARIF file, or - to read standard input")
    .option("--tool <name>", "Label for the scanner, overriding the name in the file")
    .option("--root <dir>", "Folder that was scanned; absolute paths under it become repo-relative (default: the current directory)")
    .option("--db-path <path>", "Destination database; stop its running console before importing")
    .action((file: string, options: { tool?: string; root?: string; dbPath?: string; format?: string }) => {
      try {
        const dbPath = resolveOsecDbPath(options.dbPath);
        assertLocalEngineAvailable(options.dbPath);
        const result = importSarif({ sarifJson: readInput(file), dbPath, ...(options.tool ? { tool: options.tool } : {}), roots: [resolve(options.root ?? process.cwd())] });
        if (options.format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
        else process.stdout.write(`${result.alreadyImported ? "Already imported" : "Imported"} ${result.findings} finding${result.findings === 1 ? "" : "s"} (${result.scanId.slice(0, 18)}…).\n`);
      } catch (error) { finishWithError(error, { err: text => process.stderr.write(`${text}\n`) }, options.format === "json"); }
    });
}
