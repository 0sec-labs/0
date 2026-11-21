/**
 * `0 findings upload <sarif>`: put a SARIF file where the team already looks, GitHub code scanning (the Security tab and
 * pull request annotations). The file comes from `0 scan --format sarif` or any scanner. GitHub keys each alert by its
 * fingerprint, so uploading again for a later commit updates the alerts instead of duplicating them.
 */
import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import type { Command } from "commander";
import { looksLikeSarif } from "@0/engine/shared";
import { finishWithError, UsageError } from "./output.js";

const exec = promisify(execFile);
const MAX_SARIF_BYTES = 20 * 1024 * 1024;
const MAX_GZIP_BYTES = 10 * 1024 * 1024;
const REPO = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const REF = /^refs\/(heads|tags|pull)\/[A-Za-z0-9._\/-]{1,200}$/;

export interface UploadDeps {
  out(text: string): void;
  err(text: string): void;
  sleep(ms: number): Promise<void>;
  readText(path: string): string;
  /** Run `gh` with these arguments and an optional request body on standard input. */
  gh(args: string[], input?: string): Promise<string>;
  git(args: string[]): Promise<string>;
}
const defaults: UploadDeps = {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  sleep: ms => new Promise(done => setTimeout(done, ms)),
  readText(path) {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_SARIF_BYTES) throw new UsageError("The SARIF file must be a regular file of at most 20 MB.");
    return readFileSync(path, "utf8");
  },
  gh: (args, input) => new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error((stderr || stdout).trim().split("\n")[0] || `gh exited with ${code}`)));
    child.stdin.end(input ?? "");
  }),
  git: async args => (await exec("git", args)).stdout,
};

export interface UploadOptions { repo?: string; commit?: string; ref?: string; wait: boolean; tool?: string; format?: string }

/** The SARIF as GitHub wants it: gzip, then base64. */
export function packSarif(text: string): string {
  const packed = gzipSync(Buffer.from(text, "utf8"));
  if (packed.byteLength > MAX_GZIP_BYTES) throw new UsageError("GitHub accepts at most 10 MB of compressed SARIF; split the file.");
  return packed.toString("base64");
}

export async function runUpload(file: string, options: UploadOptions, deps: UploadDeps = defaults): Promise<{ id: string; status: string } | undefined> {
  const text = deps.readText(file);
  if (!looksLikeSarif(text)) throw new UsageError("This is not a SARIF 2.1.0 file. Make one with `0 scan --format sarif -o scan.sarif`.");

  const repo = options.repo ?? (await deps.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).catch(() => "")).trim();
  if (!REPO.test(repo)) throw new UsageError("Name the repository with --repo owner/name (or run this inside its clone).");
  const commit = (options.commit || process.env.GITHUB_SHA || (await deps.git(["rev-parse", "HEAD"]).catch(() => ""))).trim();
  if (!SHA.test(commit)) throw new UsageError("Name the commit with --commit <40-character sha> (or run this inside the clone).");
  let ref = options.ref || process.env.GITHUB_REF || undefined;
  if (!ref) { const branch = (await deps.git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim(); ref = branch && branch !== "HEAD" ? `refs/heads/${branch}` : undefined; }
  if (!ref || !REF.test(ref)) throw new UsageError("Name the ref with --ref refs/heads/<branch> (or refs/pull/<n>/merge).");

  const body = JSON.stringify({ commit_sha: commit, ref, sarif: packSarif(text), ...(options.tool ? { tool_name: options.tool } : {}) });
  const response = JSON.parse(await deps.gh(["api", "--method", "POST", `repos/${repo}/code-scanning/sarifs`, "--input", "-"], body)) as { id?: string };
  if (!response.id) throw new Error("GitHub accepted the upload but returned no id.");
  deps.err(`uploaded to ${repo} at ${commit.slice(0, 7)} (${ref})`);
  if (!options.wait) return { id: response.id, status: "pending" };

  for (let attempt = 0; attempt < 30; attempt++) {
    await deps.sleep(2000);
    const state = JSON.parse(await deps.gh(["api", `repos/${repo}/code-scanning/sarifs/${encodeURIComponent(response.id)}`])) as { processing_status?: string; errors?: string[] };
    if (state.processing_status === "complete") return { id: response.id, status: "complete" };
    if (state.processing_status === "failed") throw new Error(`GitHub could not process the upload: ${(state.errors ?? []).join("; ").slice(0, 300) || "no reason given"}`);
  }
  return { id: response.id, status: "pending" };
}

export function registerFindingsUploadCommand(parent: Command, deps: UploadDeps = defaults): void {
  parent.command("upload")
    .description("Upload a SARIF file to GitHub code scanning, so findings show in the Security tab and on pull requests")
    .argument("<file>", "SARIF 2.1.0 file, for example from `0 scan --format sarif -o scan.sarif`")
    .option("--repo <owner/name>", "Repository (default: the current clone's)")
    .option("--commit <sha>", "Commit the results are for (default: HEAD, or GITHUB_SHA in Actions)")
    .option("--ref <ref>", "refs/heads/<branch> or refs/pull/<n>/merge (default: the current branch, or GITHUB_REF in Actions)")
    .option("--tool <name>", "Name the tool shown in GitHub")
    .option("--no-wait", "Return when GitHub has accepted the upload instead of waiting for it to be processed")
    .option("--format <format>", "Output: text or json", "text")
    .action(async (file: string, options: UploadOptions) => {
      try {
        const result = await runUpload(file, options, deps);
        if (!result) return;
        if (options.format === "json") deps.out(JSON.stringify(result));
        else deps.out(result.status === "complete" ? `Uploaded and processed (${result.id}). The alerts are in the repository's Security tab.` : `Uploaded (${result.id}); GitHub is still processing it.`);
      } catch (error) { finishWithError(error, { err: deps.err }, options.format === "json"); }
    });
}
