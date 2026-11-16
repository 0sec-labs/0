# Lean engine: audit and deletion plan

Status: audit, plus steps 1, 2 and 6a done (see the result sections at the end).
It records what to cut, with measurements, so the cuts can be done in six
reviewable steps. Open: steps 3 to 5, the rest of 6 (the XBOW re-run that unblocks
removing `legacy-bench`), and the single-run-path items listed under 6a.

Direction (owner, 2026-11): "lean down a ton; it can all be skills; clean up;
having all this isn't helping."

The open product is: scan a target, produce verified findings, fix them,
repair CI, harden workflows, run recurring verified fixes, remember what was
learned. Everything that is not on that path is a skill, a plugin, private, or
deleted.

## 1. Method and caveats

- Snapshot: `origin/main` at `a3307ac0` (detached worktree). CLI help was walked
  from the built CLI at `/tmp/fix-exp-wt` (commit `61111f05`, one commit behind
  `main` on docs only) with an empty `HOME`.
- LOC is `wc -l` over `.ts/.tsx` (plus `.mjs/.py/.sh/.md/.css` where noted).
  "Src" excludes `*.test.ts` and `__tests__`. Tests are reported separately.
- Importers come from a regex import graph over `engine/src`, `cli/src`,
  `web/src`, `bench` (relative and `@0/engine` specifiers, tests excluded).
- Static reachability does not discriminate here: `engine/src/index.ts` (1,269
  lines) re-exports almost every subsystem, so 775 of 791 engine files are
  "reachable" from the CLI. Real coupling is shown by the importer counts and
  by import cost (section 4). Only 16 files (1,554 LOC) are unreachable.
- Splits inside a directory (for example `agent`, `stages`, `triage`,
  `disclose`) are estimates from file names and `wc -l` of the named files, good
  to roughly 15 percent. Directory totals are exact.
- "Real use" evidence is limited to what the repo shows (importers, bench
  scripts, docs, git churn since 2026-08-15). There is no production telemetry in
  this audit, so "which runtimes users really run" is inferred, not measured.

## 2. Top-level numbers

| Area | Src LOC (ts/tsx) | Test LOC | Files |
|---|---:|---:|---:|
| `packages/engine/src` | 262,030 | 164,242 (660 test files) | 791 src |
| `packages/cli/src` | 59,900 (commands 27,944; web server 15,018; state 8,586; top-level 6,237) | 46,500 (229 test files) | 99 command files |
| `packages/web/src` | 47,700 | 6,800 | 489 |
| `packages/bench` | 23,500 (ts/mjs, tests included) | included | |
| `scripts` | 15,100 | 79 of 164 files are tests | 164 |
| `docs` | 20,250 | | 68 site pages, 27 design docs |
| `0verse/` (Python/Rust/C research) | 179,800 | 62,900 Python tests | 689 tracked files |

Notes:

- `0verse/` is tracked in this repository but is not in the allowlist of
  `scripts/create-public-source-export.mjs`, so it is already absent from the
  public export. It is private in effect and is out of scope except that it
  should not live in the public repo's git history at all (step 3).
- Engine src by directory (non-test LOC): agent 46,865; stages 30,994; kernel
  22,561; (top-level files) 19,860; triage 19,397; runtime 13,372; identity
  10,415; shared 7,221; plugins 6,612; review 6,509; storage 6,067; disclose
  5,994; improvement 5,591; verify 5,435; console 5,145; research 4,782; bench
  4,771; scope 3,079; intel 2,930; recon 2,483; cve 2,336; secure 2,257;
  telemetry 2,216; adgraph 2,063; agentic 1,944; redteam 1,675; hub 1,460;
  protocol 1,380; events 1,342; xnu-fuzz 1,323; fix 1,040; h1 1,031;
  verification-spec 1,028; memory 1,005; emit 988; unified-pipeline 935;
  integrations 889; ingest 859; attack 816; oast 791; report-formatters 754;
  cloud 684; diagnostics 561; templates 555; mobile 525; specdrift 452;
  agentic-scanner 447; craft-memory 305; graph 158; config 128.

### Bundle size (measured)

The CLI build (`packages/cli/scripts/build.mjs`) is plain `tsc`. The shipped
artifact is produced by `scripts/bundle-cli.mjs` (esbuild) and
`scripts/bun-compile.sh`. I bundled `cli/dist/index.js` with esbuild
(`minify`, metafile, native addons external) and attributed
`bytesInOutput` per input directory.

Total minified: 9.09 MB. Engine 4.13 MB, third-party 2.68 MB, CLI 1.53 MB.

| Contributor | KB (minified) |
|---|---:|
| engine/agent | 897 |
| cli/commands | 619 |
| cli/web (server) | 610 |
| engine/stages | 531 |
| dep: zod | 509 |
| dep: @earendil-works/pi-ai (+ pi-schema 56) | 474 |
| engine top-level | 386 |
| dep: @google/genai | 363 |
| engine/kernel | 351 |
| dep: openai | 278 |
| engine/runtime | 257 |
| engine/review | 244 |
| dep: @anthropic-ai/sdk | 220 |
| engine/triage | 216 |
| engine/identity | 174 |
| engine/storage | 131 |
| engine/improvement | 116 |
| engine/research | 85 |
| engine/bench | 71 |

Existing precedent: `ZERO_EDITION=core` already leaves `identity`, `adgraph`
and `xnu-fuzz` out of the bundle and stubs their commands. The lean plan
generalises that mechanism instead of inventing a new one.

### Startup (measured, Apple silicon, Node, warm cache)

| Measurement | Time |
|---|---:|
| `node -e 0` | 0.07 s |
| `import("@0/engine")` (dist, 776 files, 28 MB) | 0.69 to 0.80 s |
| `0 --version` | 0.90 s |

Per-barrel import time, each in a fresh process: shared 62 ms, runtime 101 ms,
triage 94 ms, verify 108 ms, disclose 84 ms, storage 344 ms, agent 537 ms,
kernel 543 ms, improvement 521 ms, console 532 ms, research 559 ms, ingest 536
ms, bench 523 ms. Everything above about 500 ms pulls the `agent` barrel
transitively. The cost is one tightly coupled cluster (agent, stages, kernel,
triage, storage), not 45 independent subsystems. Two consequences:

