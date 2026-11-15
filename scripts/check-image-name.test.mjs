import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkImageName } from "./check-image-name.mjs";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "image-name-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test("new name passes", () => {
  assert.deepEqual(checkImageName(repo({ ".github/workflows/a.yml": "image: ghcr.io/0sec-labs/0security:latest\nk: ghcr.io/0sec-labs/0verse\n" })), []);
});
test("old name is rejected in workflows, scripts and templated form", () => {
  assert.equal(checkImageName(repo({ ".github/workflows/a.yml": "x: ghcr.io/0sec-labs/0:latest\n", "scripts/a.sh": 'echo "ghcr.io/${OWNER}/0"\n' })).length, 2);
});
test("old name allowed only in the Docker migration section and changelog", () => {
  const doc = "## A\nghcr.io/0sec-labs/0:latest\n## Moving from the old image name\nghcr.io/0sec-labs/0:latest\n";
  const e = checkImageName(repo({ "docs/src/content/docs/docker.md": doc, "docs/CHANGELOG.md": "ghcr.io/0sec-labs/0\n" }));
  assert.equal(e.length, 1);
  assert.match(e[0], /docker\.md:2/);
});
test("this repository passes", () => {
  assert.deepEqual(checkImageName(join(import.meta.dirname, "..")), []);
});
