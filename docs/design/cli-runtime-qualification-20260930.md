# CLI, runtime and adoption qualification — 2026-09-30

This is a bounded operator pilot, not a comparative benchmark or proof of general superiority. The original reconciliation and issue-by-issue remaining work are recorded in [open-issue-status.md](open-issue-status.md).

## Live comparison

Two identical fresh Git workspaces contained a Python standard-library service and an explicit contract: owner arguments must filter exactly; document names must stay inside the application-controlled root. Ground truth comprised SQL injection in `event_search`, containment bypasses in `read_document`, and two clean controls (`event_lookup`, `open_document`). Both arms received the same prompt, medium reasoning, no delegation, no network or credentials in the target, permission to create a local PoC, and a 240-second outer process cap. Authentication was supplied to the provider adapter separately, never placed in the target repository. The 0 arm additionally had a 24-tool-call cap. No source/contract file changed; SHA-256 checks matched across arms after execution.

First pilot used `gpt-6.1-sol`. Official Codex completed in 96.3 seconds and reproduced both defective functions, including sibling-prefix and symlink escapes. The 0 direct ChatGPT backend rejected the exact model with HTTP 400 in 3.0 seconds, before any tool call. Its process incorrectly exited zero. This negative result is retained: the headless exit-status fix now reports error outcomes with exit 1 and explicit account/model guidance, without substituting a model. The two access paths expose different model availability; choosing an account-supported model is an explicit experimental change.

Second pilot used `gpt-5.6-sol`, present in the current direct-backend account catalog. Each arm ran once:

| Observation | 0 console | Official Codex exec |
| --- | --- | --- |
| Completion | Success, 87.3 seconds | Success, 51.2 seconds |
| Defective functions reproduced | Both | Both |
| Clean controls | Correctly retained | Correctly retained |
| Sibling-prefix escape | Runtime reproduced | Runtime reproduced |
| Symlink escape | Not tested in this run | Runtime reproduced |
| Structured finding persistence | Two saved; two initial schema rejections corrected | Plain report and local PoC |
| Reported aggregate tokens | 147,099 input; 3,608 output | 101,220 input, including 93,696 cached; 2,197 output |

Token counters originate from different adapters and are not independently billed-cost measurements. The 0 footer does not expose a matched cache/reasoning breakdown. No dollar-cost advantage is established. Additional finding-persistence work affects latency; neither path has enough runs or targets to estimate stochastic quality, false-positive rates or general performance. This pilot provides **no evidence that 0 is generally better than Codex**.

Commands were `0 console --mode yolo --model MODEL --max-tool-calls 24 --print PROMPT` and `codex exec --ephemeral --ignore-user-config --sandbox workspace-write --json -m MODEL`, with medium reasoning and Codex approval policy `never`. Isolated 0 configuration used the existing operator account via the explicit auth-file setting, an isolated findings database and no MCP servers. This was local execution, not a SmolVM efficacy comparison. Source hashes: `service.py` = `3c3e9e2035560f1ba67836b8775c10738c4609ed0fab97da014689b02c5b0543`; `README.md` = `8f13ed80035b8923ef3c115d6cad3fdbc16c526550523950bab02627b55a253e`.

Local raw pilot artifacts are retained under `/tmp/zero-cli-qualification-20260930` and `/tmp/zero-cli-qualification-supported-20260930`. The runner's initial command-metadata bookkeeping bug was corrected from the original command dictionary; observed outputs, durations and exit codes were unchanged. These local paths are not portable publication artifacts.

## SmolVM

The signed, pinned runtime is installed privately and ready. The global execution profile remains **local**; workbench configuration has no selected image. A ready runtime alone does not mean a conversation runs in a VM.

Disposable real VM checks booted Linux ARM64 under non-root UID 501, with loopback-only networking, no host credentials and confirmed teardown. Current CLI guest startup initially failed in the small Node image because React was absent; mounting the macOS dependency tree then failed on the unavailable Linux ARM64 tree-sitter addon. Import/start of the existing toolbox image exceeded the first bounded 120-second attempt. These are real qualification blockers, not mocked success. The full toolbox import also exceeded a 300-second retry. No global execution profile was changed.

A subsequent **CLI guest startup qualification passed** in 14.7 seconds: the 0.22.1 bundle from `c75c339c` ran `--version`, `--help` and `workbench status --json`, each with exit 0, in the real offline Linux ARM64 guest. The successful setup used the existing smaller Node image plus 140.9 MB of Linux dependency files extracted under bounded archive checks from the previously approved toolbox archive. No downloads or host credentials were needed. Non-root UID 501, loopback-only networking and teardown without new VM processes were verified. The passing local receipt is `/tmp/zero-smolvm-runtime-qualification.json`; prior failures are preserved separately.

This proves CLI startup and diagnostics in a VM. It does **not** prove a full authenticated model/tool conversation inside the whole-harness workbench, enable that profile globally, or resolve slow full-toolbox import. Normal CLI/web-console sessions still run locally.

## People testing it

There is concrete external evidence: [issue #143](https://github.com/0sec-labs/0/issues/143) reports a live DeepSeek console interruption; [issue #74](https://github.com/0sec-labs/0/issues/74) reports an actual Linux review of dotnet/dotnet; [merged PR #141](https://github.com/0sec-labs/0/pull/141) contributes a reproduced long-session terminal fix. These demonstrate people trying the product and contributing, not a measured active-user population. Internal operator reports are separate evidence.

At the checked snapshot, GitHub binary asset downloads were 99 for v0.21.4, 19 for v0.22.0 and 7 for v0.22.1, excluding checksum files. Downloads can include repeats, maintainers and automation. They are not unique users or successful launches. No reviewed active-user metric or matched multi-target raw-Codex study was found. Real VM smoke scripts exist; mocked configuration tests and Docker CI do not establish a current SmolVM end-to-end pass.

## Follow-up validation

After incorporating the separate web-console and CLI-doc changes on upstream main, the public suite passed again: 8,289 core tests, 3,393 CLI tests and 31 test-target tests, followed by runtime-lock, bundled-skills, public-export, development-engine, MCP and docs-pointer checks. Full build and lint passed before the follow-up UI/headless patches. Focused tests, dashboard build, CLI build/bundle and final lint validate those patches separately. Dependency rescan updates to PyJWT 2.15.0 and DOMPurify 3.4.16 passed frozen install and docs build.

Tool rows retain arguments/results and resolved approval detail behind a keyboard-accessible disclosure. Running rows use subtle icon pulse and status shimmer; completion stops animation. Stopped and structured error receipts remain distinct from Done. Actual browser checks covered expansion/collapse, keyboard activation, reduced-motion suppression, and a narrow 312-pixel viewport without horizontal overflow. Pending approval actions are unchanged.
