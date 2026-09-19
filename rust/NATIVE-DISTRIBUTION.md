# Experimental native Linux archives

The production `0sec` and `0` commands still use TypeScript. The local packaging
command builds `0sec-native` from an explicit committed revision; it does not
install, publish, deploy, migrate state, change aliases or enable cloud execution.

```sh
python3 scripts/package-native.py --ref HEAD --output /tmp/0sec-native.tar.gz
```

Run from a checkout with Rust 1.85, Git, Python 3 and the Linux native build
dependencies installed. The output parent must already exist. Release is the
default profile; `--profile dev` produces a distinctly identified development
archive. The command builds for the Rust toolchain's Linux host target, not a
cross-compilation target. Cargo uses `--locked`; unavailable dependencies may
still require Cargo's normal registry access.

The source comes from the named commit, including `rust/Cargo.lock`. Uncommitted
working files do not enter the build. The packager checks the exported inventory,
file contents and executable bits against Git's committed blobs, rejecting
attribute transformations, omissions, links and submodules. Compilation happens
in a temporary directory with its own target directory and the selected Rust
1.85 compiler; inherited compiler wrappers are disabled. Temporary build files
are removed when the command exits normally.

Each archive contains exactly:

- `bin/0sec-native`, executable on the build host;
- `manifest.json`, recording the source commit, Rust tree, lockfile hash,
  compiler version, target, profile, binary hash and startup check results;
- `README.txt`, identifying the experimental channel.

The packager runs `--version` and `--help` before publication. Those checks prove
startup on the build host, not workflow parity or compatibility with another
Linux distribution. The build is not hermetic: native linker/libraries, Cargo
configuration and other host build inputs are not fully captured by the
manifest. Stable archive metadata does not promise reproducible binary bytes.

The completed archive is published atomically without replacing an existing
path, including one created during compilation. The command prints its SHA-256
and manifest as JSON. A checksum obtained from the same untrusted archive is not
an authenticity guarantee; distribution requires a separately trusted checksum
or signature. No signing or production release is performed here.

Verify the artifact before extracting it:

```sh
python3 scripts/verify-native-package.py /tmp/0sec-native.tar.gz \
  --expected-sha256 TRUSTED_ARCHIVE_SHA256 \
  --expected-source-commit FULL_SOURCE_COMMIT
```

The verifier streams bounded reads without extracting or running archive content.
It rejects duplicate, missing or unexpected entries, links, incorrect modes,
invalid manifests, truncated data and binary hash mismatches. Optional expected
archive and manifest hashes bind it to separately supplied release expectations.
The binary limit is 1 GiB to accommodate development builds; metadata is limited
to 64 KiB per file. Verification alone does not make an untrusted binary safe to
execute or authenticate its publisher.

Release cutover still requires the command/workflow and platform gates in
`MIGRATION.md`, independent archive verification, installation/rollback testing,
legacy state compatibility and the existing production promotion authority.

## Recorded local qualification

On 2026-09-19, Rust 1.85 Linux builds of source commit
`9b4ff7fecc84566b921dd0ea72e67cd94fc4220f` produced both release and development
archives. Both binaries passed host `--version` and `--help`, and both archives
passed the independent verifier with expected archive hash and source commit.
The development build exercised the final committed-blob and compiler-wrapper
checks; the earlier release build preceded those additional packaging checks.
Release binary size was 42,764,864 bytes; development binary size was 367,223,728
bytes. These are startup/artifact results on one Linux host, not full platform
or workflow qualification.

Fifteen automated checks cover archive tampering, bounds, types, modes, duplicate
entries, truncated/trailing data, trusted expectations, committed-source freezing,
Git export transformations, compiler controls and a racing output destination.
The six packaging-boundary tests use fake local build tools; they do not replace
the actual Rust builds described above.

## Explicit native-only installation

`scripts/install-native.py` installs only into an explicit dedicated user-owned
prefix. A trusted archive SHA-256 is required. It snapshots and verifies archive
bytes without execution, retains immutable versions, and atomically switches a
native-only activation record. Exact reinstall reuses verified cached storage;
rollback verifies the previous version again. Deactivation retains versions and
history. Explicit recovery can restore a missing activation from a reverified
cached version. See [the installation contract](../scripts/NATIVE-INSTALL.md).

The actual release and development archives above passed installation, exact
reinstall without duplicate archive storage, upgrade, release rollback,
deactivation and reactivation in a temporary prefix on the same Linux host.
Activated binary hashes and `--version` were checked after each switch. All 30
distribution tests passed, including 15 installer tests for integrity, ownership,
concurrency and interrupted activation. No production alias or user installation
was changed by this qualification.
