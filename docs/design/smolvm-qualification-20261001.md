# Real SmolVM checks — October 1, 2026

These are local execution checks on the operator's Apple Silicon Mac. They do not measure vulnerability-discovery quality or compare 0 with another product. No images were downloaded, accounts changed, host credentials forwarded, remote targets scanned or running chat backend restarted.

## Selected workbench image

The configured archive `sha256:37ff93702b3182deb9781cb6b5fba1c7f33def98f8339ada6535fceaac255f7b` booted in a real Linux ARM64 microVM under non-root UID 501. With 2 CPUs, 4 GiB RAM, a 20 GiB storage allocation and a four-minute deadline, the complete check took 195.9 seconds and returned a confirmed native teardown receipt.

- 24 of 25 required core tool startup checks passed, including 0, Codex, Claude, Gemini, Python, Git, curl, Nmap, SQLmap, ffuf, Gobuster and Foxguard.
- All six functional checks passed: guest identity, Python imports, read-only source, native tree-sitter parsing, offline Chromium and curl/Nmap against an HTTP listener created inside that guest.
- `ssh` was absent (`ENOENT`). **The selected image does not pass complete core toolbox qualification.** Startup of a scanner does not qualify its authenticated or remote scanning features.

The [sanitized receipt](../qualification/smolvm-workbench-20261001.json) records each check and immutable image identity. The earlier 2 GiB RAM/4 GiB storage/60-second attempt timed out before guest output and cleaned up successfully. This negative result remains locally in `/tmp/zero-smolvm-qualification-20261001.stderr`.

The current `core-web` build recipe already includes `openssh-client`, and its mandatory SSH probe is inherited by source and Kali profiles. Fixing the selected immutable archive requires a new image build and qualification; adding a package to a running VM would not fix that archive. Docker is unavailable on this Mac and free space is below the recipe's 30 GiB core build floor. No image build or destructive disk cleanup was attempted.

On a build host with Docker and adequate free space, first commit the intended image source and run:

```sh
node scripts/build-workbench-image.mjs --profile core-web \
  --archive /absolute/output/workbench-core-web.tar --build
node scripts/smoke-smolvm-workbench.mjs \
  /absolute/output/workbench-core-web.tar core-web \
  /absolute/output/workbench-core-web-qualification.json
```

Only explicitly select the new archive after inspecting its build and qualification receipts. This check does not change the operator's selected image.

## Isolation and lifecycle

All 13 lifecycle cases passed using the smaller approved Node fixture archive `sha256:a2986e852a463d33243ae0adf23e9853eb8eb776d3d0045a02c00ac0ea0b1495`; the [receipt](../qualification/smolvm-lifecycle-20261001.json) records durations for each case. This archive is a fixture, not the complete workbench toolbox. It is used by `scripts/smoke-smolvm.mjs` to test repeated fresh workers, stream separation, resource limits, cancellation and cleanup. The smoke runner now checks each run's own native teardown result instead of treating every concurrent SmolVM process as its own leaked guest. It neither terminates nor attributes another workbench's processes to its test.

The profile-inventory runner deliberately writes a failed receipt and exits nonzero when any required tool is missing. It never converts a successfully booted but incomplete toolbox into a passing qualification.

## Registered controller

A separate attempt to run the current CLI controller with a deterministic host SSE fixture correctly refused to start because another native workbench held the resource reservation. It made zero provider requests. The active workbench and lease were left intact. The [blocked receipt](../qualification/smolvm-controller-20261001.json) records this explicitly: the current registered controller and its latest source-context export are not qualified by this attempt. Earlier September 30 controller evidence remains separate and does not substitute for a new current-build check.
