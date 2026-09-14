import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const builder = fileURLToPath(new URL("./build-dev-engine.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "0sec-engine-generation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "generation");
  await mkdir(join(source, "console"), { recursive: true });
  await writeFile(join(source, "console", "turn-engine.ts"), `
    import { readFileSync } from "node:fs";
    export function readMessage() {
      return readFileSync(new URL("../message.txt", import.meta.url), "utf8");
    }
  `);
  return {
    root, source,
    build: () => execute(process.execPath, [builder, source, output], { timeout: 15_000 }),
  };
}

test("a generated module can consume a contained source-file alias", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, "document.md"), "generation asset is available");
  await symlink("document.md", join(f.source, "message.txt"));
  const { stdout } = await f.build();
  const generation = await import(pathToFileURL(JSON.parse(stdout).entry).href);
  assert.equal(generation.readMessage(), "generation asset is available");
});

test("an escaping source-file alias prevents generation publication", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "private.txt"), "not part of the source snapshot");
  await symlink("../private.txt", join(f.source, "message.txt"));
  await assert.rejects(f.build(), (error) => error.code === 1);
});

test("a directory alias cannot introduce a recursive source walk", async (t) => {
  const f = await fixture(t);
  await symlink(".", join(f.source, "cycle"), "dir");
  await assert.rejects(f.build(), (error) => error.code === 1);
});