1. `0 --version` and `--help` pay the full 0.9 s because the command tree
   imports the engine eagerly. Making command modules lazy is the largest
   startup win and needs no deletion.
2. Deleting a leaf subsystem saves bundle and LOC but little startup. Startup
   improves only when whole clusters (kernel, stages hunt/craft, triage kernel,
   identity) leave the import graph of the default commands.

## 3. Subsystem decisions

Decision key: KEEP, SKILL (prompt plus script run through bash, no engine
code), PLUGIN (separate package, loaded on demand), PRIVATE (moves to the
private monorepo, removed from public source), DELETE.

"Imp" is the count of non-test files outside the subsystem that import it
(engine / outside engine). "Churn" is commits touching it since 2026-08-15
(repository total: 2,104 commits). "Bench" says whether `packages/bench` reaches
it: bench imports only `@0/engine` (19 sites) and `@0/engine/shared` (12 sites),
and its scripts run `--runtime api`. Risk is for the move, not for the idea.
Order is the step number from section 6.

| Subsystem | Src LOC | Decision | Evidence | Risk | Step |
|---|---:|---|---|---|---:|
| agent (core: loop, native-loop, journal, tools core, skills, MCP host, cost, doom-loop) | 35,200 | KEEP | 55 importers; the harness; churn 23 | n/a | n/a |
| agent specialist top-level (egats, auth-boundary-prober, objectid-forge, cve-exploit-codex, llm-probes, input-encoder, payloads, flag-validator, loot, cloud-surface, playbooks, python-kernel) | 5,700 | SKILL | each is prompt or payload logic reached via tool names; only agent imports them | Med: XBOW challenge types may lean on playbooks | 5 |
| agent/tools specialist (offensive-engines, security-engines, 0verse, intel, kernel-run, binary, cloud, exploit, detections, syscall-boundary-map) | 6,000 | PLUGIN | tool registry entries; `0verse.ts` tool targets private tree | Med | 5 |
| shared | 7,221 | KEEP | 500 importers | n/a | n/a |
| storage | 6,067 | KEEP | 71 importers; churn 25 | n/a | n/a |
| events, config | 1,470 | KEEP | 29 and 4 importers | n/a | n/a |
| console (headless chat engine) | 5,145 | KEEP | `hub`, `plugins`, `scope` feed it; churn 16 | n/a | n/a |
| plugins (host) | 6,612 | KEEP (shrink) | one concept per `docs/design/plugins-one-concept.md`; becomes the loader for all section 3 plugins | Low | 5 |
| scope | 3,079 | KEEP | 42 importers; safety rail | n/a | n/a |
| telemetry | 2,216 | KEEP (trim) | 10 importers; run-contribution and analytics-pipeline reference `cloud` | Low | 3 |
| diagnostics | 561 | KEEP | 10 importers (runtime, agent, console) | n/a | n/a |
| report-formatters, templates | 1,309 | KEEP | SARIF/markdown output; `templates` used by scanner | n/a | n/a |
| runtime core (api runtime, llm-api, registry, types, admission, prompt-cache, model discovery) | 6,300 | KEEP | `--runtime api` in all bench scripts; 95 importers of runtime | n/a | n/a |
| runtime/smolvm and workbench (smolvm, broker, darwin, provision, workspace, provider-proxy) | 2,300 | KEEP, lazy-loaded | used by Computers, `verify/replay-runner`, plugin executable; 1 commit in window | Med: sandbox path | 6 |
| runtime/cli-native + claude-tool-bridge + codex-home + codex-models | 1,700 | PLUGIN | only `runtime/index.ts` and `agentic-scanner.ts` import `cli-native`; `claude-tool-bridge` has one importer (`cli-native`) | Med: users on Claude Code or Codex CLI auth | 5 |
| runtime/pi (+ pi-ai 474 KB, pi-schema 56 KB deps) | 2,150 | PLUGIN, then DELETE if unused | imported by `api-runtime.ts` and `runtime/index.ts` only; 4 commits in window (recent) | Med: provider routing for some models | 5 |
| runtime/ollama, runtime/process (generic CLI child runtime, gemini), opencode-go | 940 | DELETE | `gemini` marked "experimental" in the registry; Ollama is reachable as an OpenAI-compatible endpoint through the api runtime; `opencode-go.ts` is 21 lines | Low-Med: local-only users | 2 |
| stages core (web, source-analysis, report, discovery, attack, web-recon-prepass, catalogs) | 3,750 | KEEP | the live scan path | n/a | n/a |
| stages hunt/craft/exploit/invariant/assumption/memsafety/dataflow/variant/graph-slice/evolved-finder | 20,200 | PRIVATE | vulnerability-research pipelines; `research` and kernel adapters are their callers; not needed for fix/triage/CI direction | Med: `evolved-finder` imported by `disclose`; `craft-scan` by `index.ts` | 3 |
| stages lens-synthesis, npm-detectors, novelty-check, recency-hunt, prover, data | 7,000 | SKILL | detector rules and prompts; 120 KB of data files | Low | 5 |
| kernel | 22,561 | PRIVATE | 18 importers, but 10 of them are `triage/*` kernel files that move with it; CLI exposes only `lab research kernel`; core edition precedent | Med: entangled with `triage` kernel oracles and `index.ts` | 3 |
| triage core (auto-triage, can-auto-suppress, semantic-dedupe, impact, verify-verdict, structured-verify, publishability, provenance) | 5,300 | KEEP | direction is triage | n/a | n/a |
| triage kernel/oracle/exploitability/vm/router/userspace-fuzz | 14,100 | PRIVATE | 39 importers in total; the kernel-only ones are used by `kernel`, `research`; `learned-router` and `router` need a check against `agent` first | High: `exploit-stage-gate`, `inline-validation`, `tools` import triage | 3 |
| identity (Entra/AD graph attack) | 10,415 | PRIVATE | 3 importers (CLI `lab research identity`, agent); already excluded by `ZERO_EDITION=core` | Low | 3 |
| adgraph | 2,063 | PRIVATE | 9 of 11 importers are `identity`; core edition excludes it | Low | 3 |
| xnu-fuzz | 1,323 | PRIVATE | importers: research adapter and one CLI command; core edition excludes it | Low | 3 |
| research (adapters, `lab research`) | 4,782 | PRIVATE | 1 importer (`index.ts`); only the hidden `lab` group exposes it; 27 research subcommands | Low | 3 |
| mobile | 525 | PRIVATE | 1 importer (`research`) | Low | 3 |
| protocol | 1,380 | PRIVATE | importers: agent, research, index | Low-Med | 3 |
| h1 (HackerOne client) | 1,031 | PRIVATE | 1 importer (`index.ts`); bounty workflow, not fix/CI | Low | 3 |
| cloud (credentials, windows-evidence-worker) | 684 | PRIVATE | 3 importers, all engine-internal | Low | 3 |
| ingest, craft-memory | 1,164 | PRIVATE | importers are `variant-hunt`, `linux-kernel-profile`, `craft-scan`, all in hunt/kernel | Low | 3 |
| review (source review, intel-driven) | 6,509 | KEEP | `scan source`; 7 importers; keep after trimming `userspace-fuzz` coupling | Med | n/a |
| verify | 5,435 | KEEP | fix verification, replay runner; XBOW flag validation path | Low | n/a |
| fix, emit, secure | 4,285 | KEEP | the fix/PR/repair loop; this is the product | Low | n/a |
| verification-spec | 1,028 | KEEP | consumed by `fix`/`source-fix` | Low | n/a |
| memory, learning-service (top-level 256) | 1,261 | KEEP | "Memory" is a product noun; 5 importers | Low | n/a |
| hub (mailbox, supervisor) | 1,460 | KEEP, re-evaluate | backs Agents; 5 importers; own `DESIGN.md` | Med | 6 |
| disclose (redaction, evidence pack, share-safe) | 2,000 | KEEP | redaction is a safety rail imported by `action-log` and `operational-sink` | Low | n/a |
| disclose (tracker, review, program workflows) | 4,000 | PLUGIN | 8 importers, mostly barrel plus `evolved-finder` | Med | 5 |
| improvement (evolve, bench, routing-qualify, learning; the `lab improve` group) | 4,530 | PLUGIN | only `lab improve` and `stages` (3 files) use it | Med: `executable-plugins` imports it | 5 |
| improvement (unreachable files) | 1,061 | DELETE | not reachable from any entry | Low | 2 |
| bench (corpus, adapters, paired-search-study, evaluation) | 4,574 | PLUGIN | already a separate package (`packages/bench`, 23.5k LOC); engine copies are imported by `config`, `evaluation`, `miss-harvest` | Med: bench path | 5 |
| intel | 2,930 | SKILL | advisory and CVE fetch plus prompts; importers: agent, review, publishability | Low | 5 |
| cve | 2,336 | SKILL | 3 importers; prompt plus HTTP calls | Low | 5 |
| recon | 2,483 | SKILL | 3 importers; scripts around `httpx`/crawl style tools | Med: `web-recon-prepass` in the scan path | 5 |
| specdrift | 452 | SKILL | 2 importers; barrel plus agent | Low | 5 |
| attack (MITRE atlas) | 816 | SKILL (data only) | one importer (`index.ts`); reference tables, not logic | Low | 2 |
| redteam (`0-llm` bin) | 1,675 | PLUGIN | 2 importers (CLI `lab`, `llm-ipi-audit`); separate bin entry | Low | 5 |
| oast (collaborator server) | 791 | PLUGIN | importers: agent, tools, types | Low | 5 |
| integrations (herdr) | 889 | PLUGIN | one importer (`index.ts`) | Low | 5 |
| package audit stack (audit, package-ecosystems, malicious-detector, crypto-misuse, unsafe-deser, suppressor, historical fallback) | 4,200 | PLUGIN | serves `scan package` only; chain `audit` to `package-ecosystems` to `malicious-detector` has no outside importer except `prepare` and `unified-pipeline` | Med: `scan package` stays supported via plugin | 5 |
| legacy scanner stack (agentic-scanner.ts 2,935, unified-pipeline.ts 1,903, racing, eval-runner, pre-recon-cve, api-spec) | 6,900 | DELETE after parity | the code itself labels the old path "legacy loop only"; hidden flags `--dispatch`, `--race`, `--egats` exist only for it; engine barrel and research adapters still import it | High: XBOW may exercise it | 6 |
| agentic/, agentic-scanner/, unified-pipeline/ directories | 3,326 | DELETE after parity | importers are the legacy scanner stack | High | 6 |
| graph | 158 | DELETE | one importer (`graph-slice-hunt-context`, which goes private) | Low | 2 |
| unreachable others (agent 171, bench 197, redteam 84, storage 41) | 500 | DELETE | zero importers | Low | 2 |
| top-level core (agent-runner, engine-service, http, mcp, scanner, scan-plan, prepare, workflow-*, findings-parser, prompts, schemas, remediation, review.ts, index barrel) | 8,700 | KEEP | the service surface | n/a | 6 (barrel) |

