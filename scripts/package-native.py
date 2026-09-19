#!/usr/bin/env python3
"""Build an experimental native archive from a committed source tree; never publish."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile


def run(argv, cwd, **kwargs):
    return subprocess.run(argv, cwd=cwd, check=True, **kwargs)


def capture(argv, cwd):
    return run(argv, cwd, stdout=subprocess.PIPE).stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def add_bytes(archive, name, data, mode=0o644):
    entry = tarfile.TarInfo(name)
    entry.size, entry.mode, entry.mtime = len(data), mode, 0
    archive.addfile(entry, io.BytesIO(data))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD", help="Committed source revision (default HEAD)")
    parser.add_argument("--output", type=Path, required=True, help="New .tar.gz file; never overwrite")
    parser.add_argument("--profile", choices=("release", "dev"), default="release")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if platform.system() != "Linux":
        parser.error("native packaging is currently qualified only on Linux")
    output = args.output.absolute()
    if output.suffixes[-2:] != [".tar", ".gz"]:
        parser.error("--output must end in .tar.gz")
    if os.path.lexists(output):
        parser.error("output already exists")
    if not output.parent.is_dir():
        parser.error("output parent directory must already exist")
    revision = capture(["git", "rev-parse", "--verify", "--end-of-options", args.ref + "^{commit}"], root).decode().strip()
    tree = capture(["git", "rev-parse", revision + ":rust"], root).decode().strip()
    compiler = capture(["rustc", "+1.85", "-vV"], root).decode()
    host = next(line.removeprefix("host: ") for line in compiler.splitlines() if line.startswith("host: "))
    if "linux" not in host:
        parser.error("Rust host target must be Linux")
    # git archive freezes source before building, independent of concurrent worktrees.
    # Only regular tracked Rust files are accepted; no external symlink/build input.
    source = capture(["git", "archive", "--format=tar", revision, "rust"], root)
    expected = {}
    for row in capture(["git", "ls-tree", "-rz", revision, "--", "rust"], root).split(b"\0"):
        if row:
            metadata, name = row.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            if kind != "blob" or mode not in ("100644", "100755"):
                raise ValueError("committed Rust source contains a link or submodule")
            expected[os.fsdecode(name)] = (mode, oid)
    object_format = capture(["git", "rev-parse", "--show-object-format"], root).decode().strip()
    actual_compiler = capture(["rustup", "which", "--toolchain", "1.85", "rustc"], root).decode().strip()
    with tempfile.TemporaryDirectory(prefix="0sec-native-package-") as scratch:
        work = Path(scratch)
        with tarfile.open(fileobj=io.BytesIO(source), mode="r:") as archive:
            seen = set()
            for entry in archive:
                name = Path(entry.name)
                if name.is_absolute() or ".." in name.parts or name.parts[0] != "rust":
                    raise ValueError("invalid committed source archive path")
                destination = work / name
                if entry.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif entry.isfile():
                    if entry.name in seen or entry.name not in expected:
                        raise ValueError("source archive inventory differs from committed tree")
                    seen.add(entry.name)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(entry) as stream:
                        contents = stream.read()
                    blob = hashlib.new(object_format, b"blob " + str(len(contents)).encode() + b"\0" + contents).hexdigest()
                    mode, oid = expected[entry.name]
                    if blob != oid or bool(entry.mode & 0o111) != (mode == "100755"):
                        raise ValueError("archive attributes changed committed source bytes or mode")
                    destination.write_bytes(contents)
                    destination.chmod(int(mode, 8) & 0o777)
                else:
                    raise ValueError("committed Rust source contains a link or special file")
            if seen != set(expected):
                raise ValueError("archive attributes omitted committed Rust source")
        lock = (work / "rust/Cargo.lock").read_bytes()
        env = os.environ.copy()
        # An inherited target override must not redirect which executable we package.
        env.pop("CARGO_BUILD_TARGET", None)
        env["RUSTC"] = actual_compiler
        env["RUSTC_WRAPPER"] = ""
        env["RUSTC_WORKSPACE_WRAPPER"] = ""
        env["RUSTFLAGS"] = ""
        env["CARGO_ENCODED_RUSTFLAGS"] = ""
        env["CARGO_TARGET_DIR"] = str(work / "target")
        run(["cargo", "+1.85", "build", "--locked", "--manifest-path", "rust/Cargo.toml",
             "-p", "zero-cli", "--bin", "0sec-native", "--target", host, "--profile", args.profile], work, env=env)
        binary = work / "target" / host / ("debug" if args.profile == "dev" else "release") / "0sec-native"
        version = capture([str(binary), "--version"], work).decode().strip()
        run([str(binary), "--help"], work, stdout=subprocess.DEVNULL)
        data = binary.read_bytes()
        manifest = {
            "schema_version": 1, "product": "0sec-native", "channel": "experimental",
            "source_commit": revision, "rust_tree": tree, "cargo_lock_sha256": digest(lock),
            "target": host, "profile": args.profile, "rustc": compiler,
            "binary": "bin/0sec-native", "binary_sha256": digest(data), "version": version,
            "qualification": ["host --version", "host --help"],
        }
        # Same-filesystem hard-link publication is atomic and refuses existing files,
        # including a destination created while the build was running.
        fd, temporary = tempfile.mkstemp(prefix=".0sec-native-package-", dir=output.parent)
        try:
            with os.fdopen(fd, "wb") as raw:
                with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
                    with tarfile.open(fileobj=compressed, mode="w|") as archive:
                        add_bytes(archive, "bin/0sec-native", data, 0o755)
                        add_bytes(archive, "manifest.json", (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())
                        add_bytes(archive, "README.txt", b"Experimental 0sec-native Linux build.\nRun bin/0sec-native explicitly; production 0sec/0 routing is unchanged.\nThe manifest records provenance and startup checks, not full workflow or platform qualification.\nNo installer, state migration, container image or credentials are included.\n")
                raw.flush()
                os.fsync(raw.fileno())
            os.chmod(temporary, 0o644)
            archive_sha = digest(Path(temporary).read_bytes())
            os.link(temporary, output)
            directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            print(json.dumps({"archive": str(output), "sha256": archive_sha, "manifest": manifest}, sort_keys=True))
        finally:
            os.unlink(temporary)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f"Native packaging failed: {error}", file=sys.stderr)
        sys.exit(1)
