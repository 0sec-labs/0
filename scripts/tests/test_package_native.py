"""Packaging boundary tests with fake local tools; these do not qualify Rust builds."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

PACKAGE_SCRIPT = Path(os.environ.get("NATIVE_PACKAGE_SCRIPT", Path(__file__).parents[1] / "package-native.py"))


@unittest.skipUnless(platform.system() == "Linux", "packaging is currently Linux-only")
class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-package-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        (self.repo / "rust/src").mkdir(parents=True)
        shutil.copyfile(PACKAGE_SCRIPT, self.repo / "scripts/package-native.py")
        (self.repo / "rust/Cargo.toml").write_text('[workspace]\nmembers = []\n')
        (self.repo / "rust/Cargo.lock").write_text('# committed lock\nversion = 4\n')
        (self.repo / "rust/src/main.rs").write_text('// committed source\n')
        (self.repo / "rust/build-helper").write_text('#!/bin/sh\nexit 0\n')
        (self.repo / "rust/build-helper").chmod(0o755)
        self.tools = self.base / "tools"
        self.tools.mkdir()
        self.output = self.base / "result.tar.gz"
        self.record = self.base / "build-record.json"
        self.env = os.environ.copy()
        for key in list(self.env):
            if key.startswith("GIT_"):
                self.env.pop(key)
        self.env.update(PATH=str(self.tools) + os.pathsep + os.environ["PATH"],
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                        GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid",
                        TEST_BUILD_RECORD=str(self.record), TEST_OUTPUT=str(self.output),
                        TEST_PINNED_RUSTC=str(self.tools / "real-rustc"))
        self.tool("rustc", 'print("rustc 1.85.0\\nhost: x86_64-unknown-linux-gnu")\n')
        self.tool("rustup", 'import os\nprint(os.environ["TEST_PINNED_RUSTC"])\n')
        self.tool("real-rustc", 'raise SystemExit("fake compiler should not execute")\n')
        self.tool("cargo", r'''
import json, os, pathlib, sys
root = pathlib.Path.cwd()
keys = ("RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET", "CARGO_TARGET_DIR")
record = {"argv": sys.argv[1:], "env": {k: os.environ.get(k) for k in keys},
          "untracked_exists": (root / "rust/untracked").exists(),
          "source": (root / "rust/src/main.rs").read_text(),
          "lock": (root / "rust/Cargo.lock").read_text(),
          "mode": (root / "rust/src/main.rs").stat().st_mode & 0o777,
          "helper_mode": (root / "rust/build-helper").stat().st_mode & 0o777}
pathlib.Path(os.environ["TEST_BUILD_RECORD"]).write_text(json.dumps(record))
if os.environ.get("TEST_PUBLICATION_RACE"):
    pathlib.Path(os.environ["TEST_OUTPUT"]).write_bytes(b"preserve this racing destination")
profile = sys.argv[sys.argv.index("--profile") + 1]
target = sys.argv[sys.argv.index("--target") + 1]
binary = pathlib.Path(os.environ["CARGO_TARGET_DIR"]) / target / ("debug" if profile == "dev" else "release") / "0sec-native"
binary.parent.mkdir(parents=True)
binary.write_text("#!/bin/sh\nprintf '0sec-native fake fixture\\n'\n")
binary.chmod(0o755)
''')
        self.git("init", "-q")
        self.commit()

    def tool(self, name, code):
        path = self.tools / name
        path.write_text("#!" + sys.executable + "\n" + code)
        path.chmod(0o755)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True,
                              text=True, capture_output=True).stdout.strip()

    def commit(self):
        self.git("add", "--all")
        self.git("commit", "-qm", "fixture")
        self.commit_id = self.git("rev-parse", "HEAD")

    def package(self, *args):
        return subprocess.run([sys.executable, str(self.repo / "scripts/package-native.py"),
                               "--output", str(self.output), *args], cwd=self.base, env=self.env,
                              text=True, capture_output=True, timeout=30)

    def assert_failure_before_build(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.record.exists())

    def test_committed_source_and_modes_are_frozen_despite_dirty_files(self):
        (self.repo / "rust/src/main.rs").write_text('// dirty source must not ship\n')
        (self.repo / "rust/Cargo.lock").write_text('# dirty lock must not ship\n')
        (self.repo / "rust/untracked").write_text('untracked build input')
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(self.record.read_text())
        self.assertFalse(record["untracked_exists"])
        self.assertEqual(record["source"], '// committed source\n')
        self.assertEqual(record["lock"], '# committed lock\nversion = 4\n')
        self.assertEqual(record["mode"], 0o644)
        self.assertEqual(record["helper_mode"], 0o755)
        report = json.loads(result.stdout)
        self.assertEqual(report["manifest"]["source_commit"], self.commit_id)
        self.assertEqual(report["manifest"]["rust_tree"], self.git("rev-parse", "HEAD:rust"))
        self.assertEqual(report["manifest"]["cargo_lock_sha256"], hashlib.sha256(record["lock"].encode()).hexdigest())
        self.assertEqual(report["sha256"], hashlib.sha256(self.output.read_bytes()).hexdigest())
        with tarfile.open(self.output) as archive:
            self.assertEqual(archive.getnames(), ["bin/0sec-native", "manifest.json", "README.txt"])
            self.assertEqual(json.load(archive.extractfile("manifest.json")), report["manifest"])

    def test_export_ignore_cannot_omit_committed_files(self):
        (self.repo / ".gitattributes").write_text('rust/src/main.rs export-ignore\n')
        self.commit()
        self.assert_failure_before_build(self.package(), "omitted committed Rust source")

    def test_export_subst_cannot_transform_committed_bytes(self):
        (self.repo / ".gitattributes").write_text('rust/src/main.rs export-subst\n')
        (self.repo / "rust/src/main.rs").write_text('// $Format:%H$\n')
        self.commit()
        self.assert_failure_before_build(self.package(), "changed committed source bytes or mode")

    def test_committed_symlink_is_rejected(self):
        (self.repo / "rust/link").symlink_to('/etc/passwd')
        self.commit()
        self.assert_failure_before_build(self.package(), "contains a link or submodule")

    def test_toolchain_wrappers_flags_and_target_are_controlled(self):
        self.env.update(RUSTC="unexpected-rustc", RUSTC_WRAPPER="unexpected-wrapper",
                        RUSTC_WORKSPACE_WRAPPER="unexpected-workspace-wrapper", RUSTFLAGS="--unexpected",
                        CARGO_ENCODED_RUSTFLAGS="--unexpected", CARGO_BUILD_TARGET="unexpected-target",
                        CARGO_TARGET_DIR=str(self.base / "unexpected-target-dir"))
        result = self.package("--profile", "dev")
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(self.record.read_text())
        self.assertEqual(record["env"]["RUSTC"], str(self.tools / "real-rustc"))
        for key in ("RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"):
            self.assertEqual(record["env"][key], "")
        self.assertIsNone(record["env"]["CARGO_BUILD_TARGET"])
        self.assertFalse((self.base / "unexpected-target-dir").exists())
        self.assertEqual(record["argv"], ["+1.85", "build", "--locked", "--manifest-path", "rust/Cargo.toml",
                                         "-p", "zero-cli", "--bin", "0sec-native", "--target",
                                         "x86_64-unknown-linux-gnu", "--profile", "dev"])

    def test_racing_destination_is_preserved_and_temporary_publication_removed(self):
        self.env["TEST_PUBLICATION_RACE"] = "1"
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("File exists", result.stderr)
        self.assertTrue(self.record.exists())
        self.assertEqual(self.output.read_bytes(), b"preserve this racing destination")
        self.assertEqual(list(self.base.glob('.0sec-native-package-*')), [])


if __name__ == "__main__":
    unittest.main()
