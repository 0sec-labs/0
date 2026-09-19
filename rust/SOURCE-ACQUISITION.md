# Native repository acquisition

The opt-in native CLI can fetch one explicitly selected Git ref into a new private
directory, without opening its state database or invoking a model:

```sh
0sec-native source acquire \
  --url https://github.com/example/project.git \
  --ref refs/heads/main \
  --output /absolute/new-capture
```

The output directory must not exist. It contains `source/` and a canonical
`receipt.json`, and appears only after complete successful capture. The receipt
records the requested remote/ref, resolved SHA-1 commit and tree IDs, exact source
snapshot, and executable paths. It is host-captured provenance, not a signed
repository authenticity claim. Keep the receipt alongside the source.
Staging, cleanup and no-replace publication use the originally opened directory
handle; replacing its pathname cannot redirect writes into another directory.
An error during the final parent-directory synchronization or identity check can
leave a complete published capture. An error therefore does not imply that the
destination is absent; inspect any existing capture before choosing a new output.

Use a complete `refs/heads/...`, `refs/tags/...`, or lowercase 40-character commit
ID. A branch or tag records the commit actually received; a commit-ID request
must resolve to that exact commit. SHA-256 Git repositories are rejected in this
version. No default branch, package registry, submodule, LFS fetch, build, or
repository program is implicitly selected.

An explicit local transport is available independently of HTTPS URL parsing:

```sh
0sec-native source acquire \
  --local-repository /absolute/local-repository \
  --ref refs/tags/v1.0 \
  --output /absolute/new-capture
```

Local source must be an ordinary repository directory, not a linked worktree or
an alternate object store. HTTPS URLs cannot contain user information, query
parameters, or fragments. Other protocols, redirects and ambient authentication
are disabled. This release has no private-repository credential configuration.

Acquisition uses a new isolated bare repository. Git receives an empty inherited
environment with a private HOME, disabled system/global Git configuration,
disabled credential helpers and prompts, an empty initialization template, and
disabled hooks/automatic maintenance/submodule recursion. It reads tree/blob
objects directly: it never performs checkout or runs smudge/clean filters. Git
symbolic links, gitlinks, unsafe/non-UTF-8 paths, and `.git` path components are
rejected before source files are written. The fetched `.git` directory is never
part of `source/`.

Limits are 4,096 files and 64 MiB total source bytes, checked against the tree
before reading blob contents. Tree output is capped at 2 MiB. Git stdout is
bounded per operation; stderr is bounded at 64 KiB and not returned to callers.
Git and its helpers additionally inherit a 128 MiB per-file limit, 768 MiB
per-process address-space limit, and 60-second CPU limit. The default wall
deadline is 60 seconds; `--timeout-ms` accepts 1–120,000. Cancellation, timeout
and output overflow kill the owned process group and reap its leader before
ordinary private-directory cleanup. Unconfirmed process cleanup retains the Git
scratch directory and reports its path. Abrupt host/runtime death is outside this
drained-cleanup guarantee.

This Linux implementation requires `/usr/bin/prlimit` and defaults to
`/usr/bin/git`; an explicit absolute `--git-bin` selects another host installation.
Acquisition rejects symlinked executable/source/output-parent paths. Only the
host chooses these paths and the target URL; no model acquisition tool is added.

The acquired source is usable with ordinary native review:

```sh
0sec-native --state /absolute/state.db \
  --providers /absolute/providers.json --review-profiles /absolute/reviews.json \
  review /absolute/new-capture/source --profile local --command-id review-1
```

Review retains the captured source through its existing archive contract. This
first acquisition checkpoint **does not yet attach the Git receipt as typed
review authority**. A review of the path must not be presented as proof that its
files came from a remote without separately validating the acquisition receipt.
The coordinated next phase will bind that receipt to review admission; no
receipt is hidden inside or added to the repository's source tree.

Deterministic qualification uses real local fixture repositories, hostile Git
configuration/filter fixtures, subprocess cancellation fixtures, and the actual
native binary with a loopback model endpoint. No external repository/provider
traffic or real sandbox execution is part of these tests.

Git's primary references describe [fetching explicit refs](https://git-scm.com/docs/git-fetch),
[raw object reads](https://git-scm.com/docs/git-cat-file), and
[tree listings](https://git-scm.com/docs/git-ls-tree).
