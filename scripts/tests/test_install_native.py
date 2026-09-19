"""Local fake-package tests. No archive executable is ever invoked."""
import argparse
import fcntl
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "install-native.py"
SPEC = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


@unittest.skipUnless(sys.platform == "linux", "installer is Linux-only")
class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-install-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.prefix = self.base / "native-only"
        self.executed = self.base / "EXECUTED"
        self.first, self.first_sha = self.package("first")
        self.second, self.second_sha = self.package("second")
        self.third, self.third_sha = self.package("third")

    def tearDown(self):
        # Immutable retained test directories need write permission for fixture cleanup.
        for root, dirs, files in os.walk(self.base, followlinks=False):
            for name in dirs:
                path = Path(root) / name
                if not path.is_symlink():
                    path.chmod(0o700)

    def package(self, label):
        binary = f'#!/bin/sh\ntouch "{self.executed}"\n# {label}\n'.encode()
        manifest = dict(schema_version=1, product="0sec-native", channel="experimental",
                        source_commit="a" * 40, rust_tree="b" * 40, cargo_lock_sha256="c" * 64,
                        target="x86_64-unknown-linux-gnu", profile="release", rustc="fixture rustc",
                        binary="bin/0sec-native", binary_sha256=hashlib.sha256(binary).hexdigest(),
                        version=label, qualification=["host --version", "host --help"])
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, data, mode in (("bin/0sec-native", binary, 0o755),
                                     ("manifest.json", json.dumps(manifest).encode(), 0o644),
                                     ("README.txt", b"Fixture only", 0o644)):
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(data), mode
                archive.addfile(info, io.BytesIO(data))
        path = self.base / (label + ".tar.gz")
        path.write_bytes(gzip.compress(buf.getvalue(), mtime=0))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def command(self, action, *options, success=True):
        result = subprocess.run([sys.executable, str(SCRIPT), action, "--prefix", str(self.prefix), *map(str, options)],
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode == 0, success, result.stderr + result.stdout)
        self.assertFalse(self.executed.exists(), "installer executed archive content")
        return json.loads(result.stdout) if success else result

    def install(self, path=None, digest=None, **kwargs):
        return self.command("install", path or self.first, "--expected-sha256", digest or self.first_sha, **kwargs)

    def link(self):
        return self.prefix / "bin/0sec-native"

    def args(self, action="install", path=None, digest=None):
        return argparse.Namespace(command=action, prefix=self.prefix, archive=path or self.first,
                                  expected_sha256=digest or self.first_sha, expected_source_commit=None)

    def test_install_upgrade_rollback_deactivate_and_restore(self):
        production = self.base / "production"
        production.mkdir()
        (production / "0sec").write_text("untouched")
        (production / "0").symlink_to("0sec")
        result = self.install()
        self.assertEqual(result["active"], self.first_sha)
        self.assertIn(b"# first", self.link().read_bytes())
        self.assertEqual(self.link().stat().st_mode & 0o777, 0o555)
        result = self.install(self.second, self.second_sha)
        self.assertEqual(result["previous"], self.first_sha)
        self.assertIn(b"# second", self.link().read_bytes())
        result = self.command("rollback")
        self.assertEqual((result["active"], result["previous"]), (self.first_sha, self.second_sha))
        self.assertIn(b"# first", self.link().read_bytes())
        result = self.command("deactivate")
        self.assertTrue(result["native_symlink_dangling"])
        self.assertTrue(self.link().is_symlink())
        self.assertFalse(self.link().exists())
        self.assertEqual(len(list((self.prefix / "versions").iterdir())), 2)
        self.assertEqual(self.command("rollback")["active"], self.first_sha)
        self.assertEqual((production / "0sec").read_text(), "untouched")
        self.assertEqual(os.readlink(production / "0"), "0sec")
        self.assertEqual(self.command("uninstall")["action"], "deactivate")

    def test_expected_digest_required_and_mismatch_cannot_activate(self):
        self.command("install", self.first, success=False)
        self.assertFalse(self.prefix.exists())
        self.install(digest="0" * 64, success=False)
        self.assertFalse(self.link().exists())
        self.install()
        target = os.readlink(self.link())
        self.command("install", self.second, "--expected-sha256", self.second_sha,
                     "--expected-source-commit", "0" * 40, success=False)
        self.assertEqual(os.readlink(self.link()), target)

    def test_prefix_must_be_dedicated_private_and_not_symlinked(self):
        self.prefix.mkdir(mode=0o700)
        (self.prefix / "sentinel").write_text("preserve")
        self.install(success=False)
        self.assertEqual((self.prefix / "sentinel").read_text(), "preserve")
        (self.prefix / "sentinel").unlink()
        self.prefix.chmod(0o755)
        self.install(success=False)
        self.prefix.chmod(0o700)
        self.prefix.rmdir()
        elsewhere = self.base / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        self.prefix.symlink_to(elsewhere, target_is_directory=True)
        self.install(success=False)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_unknown_activation_regular_file_and_link_are_preserved(self):
        self.install()
        self.link().unlink()
        self.link().write_text("unknown existing file")
        self.install(self.second, self.second_sha, success=False)
        self.assertEqual(self.link().read_text(), "unknown existing file")
        self.link().unlink()
        self.link().symlink_to("/tmp/unknown-command")
        self.command("deactivate", success=False)
        self.assertEqual(os.readlink(self.link()), "/tmp/unknown-command")

    def test_unknown_version_directory_is_never_overwritten(self):
        self.install()
        unknown = self.prefix / "versions" / self.second_sha
        unknown.mkdir(mode=0o500)
        before = os.readlink(self.link())
        self.install(self.second, self.second_sha, success=False)
        self.assertEqual(list(unknown.iterdir()), [])
        self.assertEqual(os.readlink(self.link()), before)

    def test_rollback_revalidates_payload_archive_and_provenance(self):
        self.install()
        self.install(self.second, self.second_sha)
        before = os.readlink(self.link())
        version = self.prefix / "versions" / self.first_sha
        for relative in ("bin/0sec-native", "archive.tar.gz", "provenance.json", "README.txt"):
            with self.subTest(path=relative):
                path = version / relative
                content, mode = path.read_bytes(), path.stat().st_mode & 0o777
                path.chmod(0o600)
                path.write_bytes(b"X" + content[1:])
                path.chmod(mode)
                self.command("rollback", success=False)
                self.assertEqual(os.readlink(self.link()), before)
                path.chmod(0o600)
                path.write_bytes(content)
                path.chmod(mode)
        self.command("rollback")

    def test_replaced_metadata_symlink_hardlink_and_directory_fail_closed(self):
        self.install()
        owner = self.prefix / "owner.json"
        original = owner.read_bytes()
        owner.unlink()
        outside = self.base / "owner-copy.json"
        outside.write_bytes(original)
        outside.chmod(0o444)
        owner.symlink_to(outside)
        self.command("deactivate", success=False)
        owner.unlink()
        os.link(outside, owner)
        self.command("deactivate", success=False)
        owner.unlink()
        owner.write_bytes(original)
        owner.chmod(0o444)
        bin_path = self.prefix / "bin"
        moved = self.prefix / "original-bin"
        bin_path.rename(moved)
        bin_path.symlink_to(moved, target_is_directory=True)
        self.command("deactivate", success=False)
        self.assertTrue((moved / "0sec-native").is_symlink())

    def test_no_escalation_and_owner_check_is_enforced(self):
        self.install()
        with patch.object(installer.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaises(installer.InstallError):
                installer.run(self.args("deactivate"))

    def test_previous_version_symlink_is_not_followed(self):
        self.install()
        self.install(self.second, self.second_sha)
        old = self.prefix / "versions" / self.first_sha
        moved = self.prefix / "versions" / "retained-original"
        old.rename(moved)
        old.symlink_to(moved, target_is_directory=True)
        before = os.readlink(self.link())
        self.command("rollback", success=False)
        self.assertEqual(os.readlink(self.link()), before)

    def test_interrupted_upgrade_preserves_activation_and_retry_recovers(self):
        self.install()
        before = os.readlink(self.link())
        with patch.object(installer.os, "replace", side_effect=OSError("simulated interruption")):
            with self.assertRaises(OSError):
                installer.run(self.args(path=self.second, digest=self.second_sha))
        self.assertEqual(os.readlink(self.link()), before)
        self.assertTrue((self.prefix / "versions" / self.second_sha).exists())
        self.assertEqual(self.install(self.second, self.second_sha)["active"], self.second_sha)

    def test_external_activation_change_during_staging_is_not_overwritten(self):
        self.install()
        original = installer.stage_version
        def change_activation(*args):
            result = original(*args)
            self.link().unlink()
            self.link().symlink_to("unknown-racing-target")
            return result
        with patch.object(installer, "stage_version", side_effect=change_activation):
            with self.assertRaises(installer.InstallError):
                installer.run(self.args(path=self.second, digest=self.second_sha))
        self.assertEqual(os.readlink(self.link()), "unknown-racing-target")

    def test_lock_covers_preimage_observation_and_concurrent_installs(self):
        self.install()
        lock = os.open(self.prefix / ".lock", os.O_RDWR)
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = os.readlink(self.link())
        processes = []
        try:
            for archive, digest in ((self.second, self.second_sha), (self.third, self.third_sha)):
                processes.append(subprocess.Popen([sys.executable, str(SCRIPT), "install", str(archive),
                                  "--prefix", str(self.prefix), "--expected-sha256", digest],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
            time.sleep(0.15)
            self.assertTrue(all(process.poll() is None for process in processes))
            self.assertEqual(os.readlink(self.link()), before)
        finally:
            os.close(lock)
            results = [process.communicate(timeout=20) for process in processes]
        for process, (output, error) in zip(processes, results):
            self.assertEqual(process.returncode, 0, error + output)
        reports = [json.loads(output) for output, error in results]
        by_active = {report["active"]: report for report in reports}
        final = self.command("rollback")
        self.assertEqual({final["active"], final["previous"]}, {self.second_sha, self.third_sha})
        self.assertEqual(sum(report["previous"] == self.first_sha for report in by_active.values()), 1)
        self.assertFalse(self.executed.exists())

    def test_exact_reinstallation_reuses_verified_storage_and_checks_commit(self):
        self.install()
        versions_before = sorted((self.prefix / "versions").iterdir())
        result = self.install()
        self.assertEqual(result["active"], self.first_sha)
        self.assertEqual(sorted((self.prefix / "versions").iterdir()), versions_before)
        before = os.readlink(self.link())
        self.command("install", self.first, "--expected-sha256", self.first_sha,
                     "--expected-source-commit", "0" * 40, success=False)
        self.assertEqual(os.readlink(self.link()), before)
        self.assertEqual(sorted((self.prefix / "versions").iterdir()), versions_before)

    def test_first_activation_interruption_has_explicit_verified_recovery(self):
        original = installer.rename_new
        def interrupt_first_activation(parent, source, destination):
            if destination == "0sec-native":
                raise OSError("simulated first activation interruption")
            return original(parent, source, destination)
        with patch.object(installer, "rename_new", side_effect=interrupt_first_activation):
            with self.assertRaises(OSError):
                installer.run(self.args())
        self.assertFalse(self.link().is_symlink())
        result = self.install(success=False)
        self.assertIn("use recover", result.stderr)
        self.command("recover", "--expected-sha256", "0" * 64, success=False)
        self.command("recover", "--expected-sha256", self.first_sha,
                     "--expected-source-commit", "0" * 40, success=False)
        result = self.command("recover", "--expected-sha256", self.first_sha)
        self.assertEqual(result["active"], self.first_sha)
        self.assertIsNone(result["previous"])
        self.assertIn(b"# first", self.link().read_bytes())
        before = os.readlink(self.link())
        self.command("recover", "--expected-sha256", self.first_sha, success=False)
        self.assertEqual(os.readlink(self.link()), before)

    def test_rollback_on_absent_prefix_does_not_create_installation(self):
        self.command("rollback", success=False)
        self.assertFalse(self.prefix.exists())


if __name__ == "__main__":
    unittest.main()
