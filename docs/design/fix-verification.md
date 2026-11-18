# Fix verification

"Verified" is a recorded result, not something the agent says in its reply.

- A skill declares `verify:` (steps, a digest-pinned image, network `none` or `allowed`, timeout, success as exit 0, a regex or a baseline comparison `no-worse` or `improves`, and an optional canary). Code: `packages/engine/src/verifier/`, with a pure spec, result and claim gate behind a `ContainerRunner` port. Adapters: Docker or podman (the snapshot is copied in, never mounted; capabilities dropped; the network is off, or disconnected after an optional setup step) and a host adapter used only for an explicit `--test-command` with no image.
- Result: `status` (pass, fail, not-run, error), `reason`, `command`, `imageDigest`, `isolation`, `durationMs`, a redacted 2 KB `logTail`, `canary` (ok, missing, n/a) and `baseline` `{before, after}`. A missing canary is `fail` with reason `detector-did-not-run`; no container runtime is `not-run`; only a container run that passed is "Verified".
- Gate: a thread started with `--skill` for a skill that declares `verify` ends with `Verified by: ...` or `Not verified: ...`; a fixed or verified claim without a pass is marked as not backed by a check and `threads start --wait` exits 1.
- Only built-in skills run a verifier; one declared by a community `SKILL.md` is shown but not run.