### Decision totals (engine src LOC; directory splits are estimates)

| Decision | LOC | Share of 262,030 |
|---|---:|---:|
| KEEP in core | 116,800 | 44.6% |
| PRIVATE | 80,300 | 30.6% |
| PLUGIN | 31,650 | 12.1% |
| SKILL | 21,700 | 8.3% |
| DELETE | 11,850 | 4.5% |

Tests move with their code. Engine tests are 164,242 LOC; the private and
deleted subsystems carry a high test-to-source ratio (kernel 0.54, triage 0.69,
disclose 0.85), so expect roughly 90,000 test LOC to leave the public repo.

## 4. Runtimes

`RuntimeType` today is `api | claude | codex | gemini | ollama` (types.ts), plus
code paths for `pi` (an embedded provider router), `cli-native` with a
Claude tool bridge, `opencode-go`, and the `smolvm` sandbox family. That is 13,372
src LOC in `runtime/` plus about 530 KB of provider SDKs in the bundle.

| Runtime | LOC | Evidence of use | Decision |
|---|---:|---|---|
| api (default; Anthropic, OpenAI, Gemini, OpenAI-compatible, Codex-auth via `llm-api`) | 6,300 | all three bench scripts use `--runtime api`; 95 importers | KEEP. This is the runtime. |
| codex / claude CLI bridges (`cli-native`, `claude-tool-bridge`, `codex-home`) | 1,700 | importers limited to `runtime/index` and `agentic-scanner`; useful for users who only hold Claude Code or ChatGPT credentials | PLUGIN, loaded when `--runtime claude|codex` is chosen |
| pi | 2,150 | two importers; 474 KB plus 56 KB of dependency; 4 recent commits | PLUGIN, delete after parity run if the api runtime covers its routes |
| gemini (process runtime) | in `process.ts`, 457 | labelled experimental; Gemini is available through the api runtime | DELETE |
| ollama | 456 | OpenAI-compatible endpoint works through api | DELETE (keep a doc recipe) |
| opencode-go | 21 | wrapper | DELETE |
| smolvm family | 2,300 | sandbox for Computers and replay, not an LLM runtime | KEEP, lazy |

