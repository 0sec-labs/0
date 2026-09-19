import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("verifier", Path(__file__).parents[1] / "verify-native-package.py")
v = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "package.tar.gz"
        self.binary = b"This is deliberately not an executable.\n"
        self.manifest = dict(schema_version=1, product="0sec-native", channel="experimental",
                             source_commit="a" * 40, rust_tree="b" * 40, cargo_lock_sha256="c" * 64,
                             target="x86_64-unknown-linux-gnu", profile="release", rustc="rustc 1.85",
                             binary="bin/0sec-native", binary_sha256=hashlib.sha256(self.binary).hexdigest(),
                             version="0sec-native test", qualification=["host --version", "host --help"])

    def entries(self):
        return [("bin/0sec-native", self.binary, 0o755, tarfile.REGTYPE),
                ("manifest.json", json.dumps(self.manifest).encode(), 0o644, tarfile.REGTYPE),
                ("README.txt", b"Experimental build", 0o644, tarfile.REGTYPE)]

    def package(self, entries=None, suffix=b""):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, data, mode, kind in self.entries() if entries is None else entries:
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.type = len(data), mode, kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    info.linkname = "/tmp/never-follow-this"
                archive.addfile(info, io.BytesIO(data))
        self.path.write_bytes(gzip.compress(buf.getvalue() + suffix, mtime=0))

    def reject(self):
        with self.assertRaises((ValueError, OSError, EOFError, tarfile.TarError)):
            v.verify(self.path)

    def test_valid_archive_and_all_expected_values_without_extraction_or_execution(self):
        self.package()
        with patch.object(tarfile.TarFile, "extract", side_effect=AssertionError), \
             patch.object(tarfile.TarFile, "extractall", side_effect=AssertionError):
            result = v.verify(self.path)
            self.assertEqual(result["binary_sha256"], self.manifest["binary_sha256"])
            self.assertEqual(v.verify(self.path, hashlib.sha256(self.path.read_bytes()).hexdigest(),
                                      "a" * 40, result["manifest_sha256"]), result)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [self.path])

    def test_expected_mismatches_and_invalid_expectations(self):
        self.package()
        for kwargs in ({"expected_sha256": "0" * 64}, {"expected_manifest_sha256": "0" * 64},
                       {"expected_source_commit": "0" * 40}, {"expected_source_commit": "HEAD"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(v.InvalidPackage):
                v.verify(self.path, **kwargs)

    def test_tampered_binary(self):
        entries = self.entries()
        entries[0] = (entries[0][0], b"tampered", *entries[0][2:])
        self.package(entries)
        self.reject()

    def test_duplicate_unexpected_paths_and_missing(self):
        for name in ("bin/0sec-native", "extra", "../evil", "/tmp/evil", "bin/../0sec-native"):
            with self.subTest(name=name):
                self.package(self.entries() + [(name, b"x", 0o644, tarfile.REGTYPE)])
                self.reject()
        self.package(self.entries()[:-1])
        self.reject()

    def test_links_special_entries_and_modes(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE,
                     tarfile.CHRTYPE, tarfile.XHDTYPE, tarfile.GNUTYPE_SPARSE):
            with self.subTest(kind=kind):
                entries = self.entries()
                entries[0] = (entries[0][0], b"", 0o755, kind)
                self.package(entries)
                self.reject()
        for mode in (0o644, 0o4755, 0o777):
            with self.subTest(mode=mode):
                entries = self.entries()
                entries[0] = (entries[0][0], entries[0][1], mode, tarfile.REGTYPE)
                self.package(entries)
                self.reject()

    def test_size_limits(self):
        self.package()
        for constant in ("MAX_ARCHIVE", "MAX_BINARY", "MAX_METADATA", "MAX_EXPANDED"):
            with self.subTest(constant=constant), patch.object(v, constant, 16):
                self.reject()
        self.package(suffix=bytes(8192))
        with patch.object(v, "MAX_EXPANDED", 12000):
            self.reject()

    def test_truncation_checksum_trailer_and_hidden_archive(self):
        self.package()
        valid = self.path.read_bytes()
        for length in (0, 1, 10, len(valid) - 1, len(valid) - 8):
            with self.subTest(length=length):
                self.path.write_bytes(valid[:length])
                self.reject()
        raw = gzip.decompress(valid)
        self.path.write_bytes(gzip.compress(b"X" + raw[1:]))
        self.reject()
        self.path.write_bytes(gzip.compress(raw[:512]))
        self.reject()
        self.path.write_bytes(valid + gzip.compress(raw))
        self.reject()
        self.path.write_bytes(valid[:-8] + bytes(8))
        self.reject()

    def test_invalid_manifest_and_duplicate_keys(self):
        for key, value in (("schema_version", True), ("binary_sha256", "invalid"),
                           ("source_commit", "HEAD"), ("target", "x86_64-apple-darwin"),
                           ("qualification", []), ("profile", "debug")):
            with self.subTest(key=key), patch.dict(self.manifest, {key: value}):
                self.package()
                self.reject()
        entries = self.entries()
        entries[1] = ("manifest.json", b'{"schema_version":1,"schema_version":1}', 0o644, tarfile.REGTYPE)
        self.package(entries)
        self.reject()

    def test_every_compressed_read_is_bounded(self):
        class Observed(io.BytesIO):
            def read(self, size=-1):
                self.assert_size(size)
                return super().read(size)
        raw = Observed(b"abc")
        raw.assert_size = lambda n: self.assertTrue(0 <= n <= v.CHUNK)
        reader = v.HashedReader(raw)
        self.assertEqual(reader.read(10000000), b"abc")
        with self.assertRaises(v.InvalidPackage):
            reader.read()


if __name__ == "__main__":
    unittest.main()
