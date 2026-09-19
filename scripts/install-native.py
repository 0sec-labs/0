#!/usr/bin/env python3
"""Install verified experimental native archives into an explicit dedicated Linux prefix.

No archive content is executed. Production 0sec/0 commands are never touched.
Deactivate/uninstall retains versions/history and a dangling owned native symlink.
"""
import argparse
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tarfile

SPEC = importlib.util.spec_from_file_location("native_package_verifier", Path(__file__).with_name("verify-native-package.py"))
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)
OWNER = {"schema_version": 1, "product": "0sec-native", "layout": "dedicated-prefix-v1"}
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class InstallError(ValueError):
    pass


def check_fd(fd, mode, directory=False):
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != mode:
        raise InstallError("owned path has unexpected owner or mode")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise InstallError("expected owned directory")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise InstallError("expected owned regular file with one link")


def child_dir(parent, name, mode=0o700):
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        check_fd(fd, mode, directory=True)
    except BaseException:
        os.close(fd)
        raise
    return fd


def read_owned(parent, name, mode=0o444, limit=65536):
    fd = os.open(name, FILE, dir_fd=parent)
    try:
        check_fd(fd, mode)
        data = bytearray()
        while len(data) <= limit:
            part = os.read(fd, min(verifier.CHUNK, limit + 1 - len(data)))
            if not part:
                return bytes(data)
            data.extend(part)
        raise InstallError("owned metadata exceeds size limit")
    finally:
        os.close(fd)


def write_owned(parent, name, data, mode=0o444):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        write_all(fd, data)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written == 0:
            raise InstallError("short file write")
        view = view[written:]


def read_json(parent, name):
    return json.loads(read_owned(parent, name).decode("utf-8"), object_pairs_hook=verifier.unique_object)


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def symlink_value(parent, name):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise InstallError("activation path is not an owned symlink")
    return os.readlink(name, dir_fd=parent)


def rename_new(parent, source, destination):
    # Linux atomic no-replace directory publication; never fall back to overwriting.
    libc = ctypes.CDLL(None, use_errno=True)
    operation = getattr(libc, "renameat2", None)
    if operation is None:
        raise InstallError("Linux renameat2 is required")
    operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    operation.restype = ctypes.c_int
    if operation(parent, os.fsencode(source), parent, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), destination)
    os.fsync(parent)


def open_prefix(path, create=True):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts or len(path.parts) < 2:
        raise InstallError("--prefix must be an absolute dedicated directory without '..'")
    fd = os.open("/", DIRECTORY)
    try:
        for index, name in enumerate(path.parts[1:]):
            if create and index == len(path.parts) - 2:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            new = os.open(name, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = new
        check_fd(fd, 0o700, directory=True)
        return fd
    except BaseException:
        os.close(fd)
        raise


class Prefix:
    def __init__(self, path, initialize=True):
        self.allow_initialize = initialize
        self.fd = open_prefix(path, create=initialize)
        self.lock = None
        self.directories = []

    def __enter__(self):
        try:
            names = set(os.listdir(self.fd))
            if "owner.json" not in names and (not self.allow_initialize or
                    (names and ".lock" not in names) or not names <= {".lock", "versions", "activations", "bin"}):
                raise InstallError("prefix is not empty or owned by this installer")
            try:
                self.lock = os.open(".lock", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
            except FileNotFoundError:
                if "owner.json" in names:
                    raise InstallError("owned installation lock is missing")
                try:
                    self.lock = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                        0o600, dir_fd=self.fd)
                except FileExistsError:
                    self.lock = os.open(".lock", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
            check_fd(self.lock, 0o600)
            fcntl.flock(self.lock, fcntl.LOCK_EX)
            names = set(os.listdir(self.fd))
            initialize = "owner.json" not in names
            if initialize and not names <= {".lock", "versions", "activations", "bin"}:
                raise InstallError("unrecognized files in unowned prefix")
            if not initialize:
                owner = read_json(self.fd, "owner.json")
                if owner != OWNER or type(owner.get("schema_version")) is not int:
                    raise InstallError("unrecognized prefix ownership record")
            for name in ("versions", "activations", "bin"):
                if initialize:
                    try:
                        os.mkdir(name, 0o700, dir_fd=self.fd)
                    except FileExistsError:
                        pass
                fd = child_dir(self.fd, name)
                self.directories.append(fd)
                if initialize and os.listdir(fd):
                    raise InstallError("unowned prefix directories must be empty")
            self.versions, self.activations, self.bin = self.directories
            if initialize:
                write_owned(self.fd, "owner.json", json_bytes(OWNER))
                os.fsync(self.fd)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *unused):
        for fd in self.directories:
            os.close(fd)
        if self.lock is not None:
            os.close(self.lock)
        os.close(self.fd)

    def state(self):
        target = symlink_value(self.bin, "0sec-native")
        if target is None:
            # Never silently reset a deleted activation once records exist.
            if any(re.fullmatch(r"[0-9a-f]{32}", name) for name in os.listdir(self.activations)):
                raise InstallError("native activation is missing; use recover with an expected cached archive digest")
            return target, {"schema_version": 1, "active": None, "previous": None}
        match = re.fullmatch(r"\.\./activations/([0-9a-f]{32})/0sec-native", target)
        if match is None:
            raise InstallError("native activation points outside owned activation history")
        fd = child_dir(self.activations, match[1], 0o500)
        try:
            state = read_json(fd, "state.json")
            if not isinstance(state, dict) or set(state) != {"schema_version", "active", "previous"}:
                raise InstallError("invalid activation state")
            if type(state["schema_version"]) is not int or state["schema_version"] != 1:
                raise InstallError("invalid activation schema")
            for key in ("active", "previous"):
                if state[key] is not None and not verifier.valid_hex(state[key], (64,)):
                    raise InstallError("invalid activation digest")
            expected = None if state["active"] is None else "../../versions/" + state["active"] + "/bin/0sec-native"
            if symlink_value(fd, "0sec-native") != expected:
                raise InstallError("activation executable differs from its state")
            if set(os.listdir(fd)) != ({"state.json"} if expected is None else {"state.json", "0sec-native"}):
                raise InstallError("unexpected activation record contents")
            return target, state
        finally:
            os.close(fd)

    def activate(self, old_target, active, previous):
        token = secrets.token_hex(16)
        staging = ".staging-" + token
        os.mkdir(staging, 0o700, dir_fd=self.activations)
        fd = child_dir(self.activations, staging)
        try:
            write_owned(fd, "state.json", json_bytes({"schema_version": 1, "active": active, "previous": previous}))
            if active is not None:
                os.symlink("../../versions/" + active + "/bin/0sec-native", "0sec-native", dir_fd=fd)
            os.fchmod(fd, 0o500)
            os.fsync(fd)
        finally:
            os.close(fd)
        rename_new(self.activations, staging, token)
        temporary = ".activation-" + token
        os.symlink("../activations/" + token + "/0sec-native", temporary, dir_fd=self.bin)
        try:
            if symlink_value(self.bin, "0sec-native") != old_target:
                raise InstallError("native activation changed while preparing publication")
            if old_target is None:
                rename_new(self.bin, temporary, "0sec-native")
            else:
                os.replace(temporary, "0sec-native", src_dir_fd=self.bin, dst_dir_fd=self.bin)
                os.fsync(self.bin)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.bin)
            except FileNotFoundError:
                pass