Answer in one line: five LLM runtimes are advertised, two are real (api, and the
Claude/Codex CLI bridges for users who authenticate that way), `pi` is
redundant until proven otherwise, and `gemini`/`ollama`/`opencode-go` can go
now. Confirm CLI-bridge usage from install telemetry before step 5 (not
available in this audit).

## 5. CLI

Counted from the built help by walking every `--help`:

- Visible tree: 14 top-level commands, 194 command nodes in total, 1,021 flag
  mentions (shared flags such as `--engine`, `--json` are counted per command).
- Hidden `lab` group: 5 children (`research`, `improve`, `console`, `mcp-server`,
  `runs`), 90 further nodes (27 `research` subcommands, 4 `improve`, 9 `runs`),
  635 flag mentions.
- Combined: 284 command nodes, about 1,650 flag mentions.
- Other hidden surface: `--mode`, `--yolo` (console), `--autonomy`,
  `--tool-access` (agents), `--approvals` (moved to a global setting),
  `scan` hidden flags `--race`, `--egats`, `--no-decoy-detection`, `--dispatch`,
  `--branch-from`, `--replay`, `ingest --review-subsystem-fixture`, hidden
  `agents webhook`, hidden `workbench run-agent` and `console-agent`, plus the
  alias tables in `command-aliases.ts` (about 50 moved commands, 20 re-homed
  top-levels, silent renames `chats`, `missions`, `sentinels`, `worker`,
  `automations`).

Duplicates found: `threads` has 20 subcommands, of which `create`, `start`,
`send`, `continue`, `resume`, `retry` overlap; `stop`, `cancel`, `force-stop`
overlap; `close`, `archive`, `delete`, `clear` overlap. `skills` and `plugin`
overlap (`plugin mcp add` equals a skill with a connector; `skills add/import/
link/catalog/copy/new`). `automation triggers` and `agents triggers` are the
same object. `models connections` and `plugin connect` both configure
credentials. `runs` (lab) duplicates `threads` plus `scan` history. `findings
triage memory` duplicates `memory`.

### Minimal CLI (9 top-level, at most 3 subcommands each)

```
0                         opens the web console (replaces `0 web`)
0 scan <target>           auto-detects web / source / package; flags: --depth, --ci, --fix
0 scan fix | verify | disclose
0 findings                list (default) | show <id> | update <id> --status ...
0 threads                 list (default) | send <id|new> | stop <id>
0 agents                  list (default) | run <id> | set <id> ...
0 skills                  list (default) | add <src> | run <name>
0 memory                  list (default) | set | export
0 models                  list (default) | set | connect
0 computers               list (default) | add | stop
0 config                  get (default) | set | doctor
```

Automations fold into `agents` (an automation is an Agent with a schedule or
trigger; versions and rollback live in git). Plugins, MCP connectors and
catalog fold into `skills` (consistent with `plugins-one-concept.md`). `api`
stays as a hidden developer alias of `config get --api`, not a top-level.
Target: 9 top-level, at most 36 nodes, about 300 flag mentions.

### Mapping from every current command

Kept aliases: every row marked "alias" keeps working for one release through
the existing `command-aliases.ts` table with the moved notice, then the rows are
deleted (that file already documents the policy).

| Current | Replacement |
|---|---|
| `scan web`, `scan source`, `scan package`, `scan deep`, `scan repair`, `scan campaign` | `scan <target>` with auto-detect and `--depth` (alias) |
| `scan fix`, `scan verify` | unchanged |
| `scan deps scan`, `scan deps fix` | `scan <manifest>` and `scan fix` (alias) |
| `scan eval`, `scan agent-assure` | delete (benchmark plugin and plugin-provided scan) |
| `scan disclose evidence-pack|track|review` | `scan disclose` with `--pack|--track|--review` flags |
| `findings list|show` | unchanged |
| `findings accept|suppress|reopen`, `findings triage mark-fp` | `findings update --status accepted|suppressed|open|false-positive` (alias) |
| `findings triage memory add|list|remove` | `memory` (alias) |
| `findings export`, `findings reports import|export` | `findings list --format sarif|json|md` and `--import` (alias) |
| `findings keys list|create|revoke` | `config set api.key` and `config get` (alias) |
| `threads list|show` | `threads list [id]` |
| `threads create|start|send|continue|resume|retry|decide` | `threads send` (new id creates; `--resume`, `--retry`, `--decide`) (alias) |
| `threads cancel|force-stop|stop` | `threads stop [--force]` (alias) |
| `threads events|export` | `threads list <id> --events|--export` |
| `threads set|rename|clear|close|archive|delete` | `threads list <id> --set|--rename|--archive|--delete` flags (alias) |
| `agents list|show|presets` | `agents list [id]` |
| `agents create|set|pause|resume|acknowledge|archive|delete|budget` | `agents set` with `--create|--state|--budget` |
| `agents run|activations` | `agents run [--history]` |
| `agents files list|get|put|rm`, `agents triggers *` | `agents set --file|--trigger` flags |
| `automation list|show|run|create|edit|duplicate|delete|triggers` | `agents list|run|set` (alias) |
| `automation versions|rollback` | delete (use git) |
| `models list|default|recommended` | `models list` and `models set` |
| `models connections list|add|test|remove`, `plugin connect|disconnect|connectors` | `models connect` |
| `models usage` | `models list --usage` |
| `computers list|deploy|repair|stop|hosts` | `computers list|add|stop`; `repair` becomes `config doctor` |
| `skills list|show|catalog` | `skills list [name]` |
| `skills new|edit|copy|import|export|link|unlink|add|remove` | `skills add <src|dir>` (and file edits happen on disk) |
| `plugin list|search|browse|info|enable|disable|install|run|init|validate|submit` | `skills list|add|run` (alias; `submit` becomes a docs recipe) |
| `plugin mcp list|add|test|remove` | `skills add --mcp <url>` |
| `memory list|enable|disable|export|import` | `memory list|set|export` |
| `config show|list|get|set|reset|export|import` | `config get|set` (`--all`, `--from-file`) |
| `config audit-log|team init|add-user|list|db repair|db reset|github *` | `config get|set` namespaces (`audit`, `team`, `db`, `github`); `db repair` becomes `config doctor --fix` |
| `doctor`, `doctor upgrade`, `doctor workbench *`, `doctor checks *` | `config doctor` (checks become `skills` with a script) |
| `web` | `0` with no arguments (alias `web`, 23 flags reduced to `--port --host`) |
| `api [path]` | hidden developer alias |
| `lab console` | `threads send --headless` (alias) |
| `lab mcp-server` | `agents run --serve mcp` |
| `lab runs *` | `threads list` and `scan --resume` (alias) |
| `lab research *` (27) | delete from public CLI; ships in the private package |
| `lab improve bench|routing-qualify|evolve|learning` | benchmark plugin CLI (separate package) |
| hidden: `--mode`, `--yolo`, `--autonomy`, `--tool-access`, `--approvals`, `--race`, `--egats`, `--dispatch`, `--no-decoy-detection`, `--branch-from`, `--replay`, `--review-subsystem-fixture` | delete (`--access`, global approvals setting, and `--resume` already replace them); keep `--yolo` and `--mode` one release as documented aliases |

