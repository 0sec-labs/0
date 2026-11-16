# Skills as the unit

Status: PROPOSAL for owner decision. Nothing here is implemented except where a
file:line says so. Paths are relative to `packages/`. Counts marked "derived" come
from reading the code, not from running it.

## 1. Answer

- `scan` is not a skill. `scan` is a verb: sugar that starts a Thread with a Skill.
  The CLI already does this for targets: `rewriteScanArgs` (`cli/src/routing.ts:24`)
  picks a module from the target. We keep it as the front door and stop treating
  each module as its own engine.
- One primitive runs everything: a **Thread** runs a **Skill** against a target
  (folder, repo, URL) with scope, access and budget. Output is **Findings**, a patch
  or a report.
- A Skill declares a **verifier**: a command the harness runs in a container after
  the agent says it is done. The harness, not the agent, decides "verified".
- **Agent** = Skill + trigger + budget + access. **Automation** = the trigger config.
- No new top-level commands. The CLI has 14 (`web scan findings threads agents
  automation models computers skills plugin memory config doctor api`); we add
  flags to `threads start`, `scan fix` and `skills`, nothing at the root.

Why now: the fix experiment showed the agent can say "fixed" without re-running
the detector with the repo's real config or running the repo's tests. Today the
only hard gate is in `scan fix` (section 2.4) and it runs on the host. Recurring
jobs with verifiable outcomes need that gate everywhere.

## 2. What exists today (evidence)

### 2.1 Entry paths: 8 live, 3 legacy or bench-only

| # | Entry | Where | Callers |
|---|-------|-------|---------|
| 1 | `agenticScan` (web/URL: discovery, attack, verify, report) | `engine/src/agentic-scanner.ts:58`, phases at :779 :891 :1260 :2778 | `assessment.ts:116`, `unified-pipeline.ts:304`, `cli/commands/orchestrate.ts:479`, bench: `xbow-runner.ts:503`, `cybench-runner.ts:331`, `picoctf-runner.ts:200`, `cybergym-runner.ts:811` |
| 2 | `runPipeline` / `runPipelineSingle` (source, package, repo: prepare, analyze, research, verify, report) | `engine/src/unified-pipeline.ts:300`, :355 | `assessment.ts:122`, `secure/project.ts:362`, `cli/workflow-research-executors.ts:116` |
| 3 | `executeAssessment` / `executeAssessmentRun` (dispatches to 1 or 2; the Run variant wraps it in a fake one-step workflow) | `engine/src/assessment.ts:81`, :129 | `cli/commands/run.ts:592` (`runUnified`, used by `scan web`, `scan source`, `scan package`) |
| 4 | `executeWorkflow` (typed steps audit/verify/fix/research/deep-review; Automations, schedules, Agent activations) | `engine/src/workflow-runner.ts:99` | `workflow-service.ts:71`, `assessment.ts:159`, `cli/managed-operation.ts:46` |
| 5 | `runDeepReview` (its own loop, in the CLI package) | `cli/commands/deep-review.ts:1050` | CLI `scan deep`, `workflow-research-executors.ts:166` |
| 6 | `runSourceFix` (fix a reproduced finding, host test command) | `engine/src/fix/source-fix.ts` | `cli/commands/fix.ts:185`, `cli/web/workflows.ts:867`, Thread tool `generate_fix` (`agent/tools/offensive-engines.ts:584`) |
| 7 | `runSecureProject` (`scan repair`: pipeline then repair per finding, own state dir and lock) | `engine/src/secure/project.ts:600`, calls :362 and :1045 | `cli/commands/secure.ts:85` |
| 8 | Thread turn engine (chat loop with the tool registry; start_run queues workflows) | `engine/src/console/turn-engine/session.ts`, `console-tools.ts:49` | `0 threads start` (`cli/commands/missions.ts:86`), web, Agent activations |
| L1 | legacy `scan()` (staged, `--runtime auto` per stage) | `engine/src/scanner.ts:63` | only bench: `bench/src/runner.ts:199`, `xbow-runner.ts:519` (non-agentic arm), `bench-integrations/xbow.ts:160` |
| L2 | `packageAudit` / `runPerFileAudit` / `runSupplyChainScan` | `engine/src/audit.ts:845`, :558, :749 | only bench: `bench/src/npm-bench.ts:236`, `engine/src/bench/adapters.ts:190` (CLI `scan package` goes through path 3) |
| L3 | `sourceReview` (deleted in step 6a) | was `engine/src/review.ts:456` | no production caller; two tests only |