def provenance(report):
    return {"schema_version": 1, **{key: report[key] for key in
            ("archive_sha256", "manifest_sha256", "binary_sha256", "source_commit")}}


def payload(archive_fd, version_fd, create):
    if create:
        os.mkdir("bin", 0o700, dir_fd=version_fd)
    binary_dir = child_dir(version_fd, "bin", 0o700 if create else 0o500)
    try:
        os.lseek(archive_fd, 0, os.SEEK_SET)
        with os.fdopen(os.dup(archive_fd), "rb") as raw, tarfile.open(fileobj=raw, mode="r|gz") as archive:
            for entry in archive:
                if entry.name not in verifier.INVENTORY:
                    raise InstallError("archive changed after verification")
                parent, name = (binary_dir, "0sec-native") if entry.name == "bin/0sec-native" else (version_fd, entry.name)
                mode = 0o555 if entry.name == "bin/0sec-native" else 0o444
                expected = hashlib.sha256()
                source = archive.extractfile(entry)
                if create:
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
                else:
                    fd = os.open(name, FILE, dir_fd=parent)
                actual = hashlib.sha256()
                try:
                    if not create:
                        check_fd(fd, mode)
                        if os.fstat(fd).st_size != entry.size:
                            raise InstallError("installed file size differs from verified archive")
                    remaining = entry.size
                    while remaining:
                        data = source.read(min(remaining, verifier.CHUNK))
                        if not data:
                            raise InstallError("truncated verified payload")
                        expected.update(data)
                        if create:
                            write_all(fd, data)
                        else:
                            installed = os.read(fd, len(data))
                            actual.update(installed)
                            if len(installed) != len(data):
                                raise InstallError("installed file changed during verification")
                        remaining -= len(data)
                    if create:
                        os.fchmod(fd, mode)
                        os.fsync(fd)
                    elif expected.digest() != actual.digest():
                        raise InstallError("installed file differs from verified archive")
                finally:
                    source.close()
                    os.close(fd)
        if set(os.listdir(binary_dir)) != {"0sec-native"}:
            raise InstallError("unexpected installed binary directory contents")
        if create:
            os.fchmod(binary_dir, 0o500)
            os.fsync(binary_dir)
    finally:
        os.close(binary_dir)


def verify_version(prefix, digest):
    fd = child_dir(prefix.versions, digest, 0o500)
    archive_fd = None
    try:
        if set(os.listdir(fd)) != {"archive.tar.gz", "bin", "manifest.json", "README.txt", "provenance.json"}:
            raise InstallError("unexpected immutable version contents")
        archive_fd = os.open("archive.tar.gz", FILE, dir_fd=fd)
        check_fd(archive_fd, 0o444)
        report = verifier.verify(Path("/proc/self/fd") / str(archive_fd), expected_sha256=digest)
        if read_owned(fd, "provenance.json") != json_bytes(provenance(report)):
            raise InstallError("installed provenance differs from verified archive")
        payload(archive_fd, fd, create=False)
        return report
    finally:
        if archive_fd is not None:
            os.close(archive_fd)
        os.close(fd)


