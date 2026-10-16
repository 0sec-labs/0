#!/usr/bin/env node
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

// A generation contains only trusted UI source, never session checkpoints,
// environment exports or credentials. Runtime packages and stateful services
// are external so every generation uses the process's one React/native engine.
const [rootArgument, outputArgument] = process.argv.slice(2);
if (!rootArgument || !outputArgument) throw new Error("Expected checkout and generation output directories");
const root = resolve(rootArgument);
const output = resolve(outputArgument);
const source = join(root, "packages/cli/src/tui");
const snapshotRoot = join(output, "source");
const snapshot = join(snapshotRoot, "tui");
const hash = createHash("sha256");
const shared = new Set(["tui/settings-store", "tui/output-guard", "tui/tui-crash"]);
async function copy(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "__tests__", "__fixtures__"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await copy(path); continue; }
    if (!entry.isFile() || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    const name = relative(source, path);
    const bytes = await readFile(path);
    hash.update(name).update("\0").update(bytes).update("\0");
    const target = join(snapshot, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}
try {
  await mkdir(output, { recursive: true, mode: 0o700 });
  await copy(source);
  const entry = join(output, "ui.js");
  await build({
    entryPoints: [join(snapshot, "run.tsx")], outfile: `${entry}.pending`,
    platform: "node", target: "node22", format: "esm", bundle: true,
    packages: "external", jsx: "automatic", jsxImportSource: "@opentui/react",
    sourcemap: "inline", logLevel: "silent",
    plugins: [{ name: "shared-process-services", setup(builder) {
      builder.onResolve({ filter: /^\./ }, args => {
        const target = resolve(args.resolveDir, args.path);
        const name = relative(snapshotRoot, target).replace(/\.[cm]?[jt]sx?$/, "");
        if (name.startsWith("tui/") && !shared.has(name)) return;
        return { path: join(root, "packages/cli/dist", `${name}.js`), external: true };
      });
    } }],
  });
  await writeFile(join(output, "package.json"), JSON.stringify({ type: "module" }));
  // Publishing the entry is the final build step; a partial build is never imported.
  await rename(`${entry}.pending`, entry);
  process.stdout.write(JSON.stringify({ digest: hash.digest("hex"), entry }) + "\n");
} catch (error) {
  await rm(output, { recursive: true, force: true });
  // Do not echo source lines: a local UI edit may contain sensitive literals.
  const diagnostic = error?.errors?.[0];
  const location = diagnostic?.location;
  process.stderr.write(`0dev UI build rejected${location ? ` (${location.file}:${location.line}:${location.column})` : ""}: syntax/module validation failed\n`);
  process.exitCode = 1;
}