Plus about 22 `research` subcommands (hunt, memsafety, kernel, cve, ...) each with
its own engine, and `campaign`, `orchestrate`, `verify`, `deps`, `eval`.

### 2.2 Call graph (today)

```
 0 scan web|source|package|deep|repair|campaign     0 threads start     0 agents / automation
        |   (tree.ts:133, routing.ts:17)                |                    |
        v                                               v                    v
   runUnified (run.ts)                          turn engine (session.ts)   WorkflowService
        |                                         |  tools: generate_fix,    executeWorkflow (4)
        v                                         |  verify_finding, ...        |  typed steps
 executeAssessmentRun (3) -- 1-node workflow      |  start_run -----------------+
        |                                         v
        v                                   runSourceFix (6) / engines
 executeAssessment
   |-- url/web-app --> agenticScan (1) ---- discovery > attack > verify > report
   '-- else --------> runPipeline (2) ---- prepare > analyze > research > verify > report
                                                     ^
 scan repair --> runSecureProject (7) ---------------'  then runBehavioralRepair
 scan deep   --> runDeepReview (5)          scan fix --> runSourceFix (6)
 bench runners --> agenticScan (1) / scan() (L1) / packageAudit (L2)   (bypass CLI and workflows)
```

### 2.3 Deterministic code versus LLM

| Stage | Kind | Evidence |
|-------|------|----------|
| prepare (detect type, clone, resolve, file cap) | code | `unified-pipeline.ts:565-729` |
| analyze (static scanners, seed layers, dependency audit) | code | :734-958 |
| research (find, attack, write PoC) | LLM agent; per-file loop `runPerFileResearch` :171 | :1062-1357 |
| verify ("blind verify") | LLM agents, concurrency-limited; not a command | :1427-1725, prompt `blindVerifyPrompt` :1534 |
| report, novelty, scoring | code | :1746-1809 |
| web discovery/attack/verify | LLM loop with scope enforcement | `agentic/phase-runners.ts:79, 175, 681` |
| scope, rate limit, cost ceiling, time cap | code | `scope/*`, `scan-plan.ts:48,102`, `shared/types.ts:26` (`ScanPlan`) |
| source-fix recheck | code: `evaluateVerificationSpec` (regex predicates, no LLM, behavior predicates unsupported) | `verification-spec/spec.ts` |

Runtime choice: `--runtime auto|api|claude|codex|gemini`. `pickRuntimeForStage`
(`runtime/registry.ts:65`) and `selectVerificationRuntime`
(`unified-pipeline/runtime-selection.ts:25`) pick per stage; `scan fix` and
`scan repair` accept only `api`.

Important: "verify" in the pipeline is one agent corroborating another. It is
useful, but it is not a harness-run check. Section 6 renames it.

### 2.4 Fix and verify today

- `scan verify` replays a PoC and writes a `verification_result`.
- `scan fix` (`cli/commands/fix.ts`) needs a reproduced finding, requires
  `--test-command`, works in an isolated git worktree, makes up to 3 candidate
  patches, re-checks the verification spec, then runs the test command. This is
  already a verifier gate, for one flow. Gap: the command runs as
  `/bin/sh -lc` on the host (`fix/source-fix.ts:299`), the result is not stored as a
  typed record on the Finding, and nothing blocks the label "verified" elsewhere.
- `scan repair` repeats this per finding, optionally publishes PRs.
- `deps fix` (`cli/commands/deps.ts:75-81`) runs `npm audit fix` / `pnpm audit
  --fix` / `cargo update` / `pip-audit --fix` and verifies nothing.
- `findings` lists, triages, exports. `Finding` (`shared/types.ts:703`) has
  `triageStatus`, `layerVerdicts`, `workflowStatus`; no verifier record.

### 2.5 Threads, Agents, Automations, Skills

- Threads: `0 threads start <prompt>` already has `--model --effort --access
  read-only|changes --folder --target --scope` (`missions.ts:86-88`). Slash
  commands are one registry (`shared/slash-commands.ts`); `/fix` maps to `scan fix`.
- Agents (`shared/sentinels.ts`): own `skills[]` (:141), instructions, access,
  budget. An activation (:229-236) opens a child Thread with a per-run skill
  allow-list "also enforced as a hard filter" (`list_skills`/`load_skill`).
  The review fingerprint (:189) already covers skills, so editing a skill forces
  re-acknowledgement.
