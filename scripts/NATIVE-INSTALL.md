# Experimental native installation

`install-native.py` accepts the Linux archives produced by `package-native.py` and
uses `verify-native-package.py` before installing any payload. It never executes
archive contents. The standard production installer and the `0sec`/`0` names are
outside this installer's scope.

Provide an absolute, dedicated prefix. Its parent must already exist. The prefix
must be absent or empty, owned by the current UID, and mode `0700`; an absent
prefix is created with that mode. Symlinked path components are rejected. There
is no default prefix, system installation path, privilege escalation, PATH edit,
or shell configuration change.

```sh
python3 scripts/install-native.py install /absolute/path/build.tar.gz \
  --prefix /absolute/path/native-preview \
  --expected-sha256 FULL_ARCHIVE_SHA256 \
  --expected-source-commit FULL_SOURCE_COMMIT

python3 scripts/install-native.py rollback --prefix /absolute/path/native-preview
python3 scripts/install-native.py deactivate --prefix /absolute/path/native-preview
```

The expected archive digest is mandatory; the expected commit is optional.
Digests provide integrity against the supplied expectations, not publisher
identity. After installation, the native entry is
`/absolute/path/native-preview/bin/0sec-native`. The installer does not run it.

Each immutable `versions/<archive-sha256>/` directory retains the archive,
verified binary, manifest, README and derived provenance. Directories are mode
`0500`, the binary `0555`, and other files `0444`. Reinstalling an existing digest
revalidates the cached archive, provenance and installed payload, including an
optional expected commit, then reuses that version without duplicating archive
storage. The supplied archive path is not reread in this cached case.

Immutable `activations/<id>/` records retain the active and previous digest.
`bin/0sec-native` points at an activation record, which in turn points at the
selected version. Updating this single symlink atomically commits both executable
selection and rollback state. Rollback verifies the previous stored archive and
installed payload again before selecting it, and makes the former active digest
the next rollback candidate.

`deactivate` and its `uninstall` alias **only deactivate**. They retain the
versions, provenance, activation history, ownership marker and lock. The owned
`bin/0sec-native` symlink remains dangling; no native executable is active.
Rollback can reactivate the recorded previous version.

A prefix-level lock serializes cooperating installer processes. Paths are accessed
through directory descriptors with no-follow and owner/mode/link checks. Unknown
activation files, altered provenance, replaced directories and corrupt payloads
are rejected rather than overwritten. These controls do not isolate an
installation from arbitrary concurrent modifications by the same operating-system
user, who owns the installation and can change its permissions.

An interrupted upgrade leaves the old activation intact or the new activation
fully selected. A retry reuses any completed verified version. Unreferenced
staging directories and activation records from failures are retained for
inspection, never automatically overwritten or removed. If the first activation
was interrupted after its record was published, or the native entry is missing,
restore a specific verified cached version explicitly:

```sh
python3 scripts/install-native.py recover --prefix /absolute/path/native-preview \
  --expected-sha256 FULL_CACHED_ARCHIVE_SHA256
```

Recovery requires a missing native entry, verifies the selected cached version,
and resets the previous-version pointer. Existing activation paths are preserved
and refused. All retained history and version directories remain available.

This implementation requires Linux, `/proc/self/fd`, `flock`, and
`renameat2(RENAME_NOREPLACE)`; unsupported no-replace publication fails without an
overwrite fallback. Archive limits come from the verifier: a 1 GiB binary, 64 KiB
per metadata entry, and bounded compressed/decompressed totals and read sizes.
