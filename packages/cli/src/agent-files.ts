import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AGENT_FILE_MAX_BYTES, AGENT_FILE_MAX_FILES, parseAgentFile } from "@0/engine/shared";
import type { AgentDocument } from "./web/agent-apply.js";

export interface LoadedAgentDocuments { root: string; documents: AgentDocument[]; problems: Array<{ path: string; message: string }> }
const MAX_DEPTH = 4;
const isCandidate = (name: string): boolean => /\.md$/i.test(name) && !name.startsWith("_") && !name.startsWith(".") && name.toLowerCase() !== "readme.md";

async function readSmall(path: string, max: number): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
  if (info.size > max) throw new Error(`larger than ${Math.round(max / 1024)} KiB`);
  return readFile(path, "utf8");
}

/**
 * Reads Agent files from a file or a directory (recursive, at most four levels, symbolic links skipped).
 * `instructions:` references are resolved here, next to the file, and may not leave its folder.
 */
export async function loadAgentDocuments(target: string): Promise<LoadedAgentDocuments> {
  const absolute = resolve(target);
  const info = await lstat(absolute).catch(() => { throw new Error(`Cannot read ${target}.`); });
  const documents: AgentDocument[] = [];
  const problems: LoadedAgentDocuments["problems"] = [];
  const root = info.isDirectory() ? absolute : dirname(absolute);
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) await walk(join(dir, entry.name), depth + 1); }
      else if (entry.isFile() && isCandidate(entry.name)) files.push(join(dir, entry.name));
    }
  };
  if (info.isDirectory()) await walk(absolute, 0);
  else if (info.isFile()) files.push(absolute);
  else throw new Error(`${target} is not a file or directory.`);
  if (files.length > AGENT_FILE_MAX_FILES) throw new Error(`Found more than ${AGENT_FILE_MAX_FILES} Agent files.`);
  for (const file of files) {
    const path = relative(root, file).split(sep).join("/") || basename(file);
    let content: string;
    try { content = await readSmall(file, AGENT_FILE_MAX_BYTES); } catch (error) { problems.push({ path, message: `Cannot read file: ${error instanceof Error ? error.message : "unreadable"}.` }); continue; }
    const document: AgentDocument = { path, content };
    const parsed = parseAgentFile(content);
    if (parsed.ok && parsed.file.instructions !== undefined) {
      const folder = dirname(file);
      const referenced = resolve(folder, parsed.file.instructions);
      try {
        const [realFolder, realReferenced] = await Promise.all([realpath(folder), realpath(referenced)]);
        if (realReferenced !== realFolder && !realReferenced.startsWith(realFolder + sep)) throw new Error("it points outside the folder of the file");
        document.charter = await readSmall(referenced, 65_536);
      } catch (error) { problems.push({ path, message: `Cannot read the charter "${parsed.file.instructions}": ${error instanceof Error ? error.message : "unreadable"}.` }); continue; }
    }
    documents.push(document);
  }
  return { root, documents, problems };
}