- Automations: workflow graphs with trigger nodes (schedule, github-pr, manual)
  and typed step nodes (`shared/security-workflows.ts:43`). Templates
  (`security-workflow-templates.ts`) are `phase(goal, instructions)` audit nodes:
  they are prompt skills in disguise. Agent presets reference them by `templateId`
  (`sentinel-presets.ts:58-80`: dependency-watcher, fix-engineer, secrets-hunter).
- Skills: 52 built-in YAML (`agent/skills/{techniques,vulnerabilities,frameworks}`),
  type `SkillDefinition` (`skills/types.ts:9`) is id, description, triggers,
  `content` (methodology text). They are knowledge, loaded mid-run by
  `load_skill`. User skills are standard `SKILL.md` folders (project, personal,
  mount), 128 KiB cap, scripts never executed (`agent-skills.ts:43,60`); frontmatter
  keys other than name, description, tags are ignored today, so adding fields is
  backward compatible. The Skills page and `0 skills` browse a catalog with
  `verified` and `publisher` fields (`cli/commands/skills.ts:10`). Plugins can
  contribute skills (`docs/design/plugins-one-concept.md`).
- Benchmarks (XBOW, Cybench, PicoCTF, CyberGym) call `agenticScan` directly
  (`xbow-runner.ts:503`). They do not go through the CLI, runUnified or workflows.
  The bench README warns the 93/95 gpt-5.4 grouping is not pass@1 and that
  the ledger does not separate white-box from black-box.

Count: 8 live entry paths plus 3 legacy, each with its own budget, event and result
wiring. A "done" claim is accepted from the agent in all of them except path 6.

## 3. The model

```
  0 scan source .  ==  0 threads start --skill source-review --folder .
                                  |
                                  v
  Thread = { skill, target(folder|repo|url), scope, access, budget, computer }
                                  |
          +-----------------------+------------------------+
          | prompt skill          | pipeline skill         |
          | agent loop + tools    | ordered engine stages  |
          +-----------+-----------+-----------+------------+
                      |  agent says "done" / stages end
                      v
              HARNESS VERIFIER  (container, section 7)
                      |
        pass | fail | not-run | error   + logs, stored with the result
                      v
         Findings / patch / report   (label "Verified" only if pass)
```

| Concept | Is | CLI today and after |
|---------|----|---------------------|
| Thread | one run: conversation, tool calls, budget, record | `threads start --skill <id>` (new flag) |
| Skill | instructions, tool allow-list, optional stages, verifier, output type | `skills list/show/create`; `--skill` accepted by `threads start`, `scan` |
| Findings | output type, with verifier results attached | `findings list/show` prints "Verified by" |
| Agent | a Skill on a trigger, with access and budget; persistent identity and notes | `agents create --skill <id>` |
| Automation | the trigger config only (schedule, PR, manual) pointing at an Agent or Skill | `automation ...` unchanged |
| Computer | where the Thread and the verifier run (VM or container image) | `computers` unchanged |
| Memory | what carries across Threads | unchanged |
| `scan` | sugar | flags keep working (section 5) |

### 3.1 Skill envelope (one shape for both kinds)

Extends `SKILL.md` frontmatter. Unknown keys are already ignored by other readers.

```yaml
---
name: workflow-hardening
description: Harden GitHub Actions workflows without breaking CI.
kind: prompt            # prompt | pipeline
inputs: [folder]        # folder | repo | url | finding | package
access: changes         # read-only | changes (Thread ceiling; the user can lower it)
budget: { usd: 3, minutes: 20, turns: 60 }
tools: [core, pack:ci]  # allow-list ceiling, section 8
output: patch           # findings | patch | report
verify: { ... }         # section 7
stages: [prepare, analyze, research, verify, report]   # pipeline kind only
---
Instructions as markdown...
```

Rule: a skill without `output` is knowledge (the 52 built-ins stay as they are and
are loaded mid-run). A skill with `output` can be started. Same file format, one
concept.

### 3.2 What must stay code

- Pipeline skills: `web-pentest` (`agenticScan`), `source-review`, `package-audit`
  (`runPipeline`), `deep-review`, `repair`. `kind: pipeline` names engine stages;
  the stage bodies stay TypeScript. Reasons: benchmark reproducibility,
  resumable journals, cost accounting (`scan-plan.ts`), scope enforcement,
  per-stage runtime choice.
- Prepare, static analysis, scoring, novelty, scope, rate limit, cost ledger,
  the verifier runner: code, never a prompt.
- Community skills are `prompt` only. `pipeline` is first-party.
- The envelope is the same, so a Thread, an Agent and the UI treat both alike.

## 4. Delete and merge

