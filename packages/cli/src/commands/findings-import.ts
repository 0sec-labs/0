import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { resolveOsecDbPath } from "@0/engine/storage";
import {
  importGithubAlerts,
  importSarif,
  parseAlertKinds,
  type GithubAlertState,
} from "../report-import.js";
import { assertLocalEngineAvailable } from "../local-engine.js";
import { finishWithError, UsageError } from "./output.js";

const MAX_BYTES = 20 * 1024 * 1024;

export interface FindingsImportDeps {
  out(text: string): void;
  err(text: string): void;
  readInput(path: string): string;
  gh(args: string[], input?: string): Promise<string>;
}

export interface FindingsImportOptions {
  github?: string;
  state?: string;
  types?: string;
  ref?: string;
  tool?: string;
  root?: string;
  dbPath?: string;
  format?: string;
}

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

const defaultGh = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
  const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error((stderr || stdout).trim().split("\n")[0] || `gh exited with ${code}`)));
  child.stdin.end(input ?? "");
});

const defaultDeps: FindingsImportDeps = {
  out: text => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  err: text => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
  readInput,
  gh: defaultGh,
};

/** `0 findings import`: bring another scanner's SARIF results or GitHub security alerts in as findings. */
export function registerFindingsImportCommand(parent: Command, deps: FindingsImportDeps = defaultDeps): void {
  parent.command("import")
    .description("Import findings from another scanner's SARIF 2.1.0 file (use - for stdin) or from GitHub security alerts. Nothing in the file is executed.")
    .argument("[file]", "SARIF file, or - to read standard input")
    .option("--github <owner/repo>", "Import security alerts from a GitHub repository via GitHub connection")
    .option("--state <state>", "Filter alerts by state: open, dismissed, fixed, all", "open")
    .option("--types <types>", "Comma-separated alert kinds: code-scanning, dependabot, secret-scanning, all", "all")
    .option("--ref <branch>", "Filter code-scanning alerts by branch or git ref")
    .option("--tool <name>", "Label for the scanner, overriding the name in the file")
    .option("--root <dir>", "Folder that was scanned; absolute paths under it become repo-relative (default: the current directory)")
    .option("--db-path <path>", "Destination database; stop its running console before importing")
    .option("--format <format>", "Output format: text or json", "text")
    .action(async (file: string | undefined, options: FindingsImportOptions) => {
      try {
        if (!file && !options.github) {
          throw new UsageError("Provide a SARIF file or specify --github <owner/repo> to import alerts.");
        }
        if (file && options.github) {
          throw new UsageError("Cannot combine SARIF file with --github.");
        }

        const dbPath = resolveOsecDbPath(options.dbPath);
        assertLocalEngineAvailable(options.dbPath);

        let result: { scanId: string; findings: number; alreadyImported: boolean; dbPath: string };
        if (options.github) {
          result = await importGithubAlerts({
            repo: options.github,
            dbPath,
            state: options.state as GithubAlertState | undefined,
            types: parseAlertKinds(options.types),
            ref: options.ref,
            tool: options.tool,
          }, deps);
        } else {
          result = importSarif({
            sarifJson: deps.readInput(file!),
            dbPath,
            ...(options.tool ? { tool: options.tool } : {}),
            roots: [resolve(options.root ?? process.cwd())],
          });
        }

        if (options.format === "json") {
          deps.out(JSON.stringify(result));
        } else {
          deps.out(`${result.alreadyImported ? "Already imported" : "Imported"} ${result.findings} finding${result.findings === 1 ? "" : "s"} (${result.scanId.slice(0, 18)}…).`);
        }
      } catch (error) {
        finishWithError(error, { err: deps.err }, options.format === "json");
      }
    });
}
