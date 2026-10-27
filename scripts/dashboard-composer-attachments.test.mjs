import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

test("composer reads UTF-8 text and rejects binary, oversized and unknown files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "0-composer-test-"));
  try {
    const output = join(temporary, "attachments.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../packages/dashboard/src/console/composer-attachments.tsx", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { readComposerFile } = await import(pathToFileURL(output).href);
    const file = await readComposerFile(new File(["const name = 'héllo';"], "sample.ts"));
    assert.equal(file.kind, "text");
    assert.equal(file.value, "sample.ts\nconst name = 'héllo';");
    assert.ok(file.id);
    await assert.rejects(readComposerFile(new File([new Uint8Array([0, 1, 2])], "fake.txt")), /binary/);
    await assert.rejects(readComposerFile(new File([new Uint8Array([0xff, 0xfe])], "invalid.txt")), /UTF-8/);
    await assert.rejects(readComposerFile(new File(["x".repeat(64_001)], "large.md")), /64 KB/);
    await assert.rejects(readComposerFile(new File(["data"], "report.pdf", { type: "application/pdf" })), /isn't supported/);
    await assert.rejects(readComposerFile(new File(["svg"], "image.avif", { type: "image/avif" })), /Use PNG/);
    await assert.rejects(readComposerFile(new File([new Uint8Array(25_000_001)], "large.png", { type: "image/png" })), /25 MB/);

    const originalBitmap = globalThis.createImageBitmap;
    const originalDocument = globalThis.document;
    let closed = false;
    const draws = [];
    const canvases = [];
    globalThis.createImageBitmap = async () => ({ width: 3200, height: 1600, close: () => { closed = true; } });
    globalThis.document = { createElement: tag => {
      assert.equal(tag, "canvas");
      const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }), toDataURL: (type, quality) => { assert.equal(type, "image/jpeg"); return quality > 0.65 ? `data:image/jpeg;base64,${"A".repeat(210_000)}` : "data:image/jpeg;base64,aW1hZ2U="; } };
      canvases.push(canvas); return canvas;
    } };
    try {
      const image = await readComposerFile(new File(["raster"], "screen.png", { type: "image/png" }));
      assert.equal(image.kind, "image");
      assert.ok(image.value.length <= 200_000);
      assert.equal(canvases[0].width, 1600);
      assert.equal(canvases[0].height, 800);
      assert.equal(draws.length, 1);
      assert.ok(closed, "decoded bitmap is released after compression");
    } finally { globalThis.createImageBitmap = originalBitmap; globalThis.document = originalDocument; }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
