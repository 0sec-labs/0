#!/usr/bin/env node
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Transpile an immutable source snapshot, not dist and not a bundle: relative
// imports and import.meta.url-based runtime assets retain their normal layout.
const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error("Expected core source and generation output directories");
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const inputs = [];
const hash = createHash("sha256");
async function snapshot(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "__tests__", "__fixtures__"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await snapshot(path); continue; }
    if ((!entry.isFile() && !entry.isSymbolicLink()) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    let readable = path;
    if (entry.isSymbolicLink()) {
      readable = await realpath(path);
      const target = relative(source, readable);
      if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target) || !(await stat(readable)).isFile()) {
        throw new Error(`Source links must resolve to files inside the core source tree: ${path}`);
      }
    }
    const name = relative(source, path);
    const bytes = await readFile(readable);
    hash.update(name).update("\0").update(bytes).update("\0");
    const target = join(output, "source", name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    if (/\.[cm]?tsx?$/.test(entry.name)) inputs.push(target);
    else {
      const asset = join(output, "runtime", name);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes, { mode: (await stat(readable)).mode & 0o777 });
    }
  }
}
await snapshot(source);
await build({
  entryPoints: inputs,
  outbase: join(output, "source"),
  outdir: join(output, "runtime"),
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: false,
  sourcemap: "linked",
  logLevel: "silent",
});
await writeFile(join(output, "package.json"), JSON.stringify({ type: "module" }));
process.stdout.write(JSON.stringify({ digest: hash.digest("hex"), entry: join(output, "runtime", "console", "turn-engine.js") }) + "\n");
