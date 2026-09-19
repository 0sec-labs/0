#!/usr/bin/env python3
"""Inspect an experimental native .tar.gz without extracting or executing it.

Digests establish integrity against supplied expectations, not publisher identity.
Reads and total compressed/decompressed sizes are bounded, including gzip padding.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
import zlib

CHUNK = 64 * 1024
MAX_BINARY = 1024 * 1024 * 1024
MAX_ARCHIVE = MAX_BINARY + 1024 * 1024
MAX_METADATA = 64 * 1024
MAX_EXPANDED = MAX_BINARY + 2 * MAX_METADATA + 1024 * 1024
INVENTORY = {"bin/0sec-native": 0o755, "manifest.json": 0o644, "README.txt": 0o644}


class InvalidPackage(ValueError):
    pass


class HashedReader:
    def __init__(self, raw):
        self.raw, self.size, self.digest = raw, 0, hashlib.sha256()

    def read(self, size=-1):
        if size < 0:
            raise InvalidPackage("unbounded compressed read")
        data = self.raw.read(min(size, CHUNK, MAX_ARCHIVE - self.size + 1))
        self.size += len(data)
        if self.size > MAX_ARCHIVE:
            raise InvalidPackage("compressed archive exceeds size limit")
        self.digest.update(data)
        return data


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidPackage("duplicate manifest key")
        result[key] = value
    return result


def valid_hex(value, lengths):
    return isinstance(value, str) and len(value) in lengths and re.fullmatch(r"[0-9a-f]+", value) is not None


def verify(path, expected_sha256=None, expected_source_commit=None, expected_manifest_sha256=None):
    for value, lengths in ((expected_sha256, (64,)), (expected_manifest_sha256, (64,)),
                           (expected_source_commit, (40, 64))):
        if value is not None and not valid_hex(value, lengths):
            raise InvalidPackage("expected digests/commit must be full lowercase hexadecimal identifiers")
    hashes, sizes, manifest_bytes = {}, {}, None
    with Path(path).open("rb") as raw:
        source = HashedReader(raw)
        with gzip.GzipFile(fileobj=source, mode="rb") as stream:
            expanded = 0

            def read(size):
                nonlocal expanded
                data = stream.read(min(size, CHUNK, MAX_EXPANDED - expanded + 1))
                expanded += len(data)
                if expanded > MAX_EXPANDED:
                    raise InvalidPackage("expanded archive exceeds size limit")
                return data

            def exact(size):
                chunks = []
                while size:
                    data = read(size)
                    if not data:
                        raise InvalidPackage("truncated tar archive")
                    chunks.append(data)
                    size -= len(data)
                return b"".join(chunks)

            while True:
                header = exact(512)
                if header == bytes(512):
                    if exact(512) != bytes(512):
                        raise InvalidPackage("invalid tar end marker")
                    while True:
                        tail = read(CHUNK)
                        if not tail:
                            break
                        if any(tail):
                            raise InvalidPackage("nonzero data after tar end marker")
                    break
                entry = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
                if entry.name not in INVENTORY or entry.name in hashes:
                    raise InvalidPackage("unexpected or duplicate archive entry")
                if entry.type != tarfile.REGTYPE or entry.linkname:
                    raise InvalidPackage("only regular files are allowed")
                if entry.mode != INVENTORY[entry.name]:
                    raise InvalidPackage("incorrect archive file mode")
                limit = MAX_BINARY if entry.name == "bin/0sec-native" else MAX_METADATA
                if not 0 < entry.size <= limit:
                    raise InvalidPackage("entry exceeds size limit or is empty")
                digest, remaining, contents = hashlib.sha256(), entry.size, []
                while remaining:
                    chunk = exact(min(remaining, CHUNK))
                    digest.update(chunk)
                    if entry.name == "manifest.json":
                        contents.append(chunk)
                    remaining -= len(chunk)
                if any(exact((-entry.size) % 512)):
                    raise InvalidPackage("nonzero tar entry padding")
                hashes[entry.name], sizes[entry.name] = digest.hexdigest(), entry.size
                if entry.name == "manifest.json":
                    manifest_bytes = b"".join(contents)
        archive_digest = source.digest.hexdigest()
    if set(hashes) != set(INVENTORY):
        raise InvalidPackage("missing required archive entry")
    manifest = json.loads(manifest_bytes.decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(manifest, dict):
        raise InvalidPackage("manifest must be an object")
    if type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1:
        raise InvalidPackage("unsupported manifest schema")
    for key, value in (("product", "0sec-native"), ("channel", "experimental"), ("binary", "bin/0sec-native")):
        if manifest.get(key) != value:
            raise InvalidPackage("invalid manifest " + key)
    for key in ("source_commit", "rust_tree", "cargo_lock_sha256", "binary_sha256"):
        if not valid_hex(manifest.get(key), (40, 64) if key in ("source_commit", "rust_tree") else (64,)):
            raise InvalidPackage("invalid manifest " + key)
    if len(manifest["rust_tree"]) != len(manifest["source_commit"]):
        raise InvalidPackage("inconsistent Git object identifier lengths")
    if manifest.get("profile") not in ("dev", "release"):
        raise InvalidPackage("invalid build profile")
    for key in ("target", "rustc", "version"):
        if not isinstance(manifest.get(key), str) or not manifest[key]:
            raise InvalidPackage("missing manifest " + key)
    if "linux" not in manifest["target"].split("-"):
        raise InvalidPackage("unsupported target")
    if manifest.get("qualification") != ["host --version", "host --help"]:
        raise InvalidPackage("invalid qualification record")
    if manifest["binary_sha256"] != hashes["bin/0sec-native"]:
        raise InvalidPackage("binary SHA256 mismatch")
    for expected, actual, label in (
        (expected_sha256, archive_digest, "archive SHA256"),
        (expected_source_commit, manifest["source_commit"], "source commit"),
        (expected_manifest_sha256, hashes["manifest.json"], "manifest SHA256"),
    ):
        if expected is not None and expected != actual:
            raise InvalidPackage(label + " mismatch")
    return {"archive_sha256": archive_digest, "manifest_sha256": hashes["manifest.json"],
            "binary_sha256": hashes["bin/0sec-native"], "source_commit": manifest["source_commit"],
            "sizes": sizes, "manifest": manifest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--expected-sha256", help="Expected SHA256 of compressed archive")
    parser.add_argument("--expected-source-commit", help="Expected full Git source commit")
    parser.add_argument("--expected-manifest-sha256", help="Expected SHA256 of manifest bytes")
    args = parser.parse_args()
    try:
        result = verify(args.archive, args.expected_sha256, args.expected_source_commit, args.expected_manifest_sha256)
    except (OSError, ValueError, EOFError, RecursionError, tarfile.TarError, zlib.error) as error:
        print(f"Native package verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