## 6. Web UI

`packages/web/src`: 47,700 LOC of ts/tsx/css (components 11,633; console
19,585; lib 3,527; pages 4,178; ui 3,236; sentinels 538), 6,800 LOC of tests.
`packages/cli/src/web` (the server and API side) is another 15,018 src plus
11,341 test LOC. Plus 51 `scripts/dashboard-*.test.mjs` source-text guard tests.

Routes today: `/chats` (+`/:id`, `/saved/:id`), console controls (settings
routes), `/automations`, `/agents` (+`/:id`), `/api-access`, `/team`,
`/plugins/skills` (+catalog detail), `/plugins/explore`, `/plugins/:id`,
`/memory`, `/scope`, `/findings` (+`/:fingerprint`), `/computers`,
`/runs/:scanId`, plus a table of legacy redirects. 17 lazily loaded pages.
`console-page.tsx` alone is 1,836 lines.

Minimal set (six surfaces):

| Keep | Absorbs |
|---|---|
| Chats (console, with Agents panel, approvals, artifacts) | saved conversation page, console-controls |
| Findings (+ detail, report export) | runs/:scanId report, scans page |
| Agents (incl. automations, triggers) | `/automations`, workflow graph/phase/trigger editors (about 1,030 LOC in `workflow-*` and `automations` components) |
| Skills (incl. plugins, MCP connectors) | `/plugins/explore`, `/plugins/:id`, catalog detail (about 1,110 LOC) |
| Computers | workers page |
| Settings (models, memory, scope, team, API access) | `/memory`, `/scope`, `/team`, `/api-access` as tabs |

Delete: `explore-page`, `saved-conversation-page`, `workflow-graph`,
`workflow-definition-editor`, `workflow-phase-editor`, `whats-new-dialog`,
`sidebar-whats-new-card`, `learning-page` (6 lines), the legacy redirect table
after one release. Estimated web LOC: about 47,700 to about 33,000 (-30%).
CLI-web server: trim in step with the CLI collapse (about -20%).

## 7. Public and private boundary

- `scripts/create-public-source-export.mjs` is an allowlist (`publicRoots`) with
  a short deny list (`excludedPaths`). `packages` is exported wholesale, so
  anything under `packages/engine/src/*` that is not denied is public. `0verse/`
  and `.github/workflows/0verse.yml` are not on the allowlist, so they are
  already not exported.
- `docs/design` is in `excludedPaths`. This document is therefore not part of
  the public export even though it is committed here; check this against the
  intended "public repo" wording before relying on it as public.
- Every PRIVATE move needs two edits in this order: (1) land the code in the
  private monorepo (`0cloud`) so the full edition still builds there; (2) add the
  directory to `excludedPaths` first as a dry run (public CI builds the export,
  which proves nothing public imports it), then delete it from this repo.
- `packages/engine/package.json` has an `exports` map with subpaths including
  `./identity` and `./redteam`; removing code must remove or re-point those, and
  the `bin` `0-llm` entry, or the export builds a broken package.