| Action | Item | Gate |
|--------|------|------|
| delete | `sourceReview` (L3) | move its 2 tests to the live path |
| delete later | legacy `scan()` (L1); `packageAudit` family (L2) | bench moved to `agenticScan` / `executeAssessment`, rerun (section 9) |
| fold | `executeAssessmentRun` fake one-node workflow into the Thread run envelope | lifecycle events unchanged |
| merge | `scan fix`, Thread `generate_fix`, `web/workflows.ts:867` into one fix skill using `runSourceFix` | one call site |
| merge | `scan repair` bookkeeping (state dir, lock, resume in `secure/project.ts`, 1235 lines) onto Thread persistence; repair = source-review then fix skill per finding | last, highest risk |
| move | `runDeepReview` from the CLI package into engine as a pipeline skill | engine owns logic |
| replace | workflow templates and Agent `templateId` with skill ids | alias old ids |
| turn into skills | `deps fix`, `agent-assure`, `disclose`, `eval` (each a skill with output and verifier or a thin command) | per skill |
| keep | `0 deps scan`, `findings`, `scan verify` (it is the verifier for exploit findings) | n/a |

Top-level command count stays 14. Verbs move under `scan`/`skills` or become flags.

## 5. `scan` as sugar

```
0 scan <target>              -> pick skill by target kind (same rule as routing.ts:24)
0 scan source .              -> threads start --skill source-review --folder .
0 scan web --target URL ...  -> threads start --skill web-pentest --target URL
0 scan fix <finding>         -> threads start --skill fix --finding <id>   (verifier required)
0 scan --skill <id> <target> -> any skill, including community ones
```

Every current flag (`--depth --runtime --cost-ceiling --scope --resume --emit ...`)
maps to a Thread config or a pipeline-skill input and keeps working. `--resume`
keeps using the journal. A conformance test compares the old and new parse
for every flag (section 9, check A).

## 6. Vocabulary for "verified"

- **Verified**: the harness ran the skill's verifier and it passed. Nothing else
  earns this label.
- **Corroborated**: today's blind-verify agent agreed. Rename the UI label; keep
  the stage.
- **Reproduced**: `scan verify` replayed the PoC (existing).
- **Not verified**: verifier failed, errored or did not run, with the reason shown.

## 7. Verifier spec

### 7.1 Frontmatter

```yaml
verify:
  steps:                       # run in order inside one container
    - name: actionlint
      run: actionlint
    - name: zizmor
      run: zizmor --config .github/zizmor.yml --format json .github/workflows
  setup: null                  # optional; the only phase that may use network
  image: ghcr.io/example/verify-actions@sha256:...   # digest required, no tags
  network: none                # none | setup-only | allow:[host,...]  (default none)
  timeout: 300s                # per step; total capped by the Thread budget
  resources: { cpu: 2, memory: 2GiB, disk: 4GiB }
  success:                     # all must hold
    - { step: actionlint, exit: 0 }
    - { step: zizmor, json: "$.length == 0" }
  baseline:                    # run the same steps on the tree before the change
    mode: no-worse             # no-worse | must-fail-before | none
    compare: findings-by-fingerprint   # or: exit-code | test-set | count
    flake_retry: 1
  liveness:                    # prove the detector was awake (optional)
    canary: { file: .canary/bad.yml, expect: "zizmor reports >=1" }
  on_fail: retry               # retry (agent gets redacted log tail, max 3, counted in budget) | report
  on_missing_runtime: not-run  # never "pass"
---
```

### 7.2 Execution rules

1. Container by default. The untrusted repo never runs on the host. The container
   is non-root, read-only root filesystem, tmpfs for scratch, CPU/memory/time
   limits, no host mounts except a copy-on-write snapshot of the worktree after the
   change. No `~/.0`, no credentials, no inherited environment; secrets are never
   passed.
2. Network: `none` after setup. Dependency fetch happens in `setup` with network,
   then network is cut before any repo test or detector runs (lifecycle scripts
   in `npm install` run only in the setup phase, with `--ignore-scripts` where the
   ecosystem supports it).
3. The command comes from the skill (or an explicit operator `--verify-command`),
   never from the repo, the finding or the model. The repo's config (for example
   `.github/zizmor.yml`) is data the verifier reads, not code that selects the
   command.
4. Order: snapshot tree, run baseline on the pre-change tree, apply patch in the
   snapshot, run steps, evaluate `success` and `baseline`. The patch hash is
   recorded; if the agent edits files after verification the result is stale and
   the harness reruns it.