def stage_version(prefix, archive_path, expected_sha256, expected_commit):
    try:
        os.stat(expected_sha256, dir_fd=prefix.versions, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        report = verify_version(prefix, expected_sha256)
        if expected_commit is not None and report["source_commit"] != expected_commit:
            raise InstallError("source commit mismatch")
        return report
    stage = ".staging-" + secrets.token_hex(16)
    os.mkdir(stage, 0o700, dir_fd=prefix.versions)
    fd = child_dir(prefix.versions, stage)
    archive_fd = None
    try:
        source = os.open(archive_path, FILE)
        try:
            if not stat.S_ISREG(os.fstat(source).st_mode):
                raise InstallError("input archive must be a regular file")
            archive_fd = os.open("archive.tar.gz", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                 0o600, dir_fd=fd)
            total, digest = 0, hashlib.sha256()
            while True:
                data = os.read(source, verifier.CHUNK)
                if not data:
                    break
                total += len(data)
                if total > verifier.MAX_ARCHIVE:
                    raise InstallError("input archive exceeds size limit")
                digest.update(data)
                write_all(archive_fd, data)
            if digest.hexdigest() != expected_sha256:
                raise InstallError("archive SHA256 mismatch")
            os.fchmod(archive_fd, 0o444)
            os.fsync(archive_fd)
        finally:
            os.close(source)
        report = verifier.verify(Path("/proc/self/fd") / str(archive_fd), expected_sha256, expected_commit)
        payload(archive_fd, fd, create=True)
        write_owned(fd, "provenance.json", json_bytes(provenance(report)))
        os.fchmod(fd, 0o500)
        os.fsync(fd)
        try:
            rename_new(prefix.versions, stage, expected_sha256)
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
            verify_version(prefix, expected_sha256)
            # Keep the verified unreferenced stage instead of overwriting any version.
        return report
    finally:
        if archive_fd is not None:
            os.close(archive_fd)
        os.close(fd)


def run(args):
    if sys.platform != "linux":
        raise InstallError("native installation is currently qualified only on Linux")
    if args.command in ("install", "recover"):
        if not verifier.valid_hex(args.expected_sha256, (64,)):
            raise InstallError("--expected-sha256 must be a full lowercase SHA256 digest")
        if args.expected_source_commit is not None and not verifier.valid_hex(args.expected_source_commit, (40, 64)):
            raise InstallError("--expected-source-commit must be a full lowercase Git identifier")
    with Prefix(args.prefix, initialize=args.command == "install") as prefix:
        if args.command == "recover":
            old_target = symlink_value(prefix.bin, "0sec-native")
            if old_target is not None:
                raise InstallError("recover requires a missing native activation; existing paths are preserved")
            report = verify_version(prefix, args.expected_sha256)
            if args.expected_source_commit is not None and report["source_commit"] != args.expected_source_commit:
                raise InstallError("source commit mismatch")
            active, previous = args.expected_sha256, None
        else:
            old_target, state = prefix.state()
        if args.command == "install":
            if state["active"] is not None and state["active"] != args.expected_sha256:
                verify_version(prefix, state["active"])
            report = stage_version(prefix, args.archive, args.expected_sha256, args.expected_source_commit)
            active = report["archive_sha256"]
            previous = state["active"] if state["active"] != active else state["previous"]
            if previous is None and state["active"] is None:
                previous = state["previous"]
        elif args.command == "rollback":
            if state["previous"] is None:
                raise InstallError("no previous verified version is recorded")
            verify_version(prefix, state["previous"])
            active, previous = state["previous"], state["active"]
        elif args.command in ("deactivate", "uninstall"):
            active, previous = None, state["active"] or state["previous"]
        prefix.activate(old_target, active, previous)
    return {"prefix": str(args.prefix), "active": active, "previous": previous,
            "action": "deactivate" if args.command == "uninstall" else args.command,
            "versions_retained": True, "native_symlink_dangling": active is None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install", help="Verify and activate an archive without executing it")
    install.add_argument("archive", type=Path)
    install.add_argument("--prefix", type=Path, required=True, help="Dedicated absolute directory, owned by current UID, mode0700")
    install.add_argument("--expected-sha256", required=True)
    install.add_argument("--expected-source-commit")
    recover = commands.add_parser("recover", help="Restore a missing activation from a verified cached digest; reset rollback pointer")
    recover.add_argument("--prefix", type=Path, required=True)
    recover.add_argument("--expected-sha256", required=True)
    recover.add_argument("--expected-source-commit")
    for name in ("rollback", "deactivate", "uninstall"):
        command = commands.add_parser(name, help="Activate previous verified version" if name == "rollback" else
                                      "Deactivate only; retain versions/history and dangling native symlink")
        command.add_argument("--prefix", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = run(args)
    except (OSError, ValueError, EOFError, RecursionError, tarfile.TarError, verifier.zlib.error) as error:
        print(f"Native installation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
