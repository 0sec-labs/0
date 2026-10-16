import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(corrupt = false) {
  const root = mkdtempSync(join(tmpdir(), "0-install-test-"));
  const tools = join(root, "tools");
  const home = join(root, "home with ' quote");
  mkdirSync(tools); mkdirSync(home);
  const binary = '#!/bin/sh\nprintf "installed\\n"\n';
  writeFileSync(join(root, "0-linux-arm64"), binary);
  writeFileSync(join(root, "checksums.txt"), `${corrupt ? "0".repeat(64) : createHash("sha256").update(binary).digest("hex")}  0-linux-arm64\n`);
  writeFileSync(join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo aarch64;; esac\n', { mode: 0o755 });
  writeFileSync(join(tools, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; dest="$1" ;;
    https:*) asset="\${1##*/}" ;;
  esac
  shift
done
cp "$FIXTURE/$asset" "$dest"
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, SHELL: "/bin/bash", PATH: `${tools}:${process.env.PATH}`, FIXTURE: root, INSTALL_FOXGUARD: "0" };
  delete env.INSTALL_DIR;
  return { root, home, env };
}
test("installer makes fresh shells usable, quotes paths, and does not duplicate profile entries", () => {
  const { root, home, env } = fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const installed = spawnSync("bash", ["install.sh"], { env, encoding: "utf8" });
      assert.equal(installed.status, 0, installed.stderr);
    }
    for (const profile of [".profile", ".bashrc"]) {
      const text = readFileSync(join(home, profile), "utf8");
      assert.equal(text.match(/# 0.security CLI/g).length, 1);
      const shell = spawnSync("bash", ["-c", `. "$HOME/${profile}"; 0 --help`], { env, encoding: "utf8" });
      assert.equal(shell.status, 0, shell.stderr);
      assert.equal(shell.stdout.trim(), "installed");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("checksum failure does not install a binary or modify shell startup", () => {
  const { root, home, env } = fixture(true);
  try {
    const installed = spawnSync("bash", ["install.sh"], { env, encoding: "utf8" });
    assert.notEqual(installed.status, 0);
    assert.match(installed.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(home, ".0", "bin", "0")), false);
    assert.equal(existsSync(join(home, ".profile")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