5. Where it runs: a Computer (container image today, VM profiles later; see
   `docs/design/vm-workspace-toolbox.md`). No runtime available gives `not-run`.
   Host execution exists only behind an explicit `--verify-on-host` for the
   operator's own repo and is stamped `isolation: host` in the result.
6. Only harness code can set `verified`. The agent tool is `done(claim)`; the
   harness then runs the verifier. `done` returns the verdict to the agent so it
   can retry within budget.

### 7.3 Result schema (stored with the Finding or fix)

```json
{
  "schemaVersion": 1,
  "status": "pass | fail | not-run | error",
  "reason": "criteria-met | step-failed:zizmor | worse-than-baseline | no-container-runtime | detector-blind | timeout | infra-error",
  "isolation": "container | host",
  "image": "ghcr.io/example/verify-actions@sha256:...",
  "treeBefore": "git-tree-sha", "treeAfter": "git-tree-sha", "patchSha256": "...",
  "startedAt": "ISO-8601", "durationMs": 14200,
  "steps": [{ "name": "zizmor", "cmd": "...", "exit": 0, "durationMs": 9100, "logRef": "artifact://..." }],
  "criteria": [{ "name": "zizmor.json", "expected": "length==0", "actual": "length==0", "passed": true }],
  "baseline": { "status": "pass|fail", "counts": { "findings": 4 }, "after": { "findings": 0 } },
  "liveness": { "checked": true, "ok": true },
  "logs": { "redacted": true, "truncated": false },
  "harnessVersion": "..."
}
```

`Finding.verification: VerifierResult[]` (append-only). `verified` is derived: last
result for the current `patchSha256` has `status: pass`. The harness refuses to set
a finding or fix to verified otherwise (single function, unit-tested; the agent
tools `update_finding` and `save_finding` cannot write that field).

### 7.4 UI and CLI text

```
Verified by: zizmor + actionlint passed, 4 findings to 0 (14.2s)
Verified by: tests passed (14.2s)
Not verified: zizmor reported 2 new findings (attempt 3 of 3)   [View log]
Not verified: no container runtime on this Computer
Not verified: detector did not flag its canary; result discarded
```

`0 findings show <id>` prints the same line; `--json` includes the full record.
PR creation (`--emit pr`, `--publish`) is blocked for unverified fixes unless the
operator passes `--allow-unverified`, recorded on the PR body.

### 7.5 Failure handling

- `fail`: bounded, redacted log tail goes back to the agent; up to 3 attempts, each
  counted in the Thread budget. After that the patch is kept as a draft marked
  Not verified.
- `error` (timeout, OOM, image pull): treated as `not-run`, never `pass`; one retry
  for infra errors only.
- Flaky baseline: run baseline twice (`flake_retry`); if it disagrees with itself,
  the comparison is `error: flaky-baseline`.
- `detector-blind` (canary not flagged): result discarded, shown as error.

### 7.6 The three experiment verifiers

Workflow hardening (scored 7/8 in the experiment):
```yaml
verify:
  steps: [{name: actionlint, run: actionlint}, {name: zizmor, run: "zizmor --config .github/zizmor.yml --format json .github/workflows"}]
  network: none
  baseline: { mode: no-worse, compare: findings-by-fingerprint }
  success: [{step: actionlint, exit: 0}, {step: zizmor, json: "no new findings; target finding gone"}]
  liveness: { canary: { file: .canary/unpinned-action.yml, expect: "zizmor flags it" } }
```
The repo's real zizmor config is what the experiment lacked: the agent used default
rules. The verifier uses the repo file from inside the container.

Dependency fix:
```yaml
verify:
  setup: "pnpm install --frozen-lockfile"      # network allowed here only
  steps: [{name: tests, run: "pnpm test"}, {name: audit, run: "pnpm audit --json --offline-snapshot /advisories"}]
  network: setup-only
  baseline: { mode: no-worse, compare: test-set }   # same tests pass as before
  success: [{step: tests, exit: 0}, {step: audit, json: "target advisory absent; no new advisories"}]
```
The advisory snapshot is mounted read-only so results are reproducible (decision in Q4).

Secrets fix:
```yaml
verify:
  steps: [{name: gitleaks, run: "gitleaks detect --no-git -c /rules/default-extended.toml --report-format json"}]
  network: none
  baseline: { mode: must-fail-before }
  success: [{step: gitleaks, json: "target fingerprint absent"}]
  liveness: { canary: { file: .canary/fake-key.txt, expect: "gitleaks flags it" } }
```
Canary: a generated fake secret in the target's format is placed in the snapshot,
and gitleaks must flag it, or the clean result is meaningless. Rotation of the real
credential stays a human task (reported, not verified).

