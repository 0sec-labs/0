import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { homeStateDir } from "@0/shared";
import { z } from "zod";
import { ensureEvolutionDirectory, readEvolutionArtifact } from "../improvement/artifacts.js";

const execFileAsync = promisify(execFile);
const inputsSchema = z.object({ schema: z.literal(1), repoRoot: z.string().min(1), testCommand: z.string().trim().min(1) }).strict();

export interface SourceFixProjectInputs {
  repoRoot: string;
  testCommand: string;
}

/** A local Git checkout is an input suggestion, never approval to run its scripts. */
export async function resolveSourceFixRepository(path: string | undefined): Promise<string | undefined> {
  if (!path?.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^git@/.test(path)) return undefined;
  try {
    const directory = await realpath(resolve(path.trim()));
    if (!(await stat(directory)).isDirectory()) return undefined;
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, timeout: 5_000, maxBuffer: 64 * 1024 });
    return await realpath(stdout.trim());
  } catch { return undefined; }
}

/** Read only operator-owned home state; checked-in project .0 files are never consulted. */
export function loadSourceFixProjectInputs(repoRoot: string, homeDir?: string): SourceFixProjectInputs | undefined {
  const canonicalRoot = realpathSync(repoRoot);
  const key = createHash("sha256").update(canonicalRoot).digest("hex");
  try {
    const record = inputsSchema.parse(readEvolutionArtifact(join(homeStateDir(homeDir), "source-fix", `${key}.json`)));
    if (record.repoRoot !== canonicalRoot) throw new Error("saved source-fix repository does not match the selected project");
    return { repoRoot: record.repoRoot, testCommand: record.testCommand };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Host/UI only: persist a command after explicit operator approval, not as an execution grant. */
export function saveSourceFixProjectInputs(inputs: SourceFixProjectInputs, homeDir?: string): void {
  const canonicalRoot = realpathSync(inputs.repoRoot);
  const record = inputsSchema.parse({ schema: 1, repoRoot: canonicalRoot, testCommand: inputs.testCommand });
  const directory = ensureEvolutionDirectory(join(homeStateDir(homeDir), "source-fix"));
  const key = createHash("sha256").update(canonicalRoot).digest("hex");
  const temporary = join(directory, `.inputs-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(directory, `${key}.json`));
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