- `scripts/bundle-cli.mjs` `RESEARCH_PACK_DIST` and
  `packages/cli/src/commands/research-pack.ts` (stub pointers to "the full
  edition") become dead once the packs are private and are deleted in step 3.
- `scripts/check-architecture.mjs` and `scripts/architecture-baseline.json`
  already enforce layering; update the baseline in the same PR as each move.
- `packages/bench/results` and `packages/engine/src/bench/corpus-v1.json` are
  already denied; do not move results into public paths.

## 8. Target architecture

```
                         0 (CLI, 9 commands)            Web (6 surfaces)
                                 \                       /
                               +-----------------------------+
   gateway                     |  engine service / HTTP / MCP |   auth, scope, approvals
                               +--------------+--------------+
                                              |
              +-------------------------------+-------------------------------+
              |  core harness (about 117k LOC)                                |
              |  agent loop + native-loop + journal + tool registry           |
              |  scan stages (web, source) -> triage core -> verify -> fix    |
              |  storage, events, memory, scope, redaction, cost, telemetry   |
              |  runtime: api (default) + smolvm sandbox (lazy)               |
              +--------+----------------------+-------------------+-----------+
                       |                      |                   |
        skills (SKILL.md + scripts,    plugins (packages/plugin-*,   private monorepo
        run through bash)              loaded on demand)             (not shipped)
        intel, cve, recon, specdrift,  cli-bridges (claude/codex),   kernel, identity,
        lens-synthesis, npm detectors, pi (temporary), package-audit, adgraph, xnu-fuzz,
        agent playbooks and probes,    disclose workflows, redteam,  research, stages
        MITRE data                     oast, integrations, bench +   hunt/craft, h1,
                                       improvement, specialist tools protocol, cloud
```

Rule: a capability is a skill if a prompt and a script through bash are enough.
It is a plugin only if it needs a long-lived process, credentials handling, or a
typed tool. It is private if it is vulnerability research or offensive material
the open product does not depend on.

## 9. Estimated savings

| Metric | Today | After | Basis |
|---|---:|---:|---|
| Engine src LOC (public) | 262,030 | about 116,800 core, about 53,350 as skills and plugins (separately versioned) | decision totals |
| Engine tests LOC | 164,242 | about 74,000 core | test ratio of moved subsystems |
| Public repo, all engine src left in `packages/engine` | 262,030 | about 117,000 to 170,000 depending on whether plugins stay in-tree | |
| CLI nodes / flags | 284 / about 1,650 | 36 / about 300 | section 5 |
| Web src LOC | 47,700 | about 33,000 | section 6 |
| Default bundle (esbuild, minified) | 9.09 MB | about 5.3 to 5.8 MB | estimate: removal of kernel 351, identity 174, research 85, bench 71, improvement 116, about 75% of stages (400), about 70% of triage (150), disclose workflows (40), agent specialists (about 225), pi-ai plus schema 530, runtime CLI bridges (about 100), CLI commands about -55% (340), plus partial provider SDK dedupe |
| `0 --version` / `--help` | 0.90 s | about 0.20 s | lazy command modules (shared plus commander only) |
| `import("@0/engine")` | 0.69 to 0.80 s | about 0.40 to 0.45 s | module count 776 to about 380 once the kernel, stages hunt and triage kernel clusters leave the default graph (estimate) |

The bundle and startup rows are estimates, not measurements. Re-measure with the
same esbuild metafile script after each step and store the numbers in the PR.

## 10. Safe deletion sequence (six PR-sized steps)

Each PR must pass the existing gates (`pnpm -r build`, `pnpm -r test`,
`scripts/check-architecture.mjs`, `scripts/check-docs-commands.mjs`) plus the
step-specific proof below.

1. **Baselines and lazy commands (no deletions).** Record: esbuild metafile
   sizes, startup timings, a snapshot of every `--help` (all 284 nodes), a hash
   of the tool schemas exposed to the model, and a hash of each stage prompt.
   Make command modules lazy so `--version` and `--help` do not import the
   engine. Proof: help snapshot, tool-schema hash and prompt hashes are
   byte-identical; `0 --version` under 250 ms.
2. **Delete the dead and the duplicate.** The 16 unreachable files (1,554 LOC),
   `graph/`, `runtime/ollama` + `process` (gemini) + `opencode-go`, hidden
   scan flags and hidden aliases that nothing documents, `attack` as a barrel
   export (data moves to a skill later). Proof: `tsc`, tests, architecture
   baseline; help snapshot differs only by the removed hidden flags; the bench
   scripts' `--runtime api` still starts.
3. **Move research and offensive material to private.** `kernel`, `identity`,
   `adgraph`, `xnu-fuzz`, `research`, `mobile`, `h1`, `protocol`, `cloud`,
   `ingest`, `craft-memory`, `stages` hunt/craft/exploit set, triage
   kernel/oracle set, `lab research`, `0verse/` history, edition-stub code. Do
   it per directory: copy to the private monorepo, add to `excludedPaths` in a
   dry-run PR, then delete. Proof: public export builds and tests green;
   private full edition builds from the same sources and its tests pass;
   `ZERO_EDITION=core` bundle is byte-identical to the new default except for
   the removed stubs; XBOW subset parity (section 11).
4. **Collapse the CLI to 9 commands.** New command tree, `command-aliases.ts`
   extended so every row in the section 5 table resolves with identical
   arguments for one release; delete `lab`. Proof: a generated table test runs
   every old invocation through the alias layer and asserts the resolved argv
   and exit code against the new tree; `check-docs-commands.mjs` passes on the
   rewritten docs; installed-binary smoke (`scripts/cli-process-smoke.test.mjs`).
5. **Extract skills and plugins.** Skills: intel, cve, recon, specdrift, lens
   synthesis, npm detectors, agent playbooks and probes, MITRE data. Plugins:
   cli-bridges, pi, package-audit, disclose workflows, redteam, oast,
   integrations, improvement, bench, specialist tools. The plugin loader is
   lazy and keeps `engine/package.json` subpath exports re-exporting from the
   plugin for one release. Proof per extraction: golden run of the old tool and
   the new skill or plugin on the same fixtures with identical output; the
   tool-schema hash differs only by the listed moved tools; plugin missing gives
   a clear install message instead of a crash.
6. **Delete the legacy scanner, trim the web UI, cut the barrel.** Remove
   `agentic-scanner`, `unified-pipeline`, `agentic/`, `racing`, `eval-runner`
   after the native loop reproduces XBOW results; remove the web pages and
   components in section 6; replace the 1,269-line `index.ts` barrel with a
   small public API (keep a compat re-export that `packages/bench` uses until its
   19 root imports are updated). Proof: XBOW parity (section 11); Playwright
   smoke of the six surfaces; `.d.ts` diff of the public entry lists exactly the
   removed names.

Order is chosen so the cheap, provable cuts come first (steps 1 to 3 remove
about 90,000 LOC with no behaviour change on the scan path), the user-visible
change (step 4) lands before the riskiest runtime change (step 6).

## 11. Benchmarks: what can break and how to prove parity

What the benchmark path touches: `packages/bench` imports only `@0/engine`
(19 sites) and `@0/engine/shared` (12 sites); its scripts pin `--runtime api`;
XBOW (104 challenges, `xbow-runner.ts`), CyberGym, Cybench, PicoCTF and
HarmBench runners live there; `honest-eval.ts` and `bench/results/*` (ledger,
`xbow-canonical.json`) hold the reference numbers.

What could break:

1. The root barrel: bench's 19 root imports break if names disappear (step 6).
2. The legacy loop: `--race`, `--egats`, `--dispatch` and `racing.ts` may be
   what some XBOW or CTF configurations used (the flags are described as
   "benchmark/CTF only"). Deleting them silently changes a baseline.
3. Playbooks and specialist tools (`playbooks.ts` 1,537 lines, `egats.ts`,
   `flag-validator`, `input-encoder`, `payloads`, `loot`) are model-visible
   context. Moving them to skills changes tool lists and prompts, which changes
   scores even if code is equivalent.
4. `stages` data files and `intel`/`recon` prepasses feed prompts for web
   targets.
5. Runtime defaults: removing `pi` or gemini/ollama paths changes provider
   routing and prompt-cache behaviour.
6. Sandbox: `smolvm` and replay paths are used for verification; making them
   lazy can change timeouts.

How to prove parity:

- Structural proof (every step, free): tool-schema hash per run mode, system and
  stage prompt hashes, the CLI help snapshot, `.d.ts` diff. A step that claims
  "no behaviour change" must leave these identical.
- Deterministic replay: use recorded model transcripts from the journal
  (`agent/journal`) as a fake provider and compare the event stream and findings
  set before and after. This isolates harness changes from model variance.
- Statistical proof (steps 3, 5, 6): run a fixed XBOW subset (for example 30
  challenges, pinned model, 3 seeds) on `main` and on the PR; compare solve rates
  with the Wilson intervals already in `bench/src/wilson.ts`; require the
  intervals to overlap and no previously solved challenge to regress in all three
  seeds. Run the full 104 once before step 6 and once after, and record both in
  `benchmark-ledger.json`.
- Cost and latency guard: compare tokens and wall time per challenge; startup
  and bundle numbers from section 9 recorded in each PR.
- Rollback: each step is a separate PR with no data migration, so reverting a
  step restores the prior behaviour.

## 12. Open questions for the owner

- Confirm that triage and recurring verified fixes are the product direction, so
  `triage core`, `verify`, `fix`, `emit`, `secure` stay in core as assumed.
- Confirm whether users depend on the Claude/Codex CLI bridges (plugin) or `pi`
  (delete); this needs install telemetry that is not in this audit.
- Decide whether `hub` (Agents mailbox and supervisor) belongs in core.
- `docs/design` is excluded from the public export; decide whether this document
  should be public.

## Baselines (step 1, measured 2026-11-15 on `origin/main` at `f3059e0f`)

Method: worktree build, `HOME` set to an empty temp dir, Apple silicon, Node, warm
cache, 10 runs each, median reported. The bundle is the real `scripts/bundle-cli.mjs`
output (esbuild, `splitting`, not minified: the script does not minify), so the sizes
below are comparable between steps but not with the minified 9.09 MB in section 2.

| Measurement | Before step 1 | After step 1 |
|---|---:|---:|
| `dist/` JS total (`0.js` plus chunks: 188 before, 293 after) | 15,831,311 B | 15,944,004 B (+112,693: manifest, more and smaller chunks) |
| `0 --version` (bundle) | 0.721 s | 0.151 s |
| `0 --help` (bundle) | 0.724 s | 0.157 s |
| `0 doctor --help` (bundle) | 0.726 s | 0.665 s |
| `0 --version` (tsc output `packages/cli/dist/index.js`) | 0.946 s | not re-measured |

What changed in step 1: `index.ts` is now a thin entry that answers `--version` and the
bare root `--help` from `@0/engine/shared` and a static manifest of the 15 top-level
commands (`commands/manifest.ts`); everything else continues in `main.ts`, which builds
only the invoked top-level command through `commands/lazy-tree.ts`. Every other
top-level name is a stub (name, aliases, description) so root help, suggestions and the
known-command check are unchanged. `commands/tree.ts` stays the eager, complete tree used
by the docs scripts and tests. `0 doctor --help` is still about 0.67 s: the section loads
`doctor.ts`, and `main.ts` still imports the engine barrel for telemetry and settings
before any command runs. Moving that setup behind the command is a later step.

Behaviour notes for the fast path: `0 --version` and `0 --help` no longer run the
workbench boundary check, the startup update or the telemetry notice (they print and
exit). Deprecated environment aliases still apply and warn once (covered by
`scripts/cli-process-smoke.test.mjs`); `apply-env-aliases.ts` now imports the narrow
`@0/engine/config/deprecated-env` subpath instead of the barrel.

Help snapshot: `packages/cli/src/commands/__tests__/__fixtures__/help-snapshot.txt` holds
the help of all 293 command nodes (visible and hidden, width 100). `help-snapshot.test.ts`
compares it with the eager tree and with the lazy tree, and checks that the static root
help equals the real root help. A step that removes a flag or command shows up as a diff
of that fixture; regenerate with `UPDATE_HELP_SNAPSHOT=1`. The 13 argv forms
(`--help`, `-h`, `help`, `--version`, `-V`, `help scan`, `scan --help`, `scan web --help`,
`doctor --help`, `lab runs --help`, `automations --help`, `worker --help`, an unknown
word) printed byte-identical output and exit codes before and after.

Tool schemas: `Object.keys(TOOL_DEFINITIONS)` has 76 entries; sha256 of
`JSON.stringify(TOOL_DEFINITIONS)` starts `6e584517029311c4`. This is recorded here and
not as a golden test on purpose: the core toolset is being changed in parallel, and a
golden test would fail that work without telling it anything. Stage prompt hashes are
not recorded (no cheap single entry point; the structural proof for later steps is the
help fixture and this tool hash).

## Step 2 results (dead and duplicate code, re-proved on `origin/main` after step 1)

Every candidate was re-checked by grepping importers across `packages`, `scripts`,
`docs`, `.github`, `action.yml`, the engine `exports` map and
`scripts/create-public-source-export.mjs`. Only what survived the check was deleted.

Deleted:

| What | LOC | Proof |
|---|---:|---|
| `engine/src/runtime/ollama.ts` (`OllamaRuntime`) | 456 | Sole importer was `runtime/index.ts` (`createRuntime`, barrel). `--runtime ollama` was documented, so it now fails with "removed in 0.35: use an OpenAI-compatible endpoint with --runtime api" (`shared/removed-runtimes.ts`, covered by `removed-runtimes.test.ts` and the `run.test.ts` gating test). The Ollama provider, `local-ollama-routing` and the web connection UI use the OpenAI-compatible path and are untouched. |
| `runtime/ollama.test.ts` | 445 | Tests only the deleted class. |
| Gemini branch of `runtime/process.ts` (usage reader, CLI map, stream parser, argv builder) and its test | 47 | `ProcessRuntime` still serves `claude` and `codex`; only the `gemini` type is gone. `--runtime gemini` gets the same removal error. |
| `ollama` and `gemini` registry entries, stage preferences, `RuntimeType`/`RuntimeMode` members, legacy auto-pick of the Gemini CLI, bench variant/evidence allow-lists, `--runtime` help text on 8 commands, 5 docs pages, engine README | about 110 | `tsc` for engine and cli; the help fixture shows only those `--runtime` lines changing. |

Skipped, with the reason:

- The 16 "unreachable" files (1,554 LOC; 14 files and 1,428 LOC by my regex graph,
  which also treats the `exports` map and the `0-llm` bin as entries). Not dead:
  `improvement/registry.ts` and `provenance.ts` hold their names in source-snapshot
  allow-lists and hash them, `scripts/security-evolution-study/summary-ablation.mjs`
  imports `development-summary` from `dist`, `docs/design/security-evolution-offline-studies.md`
  documents the studies, each has a test, and the three `__fixtures__` files are child
  processes spawned by tests. `agent/tools/syscall-boundary-map.ts` is also inside the
  area another change owns. They stay until the improvement group moves in step 5.
- `graph/` (158 LOC): imported by `stages/graph-slice-hunt-context`; goes with step 3.
- `runtime/opencode-go.ts` (21 lines): not a runtime wrapper. It detects OpenCode Go
  endpoints and holds published context windows used by `llm-api`; the changelog lists
  recent fixes to it.
- `runtime/process.ts` as a whole: it is the `claude` and `codex` CLI runtime.
- `attack/` barrel export: `cli/src/commands/timeline.ts` and `formatters/timeline.ts`
  import the technique lookups through `@0/engine`.
- Hidden flags `--race`, `--egats`, `--dispatch`: the plan itself ties them to the legacy
  scanner (step 6) and section 11 warns they may sit behind benchmark baselines.
  `--no-decoy-detection`, `--branch-from`, `--replay` are documented in the generated
  command reference and covered by `scan.test.ts`; `--review-subsystem-fixture` is used by
  `scripts/kernel-validator-e2e.sh`. `--mode`, `--yolo`, `--autonomy`, `--tool-access`
  untouched (the plan keeps `--yolo` and `--mode` one release).

## Step 6a results (one run path: what is done, what is not)

Done:

| What | Proof |
|---|---|
| Deleted `sourceReview`, `SourceReviewOptions`, `resolveRepo`, `runReviewAgent` (about 540 LOC of `review.ts`) and its kernel-seeds test (about 130 LOC); removed the `sourceReview` barrel export and README row | Re-grepped `packages`, `scripts`, `docs`, `.github`: no importer outside its own two tests. Not in the engine `exports` map. The prompt builders `buildCliReviewPrompt` and `buildTargetHistoryPreseedBlock` stay with their tests (`review.kernel-prompt-recipes`, `review.target-history-preseed`); they are now only test-reached and are candidates for step 3 with the kernel profiles. |
| Moved legacy `scan()` (`scanner.ts`) and the `packageAudit` family (`audit.ts`) with their tests to `engine/src/legacy-bench/`, one entry (`legacy-bench/index.ts`), marked `@deprecated`. Root barrel names `scan` and `packageAudit` still work | Pure move plus import-path rewrite: `tsc` clean for engine, bench and cli; the moved test files (audit, per-file loop) pass unchanged. |

Not done, with the reason:

- `executeAssessmentRun` keeps its one-node workflow. It is not a no-op wrapper:
  `executeWorkflow` is what enforces the run deadline, the cost ceiling (including
  unpriced-usage abort), cancellation, the `time_cap_exceeded` / `cost_ceiling_exceeded`
  exit reasons and the `withWorkflowAuditExecutionPolicy` scope, and its
  `WorkflowRunResult` plus `onStart`/`onComplete` lifecycle feed the retained
  execution record that `commands/run.ts` writes (`workflowRunId` in the report).
  Calling `executeAssessment` directly would drop those. Folding needs `run.ts` to own
  persistence, which is in the CLI collapse.
- `runSourceFix` is already one function. Its three callers (`commands/fix.ts`,
  `web/workflows.ts`, Thread tool `generate_fix`) differ in runtime wrapping (budget and
  policy), progress, `keepWorktree` and scope authorization, not in how the fix runs.
  Two of them sit in areas under concurrent change; merge after the CLI collapse.
- `runDeepReview` stays in `cli/commands/deep-review.ts` (about 1,050 lines of loop plus
  CLI formatting). Moving it into the engine is not small, and the file is being edited.
- Bench runners still call `scan()` and `packageAudit`. `scan()` is a different staged
  pipeline (own prompts, stage runtimes and tool sets) from `agenticScan`, so no no-LLM test
  can show equal ScanConfig, prompt hashes and tool lists. Removal is blocked on re-running
  the XBOW subset and the npm bench through `executeAssessment` and accepting the new
  baselines.

## Step 4 results (CLI collapse)

Visible tree: 15 top-level commands (14 plus hidden `lab`) and 292 nodes became 9 top-level
commands with at most three visible subcommands each (36 visible nodes). Nothing was deleted:
the old nodes stay registered and hidden, `command-compat.ts` translates the new grammar onto
them and prints `moved: use ...` for old invocations; `command-compat.test.ts` resolves every
one of the 292 old nodes (`__fixtures__/legacy-commands.txt`). Deleting the hidden nodes is the
work of the release after 0.35.

Choices where this document left room:

- `web`: bare `0` opens the console and accepts every old web flag (not only `--port --host`),
  because `--headless`, `--server-mode` and `--ready-json` are the deployment surface.
- `automation` folds into `agents` as `--automation` on `list`, `run` and `set`: Agents and
  automations are still separate objects in the engine, so the flag says which one.
- `plugin connect|disconnect|connectors` go to `skills add --connect|--disconnect` and
  `skills list --connectors` (connectors are skills), not to `models connect`.
- `scan deep|repair|campaign|deps` are `scan <target> --module ...`; `--depth` keeps meaning
  review depth because the modules are different engines.
- `lab` is kept hidden and working: `lab research` and `lab improve` have no destination
  until steps 3 and 5, and `lab console|mcp-server|runs` have no replacement verbs yet.
- `doctor` stays as a silent permanent alias of `config doctor`; `api` stays a hidden command.
- `computers add` is the command and `deploy` its alias.