CI repair would be `baseline: must-fail-before` with the failing CI step as the
verifier (fails before, passes after).

## 8. Tools: a small core plus skill-provided packs

### 8.1 What the model sees today (derived from `agent/tools.ts:7437`, not executed)

- 76 registered tools. Visibility is decided by role, scope and feature flags in
  `getToolsForRole`; access (Read-only or Can make changes) does not hide tools,
  it only changes approvals (`READ_ONLY_TOOLS`, `console/turn-engine/session.ts:375,1168`).
- Default Thread (role `audit`, no scope: "everything" set): the 76 minus about 17
  gated off by default (plan, pty_session, python_exec, analyze_binary, cloud x2,
  oast x2, memsafety_fuzz, npm_dynamic_discovery, weaponize_kernel, cve_adapt,
  run_scanner, proxy, self_extend, remember_codebase, write_todos alias) minus the 2
  legacy delegation aliases: about 57 eligible. Deferral
  (`agent/deferred-tools.ts:40`, threshold 12) advertises 17 immediate names plus
  `list_tools` and `load_tool` on turn one, about 40 behind `load_tool`. So a
  "small core, load the rest" mechanism exists already, driven by a hard-coded
  name list, not by the skill.
- Web discovery/attack roles (`networkTools`): about 32 by default (33 with
  `browser`).
- Scoped source audit: `SCOPED_SOURCE_AUDIT_TOOLS` (`agent/tools/shell-commands.ts:21`),
  about 18 names, read-only: no bash, no run_command, no network, no effectful engines.
- Verify role with a scope: network tools plus file tools (`run_command`,
  `str_replace`, `apply_patch`).
- Report role: 4 common plus 2 skill tools.

Action before any change: add a golden snapshot test that prints the exact tool
names per role x scope x flag set, so counts above become checked facts.

### 8.2 Proposal: core plus packs

Core (about 13, the Pi-style set; plus the deferral control):
`bash`, `read_file`, `list_files`, `search_files`, `str_replace`, `apply_patch`,
`save_finding`, `update_finding`, `query_findings`, `ask_operator`, `update_todos`,
`list_skills`/`load_skill`, `done`. The verifier is not a tool: it is the gate
behind `done`.

Shell-first evidence (`docs/src/content/docs/research/shell-first.md`) is one
XBOW IDOR challenge, marked historical. It supports "bash is enough for some web
tasks", not "only bash for all". So the core is a default, and the A/B in 8.4
decides each pack.

Packs (loaded by `load_tool`/skill `tools:`; a pack never grants authority, scope and
access gates still apply independently):

| Pack | Tools | Order |
|------|-------|-------|
| `cloud` | cloud_s3_probe, cloud_validate_credentials | 1 (off by default today) |
| `oast` | oast_register, oast_poll | 1 |
| `binary-kernel` | analyze_binary, memsafety_fuzz, weaponize_kernel, cve_adapt | 1 |
| `proxy` | proxy | 1 (unadvertised today) |
| `identity` | ad_attack_paths, entra_attack_paths, entra_posture | 2 |
| `research` | variant_hunt, assumption_hunt, spec_drift, protocol_conformance, npm_dynamic_discovery, cve_lookup, assemble_advisory, intel | 2 |
| `llm-apps` | send_prompt, prompt_layer_probe, safety_eval | 2 |
| `authoring` | read/create/save/copy_skill, self_extend | 2 |
| `compute` | python_exec (stateful kernel), pty_session | 2 |
| `fix` | generate_fix, verify_finding (replaced by fix skill plus verifier) | 3 |
| `delegation` | spawn_agent, monitor, send_message, check_messages, report_status | 3 |
| `web` | http_request, crawl, submit_form, access_control_*, browser, payload_lookup, wp_fingerprint, mongo_objectid, js_recon, discover_api_surface, surface_sweep, structural_sqli_probe, auth_boundary_probe, update_target, use_loot, web_search | 4 (highest risk) |
| `ci` | new: workflow lint helpers if the hardening skill needs them | with the skill |

Migration order and risk:
1. Duplicates (8.3) and the golden snapshot. No behavior change on the core path.
2. A skill's `tools:` replaces the hard-coded `IMMEDIATE_TOOL_NAMES`. A Thread with
   no skill keeps today's behavior (core plus deferred catalog). Risk: low.
3. Move packs that are already off by default (rows order 1). Risk: nearly none.
4. Rows order 2 and 3. Risk: prompts and skill text name tools; grep and update
   them; an unloaded tool costs an extra `load_tool` turn.
