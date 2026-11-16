# Fix verification

## What the fix experiment showed

Four lanes drove the CLI headlessly with an Agent (`0 threads start --access changes`) to fix real findings, then a person judged whether each change was merge-ready as it stood.

| Lane | Merge-ready as is |
| --- | --- |
| Dependency bumps | 2 of 11 (the rest needed edits) |
| Config and IaC | 2 of 9 |
| Secrets | 0 of 6 (allowlist files disabled all rules, so a "clean" result was vacuous) |
| Workflow hardening | 7 of 8 |

For owners: expect to edit dependency and config fixes, never trust a secrets "clean" without checking the detector config, and treat workflow hardening as the one lane that is close to autonomous. The generated `.gitleaks.toml` problem is Agent behaviour, not a code bug, and is not changed here.

The product gap: nothing forces the Agent to re-run the detector with the repository's real configuration, or to run the repository's own tests, before it says a fix is verified. "Verified" is currently a claim in the reply, not a recorded result.

### Proposed verification step

1. A fix is "verified" only through a verification step that the product runs, not one the Agent describes.
2. The step re-runs the detector that produced the finding, using the repository's own configuration, unmodified. A config file the Agent created or changed in the same fix does not count; the original is used.
3. It fails closed: if the detector reports fewer rules loaded than the original run, or the same finding cannot be reproduced on the unfixed commit, the result is "not verified", not "clean".
4. It runs the repository's own test command (detected from the manifest or CI file, or set in the folder's settings) and records the exit code and a short tail of output.
5. It runs the lockfile or build check for the ecosystem (install, `cargo check`, `go build`) when dependencies changed.
6. Each result is stored on the Thread with the commit it ran on; a later edit marks it stale.
7. The Agent's reply and any pull request body show the recorded results (detector, tests, build: passed, failed, skipped and why), never prose alone.
8. A fix with any failed or skipped check is labelled "needs review" and cannot be auto-published.
9. Commands run in the Computer the Thread uses, under the same Scope and access rules; the step adds no new permission.
10. Measure with this experiment again: the target is that no fix labelled verified is later found not merge-ready for a verification reason.

## Status: first slice shipped

The product now runs a verifier the Agent cannot claim. What exists:

- A skill declares `verify:` (steps, a digest-pinned image, network `none` or `allowed`, timeout, success as exit 0, a regex or a baseline comparison `no-worse` or `improves`, and an optional canary). Code: `packages/engine/src/verifier/`, with a pure spec, result and claim gate behind a `ContainerRunner` port. Adapters: Docker or podman (the snapshot is copied in, never mounted; capabilities dropped; the network is off, or disconnected after an optional setup step) and a host adapter used only for an explicit `--test-command` with no image.
- Result (stored additively on the fix record and the thread outcome): `status` (pass, fail, not-run, error), `reason`, `command`, `imageDigest`, `isolation`, `durationMs`, a redacted 2 KB `logTail`, `canary` (ok, missing, n/a) and `baseline` `{before, after}`. A missing canary is `fail` with reason `detector-did-not-run`; no container runtime is `not-run`; only a container run that passed is "Verified".
- Gate: a thread started with `--skill` for a skill that declares `verify` ends with `Verified by: ...` or `Not verified: ...`; a fixed or verified claim without a pass is marked as not backed by a check and `threads start --wait` exits 1.
- `scan fix --test-command` goes through the same runner (typed result; `--verify-image` selects a container). Without an image it stays on the host, stamped `isolation: host`, and is never Verified.
- The workflow-hardening skill is the first built-in: actionlint and zizmor (the repository's own configuration) in two pinned images, with a planted unpinned action as the canary, and `baseline: improves`.
- The second-Agent check is shown as Corroborated.

Not in this slice: retry with the log tail, patch-hash staleness, the `--allow-unverified` block on PR creation, advisory snapshots, and running verifiers declared by community `SKILL.md` files (they parse and show, but only built-in skills run until install-time approval exists). Slice 2 is the dependency and secrets skills (`setup` with network then cut, and a generated canary for gitleaks).

### First real run (gpt-6-luna, 2 public repos, USD 0.01 total)

`threads start --skill workflow-hardening` on fatih/color and google/gson, with the check running in pinned zizmor and actionlint images:

| Repo | Agent said | Harness result |
| --- | --- | --- |
| fatih/color | pinned 3 actions, `contents: read`, `persist-credentials: false` | Verified by: zizmor and actionlint passed, 10 to 4 findings (0.4s); canary flagged |
| google/gson | `read-all` narrowed; could not pin two `@master` actions, said so | Verified by: zizmor and actionlint passed, 18 to 17 findings (0.5s); canary flagged |

Before the gate, "verified" was the Agent's sentence (7 of 8 merge-ready in the experiment, judged by a person afterwards). With the gate, both replies carry a recorded line with counts. A first attempt with no reachable container runtime (the Docker context lived under a different HOME) ended with "Not verified: no container runtime is available", as designed. n=2 is a demonstration, not a rate. Known gap: "improves" accepts a partial fix (17 findings remain on gson); slice 2 should check the target findings are gone and print what remains.
