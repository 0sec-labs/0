# Manual experimental native artifacts

`.github/workflows/native-artifact.yml` defines **Experimental native artifact**,
a manual-only Actions workflow. It has no push, tag, pull-request, schedule,
release, signing or deployment trigger/job. Existing production release and
installation workflows remain separate.

When this workflow is available in the repository's Actions interface, select its
branch and run it manually. Checkout and packaging both use the dispatch event's
exact full commit SHA. There is no second arbitrary source-ref input: the scripts,
tests and Rust source all come from that same checked-out commit. The workflow
uses a read-only repository token and disables persisted checkout credentials.

The only configured host is Ubuntu 24.04 x86-64 with target
`x86_64-unknown-linux-gnu`. The job installs the Rust `1.85` toolchain used by the
packager, confirms its host target, and runs all `scripts/tests/test_*native*.py`
distribution tests. Packaging uses the committed lockfile, release profile and a
fresh temporary build directory; compiler details are recorded in the manifest.
The runner needs Python 3, Git and a C compiler for native dependencies such as
bundled SQLite. Cargo and rustup may download dependencies/toolchain components.

The workflow then verifies the produced archive independently using both its
expected SHA-256 and exact source commit. Upload runs only after all preceding
steps succeed. Each experimental Actions artifact contains:

- `0sec-native-<full-source-sha>-x86_64-unknown-linux-gnu.tar.gz`;
- `SHA256SUMS`, covering that compressed archive;
- `packaging.json`, the packager's source/compiler/lockfile/binary record;
- `verification.json`, the independent verifier's archive/manifest/binary digests;
- `ci-provenance.json`, identifying the workflow run, source, target and runner.

The Actions artifact name includes the target, full source SHA, run ID and retry
attempt. Retention is seven days; this is not a permanent release channel. The
workflow does not upload an installer, replace production assets, create a GitHub
Release, sign/attest anything, publish a package or install a binary for users.

After downloading the artifact, verify it against an independently trusted digest
and source expectation before choosing whether to install it:

```sh
python3 scripts/verify-native-package.py \
  ./0sec-native-FULL_SOURCE_SHA-x86_64-unknown-linux-gnu.tar.gz \
  --expected-sha256 TRUSTED_ARCHIVE_SHA256 \
  --expected-source-commit FULL_SOURCE_SHA
```

The checksum and JSON records are ordinary unsigned files. They support integrity
checks and inspection, but their presence beside an archive does not authenticate
its publisher. The manifest records selected build inputs; the build is not
hermetic and does not claim reproducible bytes.

Passing this job establishes distribution boundary checks, archive verification
and `--version`/`--help` startup on the configured Linux host. It does not establish
compatibility with other Linux distributions, ARM, macOS or Windows, command
workflow parity, production cutover readiness, or complete Rust test coverage.
The existing `native.yml` workflow owns the broader Rust test matrix. See
[NATIVE-DISTRIBUTION.md](NATIVE-DISTRIBUTION.md) for packaging boundaries.

This workflow definition has been checked locally; it has not been dispatched as
part of its implementation. Hosted-runner qualification requires an actual
successful manually requested run.