5. `web` pack last, only after the A/B. It sits on the XBOW and benchmark path
   (`agenticScan` roles use `networkTools`). Web scans keep their current tool list
   until `web-pentest` is wrapped as a pipeline skill and the A/B passes.
Other risks: changing tools changes prompt-cache prefixes, so packs load at turn
boundaries only (the deferral code already says it never mutates a set mid-round);
model behavior is sensitive to tool lists and must be measured, not assumed.

### 8.3 Duplicates and overlaps to merge first

| Overlap | Facts | Merge into |
|---------|-------|-----------|
| `bash`, `run_command`, `pty_session`, `js_eval`, `python_eval`, `python_exec` | six ways to run code. `run_command` is tokenized, no shell (`tools/system.ts:105`); `js_eval`/`python_eval` are "thin wrappers over the same guarded shellExec path as bash" (comment in `tools.ts`); `python_exec` is a stateful kernel (flag off); `pty_session` interactive (flag off) | `bash` with restricted mode chosen by access and scope (replaces `run_command`), `pty` and `stdin` options; drop the two eval wrappers; keep `python_exec` as the only stateful one in `compute` |
| `spawn_agent`, `spawn_agents`, `spawn_persistent_agent` | the last two are already dispatch-only aliases (`LEGACY_DELEGATION_TOOL_NAMES`, `tools/system.ts:40`) | one `spawn_agent` with count and persistent options; delete aliases after the saved-conversation window |
| `update_todos`, `write_todos`, `plan` | `write_todos` is a hidden alias; `plan` is a typed ledger behind a flag | `update_todos` only |
| 6 skill tools | list, load, read, create, save, copy | `list_skills`, `load_skill` in core; the rest in `authoring` |
| `str_replace` and `apply_patch` | two edit tools; `apply_patch` DSL is also the `runSourceFix` proposal format | keep both for now; revisit after A/B |
| `generate_fix`, `verify_finding` | duplicate the fix skill and verifier | retire into the fix skill |
| `oast_register` and `oast_poll` | one workflow | one `oast` tool with an action |

### 8.4 Evidence plan (no regressions)

Arms, same model and version pinned, same machine, runs interleaved:
- A: full tool set as today for the role.
- B: core only.
- C: core plus the skill's packs.

Sets:
- XBOW subset: 20 challenges, stratified by category, fixed list committed with the
  results, including the IDOR case from the shell-first page and some that fail today.
- Fix-experiment repos (the 8 workflow-hardening cases plus dependency and secrets
  repos). Metric is the harness verifier result, not the agent's claim, so
  false "fixed" claims are counted.

Runner: existing bench (`bench/src/xbow-runner.ts`, `--attempt-policy
independent-repeat --pass-at-k N`, `--cost-ceiling`, Wilson intervals in
`wilson.ts`). Record pass rate with Wilson 95% interval, mean cost, turns, tool
calls, tool-description tokens, and verified-versus-claimed gap.

Honesty about size: N=3 repeats on 20 challenges is 60 runs per arm. At a 70% pass
rate that interval is about plus or minus 12 points. This can detect a large loss or
a large cost win; it cannot prove equivalence. Report "no evidence of regression at
this N", not "same". Do not compare against the 93/95 headline; the bench README says
it is not pass@1. Compare arms to each other in one session.

Pre-registered rule: adopt a pack split if arm C's lower bound is no more than 10
points under arm A and mean cost is not higher. Paid model calls: the budget needs
owner approval before the run.

## 9. Migration and proof that benchmark scores do not move

Principle: wrap, do not move. Pipeline skills are descriptors that call the same
function with the same options. Bench runners keep calling `agenticScan` directly,
so the score path is unchanged by construction until a deliberate switch.

Checks, cheapest first:
- A. Option equivalence (no LLM): for every `scan` flag combination in the existing
  tests, assert the `PipelineOptions`/`AgenticScanOptions` built by the old path
  and the skill path are deep-equal.
- B. Prompt identity (no LLM): hash the system prompt of each phase and the tool name
  list per role before and after; any diff must be intentional.
- C. Replay: `executeAssessment` takes injectable dependencies
  (`assessment.ts:81`) and a `nativeRuntime`; run recorded responses through both
  paths and compare findings and event order.
- D. Paid bench: only for steps that change tools or prompts (section 8.4). Not
  needed for wrapper steps if A to C pass.

Risks: `--resume` journals must stay readable across the change (test with an old
journal); events consumed by the web UI must keep their shapes; the Thread-run
envelope must not add latency to `agenticScan`.

