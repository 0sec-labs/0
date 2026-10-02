# Real SmolVM controller checks — October 2, 2026

The initial controller and provider runs exercised the existing compiled distribution on the operator's Apple Silicon Mac. HEAD at test time was `3c2bc3a5`, but the bundle build predates that commit, so these runs do not qualify all source at that HEAD. Each receipt records the exact guest entry and distribution-tree digests plus the host controller-module digest; no distribution rebuild occurred during the runs. The resource reservation was free before testing. The subsequent semantic and authenticated-provider checks used a newly rebuilt distribution. Both initial and later checks used the existing approved small Node fixture image `sha256:a2986e852a463d33243ae0adf23e9853eb8eb776d3d0045a02c00ac0ea0b1495`, the respective CLI distribution and an explicit existing Linux dependency directory. They did not alter the selected toolbox, change global execution settings, stop unrelated VMs or download images.

## Compiled registered controller: passed

The [controller receipt](../qualification/smolvm-controller-20261002.json) records a real microVM run with a deterministic host SSE provider. The guest successfully executed `read_file` and `apply_patch`, exported the resulting file, and left the original host source untouched. A second turn was cancelled while its provider stream was pending. The controller returned `cancelled` and confirmed native shutdown; four provider requests included that cancelled stream. Resources were 2 CPUs, 2 GiB RAM and 4 GiB storage with a 90-second lifetime bound.

An earlier attempt refused a dependency mount under the protected host `/var` tree before guest startup and made zero provider requests. The successful run used the already existing dependency directory outside that protected tree. No guard was bypassed.

## Authenticated provider: passed

The [latest live provider receipt](../qualification/smolvm-live-provider-20261002.json), rerun after the semantic implementation and bundle rebuild, records account-catalog verification and a real `chatgpt-codex` run using the selected `gpt-5.6-sol` model. Three brokered provider calls returned HTTP 200. The guest read a disposable nonce fixture and wrote it into a new file. The exported file matched the nonce; the original host fixture was unchanged and no guest result appeared in the live host source directory. The run exited zero without a timeout or cleanup failure. The distribution hashes were unchanged across execution. The [earlier provider receipt](../qualification/smolvm-live-provider-20261002-before-semantic.json) remains separate. Host credentials were resolved by the broker and were not mounted or forwarded into the guest. Guest networking was disabled.

## Fresh-VM source learning: passed

The [source-learning receipt](../qualification/smolvm-source-learning-20261002.json) records three fresh real VMs using the production isolated-console adapter and deterministic host SSE fixtures. Scope enforcement was enabled only in an isolated temporary operator home. An explicitly configured workspace and YOLO child source target were used without a separate local-scope callback.

1. The first VM read two source files and saved two grounded observations. Both survived native teardown in host memory and child-scoped Knowledge.
2. A fresh VM received both observations as temporary request hints. Neither appeared in its persisted conversation history. Disabling one lesson removed that hint from the next request while the other remained available.
3. After changing the second observation's cited host file, a third fresh VM received neither the disabled nor changed-source hint; the changed entry became stale.

All three VMs confirmed native shutdown. Ten fixture provider calls used only `read_file` and `remember_codebase`, a 64K token budget, eight tool iterations and a four-minute deadline per VM. The rebuilt guest distribution and host adapter hashes remained unchanged. The test made no live-account calls and changed no global image/settings or existing approvals.

An earlier full-catalog 32K attempt correctly stopped at `max_turn_tokens` after two reads and one successful save. It cleaned up and was retained privately. The narrower test above qualifies lesson behavior; it does not hide that budget-bound result or measure discovery quality.

## Reproduce after rebuilding

Rebuild core and CLI, then run `pnpm build:bundle` before testing new source. The runners hash the guest distribution before and after each run. They accept an approved Node fixture archive and explicit Linux `node_modules` directory. The host dependency mount must satisfy normal workbench grant restrictions. Raw reports contain synthetic conversation/checkpoint state and are written privately; publish a reviewed, sanitized receipt rather than the full report.

```sh
node docs/qualification/run-smolvm-controller-fixture.mjs \
  /absolute/path/approved-node-fixture.tar \
  /absolute/path/linux-node_modules /absolute/path/controller-report.json

# Uses the currently selected authenticated account/model; at most eight calls.
node docs/qualification/run-smolvm-live-provider.mjs \
  /absolute/path/approved-node-fixture.tar \
  /absolute/path/linux-node_modules /absolute/path/live-report.json
```

For the real semantic test:

```sh
node docs/qualification/run-smolvm-source-learning.mjs \
  /absolute/path/approved-node-fixture.tar \
  /absolute/path/linux-node_modules /absolute/path/learning-report.json
```

## Remaining qualification

These runs qualify one basic controller task and one selected account/model. They do not establish vulnerability-discovery quality, comparative model performance, every provider, every security tool or efficacy of recalled lessons on unseen security tasks. The source-memory handoff is now qualified by the separate real save → fresh VM → recall check above; detector accuracy and comparative improvement require independent evaluation.

The selected toolbox remains incomplete: the previous [inventory](smolvm-qualification-20261001.md) found `ssh` absent. Docker is still unavailable and this host has approximately 18 GiB free, below the recipe's 30 GiB core-image build floor. A new immutable toolbox must be built on a suitable build host and pass the inventory before it can be called fully qualified. No disk cleanup, configuration switch or image modification was performed.
