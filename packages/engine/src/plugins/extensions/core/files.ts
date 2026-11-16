/**
 * In-memory folder model and its content hash. No file system access here: adapters read and write
 * folders; this module only reasons about them. The hash is git's tree object id, so an installed
 * folder can be compared with `git rev-parse <sha>^{tree}` of the commit it claims to be.
 */
import { createHash } from "node:crypto";
import { err, ok, type Result } from "./result.js";

export const LIMITS = { files: 512, bytes: 16 * 1024 * 1024, depth: 12 } as const;

export interface FolderFile { readonly path: string; readonly size: number; readonly executable: boolean; readonly bytes: Buffer }

const sha1 = (parts: Array<Buffer | string>) => { const hash = createHash("sha1"); for (const part of parts) hash.update(part); return hash.digest(); };
export const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Paths must be relative, normalized, free of `.git` and traversal, and the folder must fit the limits. */
export function validateFolder(files: readonly FolderFile[]): Result<void> {
  if (files.length > LIMITS.files) return err("unsafe_content", `More than ${LIMITS.files} files.`);
  let bytes = 0;
  for (const file of files) {
    const parts = file.path.split("/");
    if (!file.path || file.path.includes("\\") || file.path.includes("\0") || parts.length > LIMITS.depth || parts.some(p => !p || p === "." || p === ".." || p === ".git")) return err("unsafe_content", `Unsafe path ${JSON.stringify(file.path)}.`);
    bytes += file.size;
  }
  return bytes > LIMITS.bytes ? err("unsafe_content", "Larger than 16 MB.") : ok(undefined);
}

interface Node { files: Map<string, FolderFile>; dirs: Map<string, Node> }

export function gitTreeHash(files: readonly FolderFile[]): string {
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const file of files) {
    const parts = file.path.split("/"); let node = root;
    for (const part of parts.slice(0, -1)) { let next = node.dirs.get(part); if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(part, next); } node = next; }
    node.files.set(parts[parts.length - 1]!, file);
  }
  const oid = (node: Node): Buffer => {
    const rows: Array<{ sort: string; body: Buffer }> = [];
    for (const [name, file] of node.files) rows.push({ sort: name, body: Buffer.concat([Buffer.from(`${file.executable ? "100755" : "100644"} ${name}\0`), sha1([`blob ${file.bytes.length}\0`, file.bytes])]) });
    for (const [name, child] of node.dirs) rows.push({ sort: `${name}/`, body: Buffer.concat([Buffer.from(`40000 ${name}\0`), oid(child)]) });
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
    const body = Buffer.concat(rows.map(row => row.body));
    return sha1([`tree ${body.length}\0`, body]);
  };
  return oid(root).toString("hex");
}

const HIDDEN_UNICODE = /[​-‏⁠⁦-⁩‪-‮﻿]/;
export const hiddenUnicodeFiles = (files: readonly FolderFile[]): string[] =>
  files.filter(f => f.size < 512 * 1024 && !f.bytes.includes(0) && HIDDEN_UNICODE.test(f.bytes.toString("utf8"))).map(f => f.path);

export const textOf = (files: readonly FolderFile[], path: string): string | undefined => files.find(f => f.path === path)?.bytes.toString("utf8");