## 10. Recurring jobs

Agent = Skill + trigger + budget + access. The Automation stores only the trigger
(schedule, github-pr, manual) and the skill or Agent id. Each run records its
verifier result, so "verified outcomes" become queries: fixes verified this week,
cost per verified fix, rate of Not verified by reason.

| Job | Skill | Verifier |
|-----|-------|----------|
| Verified dependency or alert fix | `dependency-fix` | tests plus audit in a container, baseline no-worse |
| CI repair | `ci-repair` | re-run the failing CI step; must fail before, pass after |
| Workflow hardening | `workflow-hardening` | zizmor with the repo's real config plus actionlint |
| Secrets fix | `secrets-fix` | gitleaks default rules extended, canary check |

The Agent review fingerprint (`sentinels.ts:189`) should also cover the verifier
command and image digest, so editing a verifier forces re-acknowledgement.
Pull requests are only opened for fixes the harness verified (7.4).

### Community library

- A git repo of `skills/<name>/SKILL.md` plus `fixtures/` and `examples/`; install via
  the existing Skills catalog and `0 skills add`; start from `0 skills create
  --template`.
- Promptfoo-style self-test: each skill ships a broken fixture and a fixed fixture
  with expected verdicts. CI requires the verifier to fail on the broken fixture and
  pass on the fixed one. This tests the verifier, not only the prompt.
- Trust for now (signing and provenance later): community skills are `prompt` kind;
  any `verify` block shows its command, image digest and network mode at install,
  needs operator approval, and re-prompts on change (same pattern as the Agent
  fingerprint and plugin permission hashes). The catalog `verified` flag keeps
  meaning "reviewed by us".

## 11. Ranked build plan

| # | Size | Slice | Notes |
|---|------|-------|-------|
| 1 | S | Golden tool-visibility snapshot test; `VerifierResult` type; parse `verify:` frontmatter; "verified" setter that only the harness can call | no behavior change; fake container runner in tests |
| 2 | M | SHIPPED (see fix-verification.md, "Status"). FIRST SLICE: verifier gate on `scan fix` and `threads start --skill workflow-hardening`. Container runner (OCI), baseline compare, patch-hash staleness, `done(claim)` gate, "Verified by" line in UI and `findings show`, `workflow-hardening` skill file | replaces the host `/bin/sh -lc` for this flow; keep `--test-command` working as a step |
| 3 | S | Merge duplicate tools (8.3 rows 1 to 3) | measured by golden snapshot |
| 4 | S | `--skill` on `threads start` and `scan`; skill `tools:` replaces `IMMEDIATE_TOOL_NAMES` | Threads without a skill unchanged |
| 5 | M | `dependency-fix` (also `deps fix --verify`) and `ci-repair` skills | container with setup-only network |
| 6 | S | `secrets-fix` with liveness canary | |
| 7 | M | Agents and Automations reference skill ids; verified-outcome metrics; fingerprint includes verifier | alias old templateIds |
| 8 | M | Pipeline-skill descriptors wrapping `agenticScan` and `runPipeline`; `scan` modules become sugar; checks A to C | no stage code moves |
| 9 | M | Tool packs order 1 to 3; A/B (8.4) | paid runs need budget approval |
| 10 | L | Delete `sourceReview`, `scan()`, `packageAudit`; fold `executeAssessmentRun`; `scan repair` onto skills; `deep-review` to engine; `web` pack after A/B | after bench moved and rerun |
| 11 | L | Community library, templates, fixture self-tests; signing later | |

## 12. Open questions for the owner

1. Is a container runtime a hard requirement for "Verified"? Recommend yes: Docker
   or OCI through the Computer abstraction, `not-run` without it, host execution
   only via an explicit flag stamped `isolation: host`.
2. Should the blind-verify agent keep the word "verified"? Recommend no: rename it
   Corroborated in UI and docs; reserve Verified for harness-run verifiers.
3. Skill format: extend `SKILL.md` frontmatter or add a 0-specific YAML? Recommend
   extend `SKILL.md` (other readers ignore the new keys); leave the 52 built-in YAML
   as knowledge skills until migrated.
4. Does an unverified fix block PR creation, and is the dependency advisory check
   allowed live network? Recommend block by default with a recorded
   `--allow-unverified`, and use a mounted advisory snapshot so results reproduce.
5. Do we cut tools to the core now? Recommend no: land the golden snapshot, merge
   duplicates, move the already-off packs, and decide the `web` pack only after the
   A/B in 8.4 (small N, paid runs; needs your budget).
