# Native source acquisition

Explicit-version published npm source is also supported; see
[NPM-ACQUISITION.md](NPM-ACQUISITION.md) for its separate registry, integrity and
no-install contract. The Git workflow below keeps its original receipt format.

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
  review /absolute/new-capture/source --profile local --command-id review-1 \
  --acquisition-receipt /absolute/new-capture/receipt.json
```

The explicit receipt is bound to the review's immutable intent, retained as a
canonical artifact, and referenced in status/report metadata. The original
absolute source root, every file digest and size, snapshot identity and executable
paths must match the captured source. Archive retention checks the modes again
before inference. Changed content, modes, or root fail before model execution.
The receipt stays outside `source/`; review never discovers one implicitly.

This is **host-selected provenance**, not a repository authenticity signature.
A supplied receipt's commit/tree IDs are caller claims bound to the selected
content; no network verification of those IDs takes place during review.

Exact command retries compare the retained receipt selector before reading any
source, provider configuration or receipt file. The same selector works after
those files are deleted; omitting or changing it conflicts. Selectors are captured
as normalized absolute paths and are labels, not authority to open a file later.
The retained artifact and source archive remain available for independent reads.
Reviews without this option preserve their existing intent and archive identities.

Deterministic qualification uses real local fixture repositories, hostile Git
configuration/filter fixtures, subprocess cancellation fixtures, and the actual
native binary with a loopback model endpoint. No external repository/provider
traffic or real sandbox execution is part of these tests.

Git's primary references describe [fetching explicit refs](https://git-scm.com/docs/git-fetch),
[raw object reads](https://git-scm.com/docs/git-cat-file), and
[tree listings](https://git-scm.com/docs/git-ls-tree).
