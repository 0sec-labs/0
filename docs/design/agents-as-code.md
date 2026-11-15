# Agents as code

Status: first slice built (2026-11-15). Parser, schema, `0 agents validate|diff|apply|export`, folder apply at server start, managed-by-file marker and the web note are in. `0 agents run <file> --once` is a follow-up. Facts about today's code were read from `main`.

## Problem

An Agent is created in the app or with `0 agents create`, and its definition lives in a local database. That makes persistent Agents hard to review, hard to copy to a server, impossible to roll back with git and invisible to CI. Teams already treat Dependabot, Renovate, Semgrep and Promptfoo this way: a file in the repository is the definition, a pull request is the review, and the tool applies it. The goal is the same for Agents: a file defines an Agent; it is created, updated, validated and exported from it, locally, in the Docker image and in CI.

## Prior art

| System | Format | Strengths | We copy | We avoid |
| --- | --- | --- | --- | --- |
| GitHub Agentic Workflows (`gh aw`) | Markdown body with YAML frontmatter, compiled to `.lock.yml` | Prompt in prose, settings in frontmatter; `strict` mode on by default; read-only agent job, writes only through declared `safe-outputs` with per-output `max`; fork handling controls; `gh aw validate`; no secrets in `env` (strict mode error) | The file shape; validate as its own command; writes limited to what the file declares and the operator allows; secrets rejected at validation | A compile step and a generated lock file: our apply reads the file directly and stores the digest |
| GitHub Copilot custom agents (`.agent.md`) | Markdown plus frontmatter (`name`, `description`, `tools`, `model`, `target`, `mcp-servers`) | Repository, organization and enterprise levels; lowest level wins; versions are the commit SHA; body up to 30,000 characters | Required `description`, charter in the body, identity from the file | Silent field coercion; `$VAR` and `${{ secrets }}` references inside the file |
| Claude Code subagents (`.claude/agents/*.md`) | Markdown plus frontmatter (`name`, `description`, `tools`, `model`, `permissionMode`, `skills`, `memory`) | Same shape; trust gates: inline hooks and servers in a repository folder load only after the folder is trusted; plan mode wins over a file's own mode | The shape; a file never widens what the session already allows | Unknown fields ignored silently (we make them errors); permission mode as a free file field |
| Promptfoo | `promptfooconfig.yaml`, red-team config, `promptfoo-action`, `code-scan-action` | A config file in the repository is how it spreads; CI action runs on `pull_request` for changed paths and comments on the pull request; secrets stay in the environment, never in `config.env` | A repo-resident file plus a CI recipe that triggers on path changes; PR comment output | Environment templating resolved at load time inside the file |
| pydantic-ai agent specs | YAML/JSON spec loaded with `Agent.from_file` | Spec as data, loadable and shareable | Spec as data with one parser | Code references inside specs |
| Oracle Open Agent Spec | JSON/YAML, versioned language spec, adapters to several frameworks | A portable, versioned, runtime-neutral component description | A version field and a published schema | Runtime-neutral generality we do not need |
| kagent | Kubernetes `Agent` CRD (`apiVersion: kagent.dev/v1alpha2`, `spec.declarative`) | `apiVersion` and `kind`; secrets only by reference (`secretKeyRef`); secrets excluded from prompt templates | `apiVersion` and `kind`; secrets never inline | CRD and cluster machinery |
| Semgrep, Renovate, Dependabot | `.semgrep.yml`, `renovate.json` with `$schema`, `dependabot.yml` | Config in the repository; `renovate-config-validator` and a `$schema` URL for editors; presets | A published JSON Schema, a validator command, an editor hint line | Remote presets that can change behaviour without a commit |
| Terraform | Plan and apply | `plan -detailed-exitcode` (0 none, 1 error, 2 changes); `-json`; refresh detects drift; saved plans contain secrets in clear | `diff` is a dry run of apply, with `--json`; drift is a first-class report | Binary saved plans; state files holding secrets |
| Kubernetes declarative apply | `kubectl apply`, `diff`, `--prune` | Idempotent; three-way merge so live-only fields survive; prune only with a label selector or ApplySet; server-side apply tracks field owners | Idempotent apply; ownership marker per object; prune scoped to what the same source created | Label-wide prune; merging live fields silently |
| OpenAI Agents SDK, CrewAI | Code or YAML for agents and tasks | Declarative roles and goals | Charter and role as prose | Agent definitions that execute code |

Three findings shaped the design. First, every successful system keeps the prompt as prose in the file and the settings as validated data beside it. Second, the failures are all trust failures: a file that can name secrets, widen its own permissions, or run from a pull request with write access. Third, apply semantics matter more than the format: idempotency, a dry run that is the same code path, an ownership marker and prune that is scoped to what the tool created.

## Chosen architecture

1. **One file per Agent: Markdown with YAML frontmatter.** The body is the charter (the Agent's `AGENTS.md`). The frontmatter is a strict, versioned schema. No compile step.
2. **One parser, one schema, no second store.** `shared/agent-file.ts` holds the zod schema. The parser, the serializer and the published JSON Schema (`docs/public/schemas/agent.v1.json`, golden-tested) all derive from it. Files apply to the existing Agent store; the only addition is a `managedBy` marker on the stored Agent.
3. **Apply is a console route, not a file reader in the server.** The CLI reads files and sends their text to `POST /api/console/sentinels/plan|apply`. That reuses auth, roles and audit, works attached to a running server or embedded against the database, and means the server never reads arbitrary paths. Server mode reads one operator-configured folder through the same code.
4. **Plan and apply share one code path.** `diff` is `apply` with writes off. Validation of every file happens before the first write.
5. **Files own the Agents they manage; the app owns the rest.** A marker records the file id, path, folder, content hash and a digest of the Agent's portable state at the last apply. A digest mismatch later means "edited in the app".

Rejected alternatives:

- **YAML or JSON only, charter in a string.** Poor for the part people edit most, and unreviewable in diffs.
- **Compile to a generated lock file (`gh aw` style).** Adds a step and a second artifact; our apply is already deterministic.
- **A Kubernetes-style controller that watches a repository.** Needs credentials and network access to the repository, which makes the server a pull-request-controlled system.
- **Two-way sync.** Conflicts without a merge UI. We chose one direction per Agent and make the switch explicit (adopt, export).
- **Putting the marker in a virtual file.** Visible to the Agent and editable by it. The marker lives in the stored record and cannot be set through the API.

## What exists today

Stored in `sentinel_json` rows (`sentinels` table) plus virtual files, triggers and automations. Direction applies to Agents managed by a file; unmanaged Agents are always edited in the app.

| Field | Stored in | Portable | Direction when managed |
| --- | --- | --- | --- |
| `name`, `mission` (file: `description`), `role` (file: `preset`) | Agent record | Yes | File to instance |
| `autonomy`, `toolAccess` (file: `access`, `web`) | Agent record; new writes store only `observe` or `act` | Yes | File to instance; older `propose` and `run` read as `changes` and are not rewritten when equal |
| `skills`, `scope` (repos, targets, domains, outOfScope) | Agent record | Yes | File to instance |
| `scope.production` | Agent record | No | Never from a file; off unless an operator turns it on in the app |
| `budget` (daily USD, runs per day) | Agent record; older per-run caps dropped on read | Yes | File to instance |
| `memory` (enabled, autoLearn) | Agent record | Yes | File to instance |
| `model`, `notifications`, `avatar` (color, icon) | Agent record | Yes | File to instance when the file names them; left alone when absent |
| `status` | Agent record | Yes, as `paused` or `active` | File to instance, except a budget pause is never cleared by apply |
| `AGENTS.md` | Virtual file with revisions | Yes (the body) | File to instance, new revision authored `file:<path>` |
| Triggers (schedule, manual, github-pr) and the automations they start | Trigger rows and workflow definitions | Yes (`triggers`) | File to instance; automations apply created are removed with the trigger, adopted ones are kept |
| `NOTES.md`, `handoffs/`, `reports/`, other files | Virtual files | No (memory contents) | Instance only |
| `hostId`, avatar upload, `emoji`/`initials` | Agent record | No | Instance only |
| `id`, `version`, `owner`, timestamps, `homeMissionId`, `reviewedFingerprint`, `pauseReason` | Agent record | No | Instance only |
| Activations, run history, costs, findings, Threads | Separate tables | No | Instance only |
| Connections and credentials | Credential store | Never | Never; files containing secrets are rejected |
| `automationIds`, legacy `crew`, hidden `CREW.md` | Older shims | No | Ignored on export; not rewritten |

Storage note: Agents are JSON blobs with legacy shims and no schema version. This slice does not migrate storage. A storage migrator with a stored `schemaVersion` is a follow-up; until then the file carries the version (`apiVersion: 0security/v1` is the file schema version) and export reads old shapes through the existing normalizers, which is why re-applying an exported old Agent is a no-op.

## File format

```markdown
---
# yaml-language-server: $schema=https://docs.0security.com/schemas/agent.v1.json
apiVersion: 0security/v1          # file schema version
kind: Agent
id: pr-security-reviewer          # stable slug: the identity across applies and renames
name: PR Security Reviewer
description: Reviews each pull request diff for vulnerabilities and drafts comments.
preset: pr-security-reviewer
access: changes                   # read-only | changes
web: false                        # Read-only Agents only
status: paused                    # paused | active
skills: [pr-diff-review, command-injection]
scope:
  repos: [your-org/your-repo]
  targets: []
  domains: []
  outOfScope: []
budget:
  dailyUsd: 5
  maxRunsPerDay: 30
memory: true                      # or { enabled: true, autoLearn: false }
model: { provider: anthropic, model: claude-sonnet-4-5 }   # a hint
triggers:
  - on: schedule
    id: weekly
    template: repository-review
    frequency: weekly
    weekday: 1
    time: "09:00"
    timezone: Europe/Zurich
  - on: github-pr
    repo: your-org/your-repo
    baseBranch: main
    commentOnPr: true
    includeForks: false
---

# PR Security Reviewer

(the charter, written to the Agent's AGENTS.md)
```

Rules: YAML 1.2 core schema only, no tags, anchors, aliases or merge keys; unique keys; unknown keys are errors with line numbers; at most 128 KiB per file, 32 KiB of frontmatter and a 64 KiB charter; NUL bytes rejected. `instructions: path.md` may name a charter file next to the file; absolute paths, `..` and symbolic links out of the folder are refused. Keys that look like secrets (`apiKey`, `token`, `password` and similar) and values that look like credentials are rejected without echoing them; use connections. Whether an Agent asks before running commands is the global **Ask before running commands** setting, not a file field. The budget fields are the ones the runner enforces today (a daily cap and a run count), not per run or per month.

## Identity and ownership

- `id` in the file maps to the instance Agent through the `managedBy` marker: `{ id, path, root, hash, appliedAt, stateHash, triggers }`. Renaming (`name`) keeps the Agent. Changing `id` creates another Agent and, with `--prune`, removes the old one. Moving a file keeps the Agent as long as `id` is unchanged; the marker then records the new path.
- The marker cannot be written through the API: create and patch bodies are strict and reject it.
- Match rules on apply: by `id` first. Otherwise, if an unmanaged Agent has exactly the same name, apply reports "would create a duplicate named X: use --adopt or rename". With `--adopt` it takes that Agent over. Several unmanaged Agents with one name are never guessed between, except that exported files carry the Agent's short id as a suffix and match that Agent.
- Marker triggers map a file trigger `id` to the stored trigger, with `created: true` when apply made its automation, so apply never deletes an automation a person built.

## Sync with the Agents people already have

- **Adopt.** `0 agents export --all --dir .0/agents` writes a file for each Agent (presets that were instantiated, and hand-made ones) with unique ids. Export changes nothing. `diff --adopt` shows no differences for an unedited Agent. `apply --adopt` sets the marker only.
- **Two states.** Defined in the app (the Agent is the source) or Managed by a file (the file is the source). The Agents list shows `DEFINED IN` and the page shows `Managed by .0/agents/x.md`, plus `edited since last apply` when the stored digest no longer matches.
- **Drift.** `diff` lists every field that differs, instance value to file value. `apply` refuses to overwrite a managed Agent that was edited in the app unless `--force`. Accepting the edit into the file is: export, commit, apply; the apply is a no-op and refreshes the digest.
- **Lossless.** Export maps older stored values through the existing normalizers. The golden round-trip test seeds a store in older shapes (stored `propose`, `run`, `observe`, `act`, per-run budget caps, a removed `crew` block, an emoji avatar, a hidden `CREW.md`, shared names, an unmanaged automation), exports, applies with `--adopt`, and asserts no differences and that no stored Agent, trigger or workflow was rewritten.

## Commands

All under `0 agents`; no new top-level command. All take `--json`.

- `validate <path...>`: parse only. Exit 1 on any error. Text output is `file:line: message`.
- `diff <path>`: plan. Options `--adopt`, `--allow-changes`, `--prune`.
- `apply <path>`: validate everything, then write. Idempotent. `--dry-run`, `--force`, `--adopt`, `--allow-changes`, `--prune` (needs `--yes`). Exit 1 if any file has an error.
- `export [id] | --all --dir <dir> | --preset <id>`: text on stdout, or files in a folder (existing files are skipped without `--force`). The ten presets export as valid, paused files with triggers off and a placeholder repository.
- Prune removes only managed Agents whose marker folder equals the applied folder and whose file is gone, deletes the automations apply created, and refuses to run when no valid file was found.
- Planned: `run <file> --once` (below).

## Server mode

`ZERO_AGENTS_DIR` or `--agents-dir` is applied after the services start and again on `SIGHUP`; the folder can be a read-only mount. `ZERO_AGENTS_ALLOW_CHANGES`, `ZERO_AGENTS_PRUNE`, `ZERO_AGENTS_ADOPT` and `ZERO_AGENTS_FORCE` set the policy flags. Problems are logged with file and line and never stop the server. Each apply writes an `agents.apply` audit event with the folder, the combined content hash, counts and flags, never contents. In team mode only owners can apply through the API.

## CI

Validate on pull requests (a Docker run or the binary, no credentials, no Agent needed). Apply only from the default branch. The example is in `docs/src/content/docs/agents-as-code.md`. No marketplace action in this slice.

## Trust model

- Applying is an operator action: the CLI with the local control token, or the server's own configured folder. API callers need the control token, and in team mode the owner role.
- A file never exceeds the operator's ceiling. `access: changes` is refused unless the operator passes `--allow-changes` or sets `ZERO_AGENTS_ALLOW_CHANGES=1`. A server configured with the policy `agents.fileAccessCeiling` set to read-only ignores a request's flag.
- Files cannot turn on production targets, cannot hold secrets, cannot name a charter outside their folder, and cannot set the marker.
- New Agents start paused unless the file says `active`. Applying an `active` file acknowledges the review gate: the committed file is the reviewed record. Adopting does not acknowledge. A budget pause is never cleared by apply.
- Pull-request-controlled files: never apply from a pull request. For `run --once` in CI on a fork pull request, use the file from the base branch and pass the pull request only as data.
- Charters are prompts, so a charter changed in a pull request changes behaviour. Review it like code; CODEOWNERS on `.0/agents/` is the recommended control.

## Threads and agents as code

- **Relationship.** An Agent file defines an Agent. Every run of an Agent produces a Thread (the stored run record is an activation linked to its Thread). A file's `triggers` start those Threads on a schedule, on a pull request, or by hand. A file never contains a Thread.
- **Reusable prompts and automation templates.** Recommendation: no separate `.0/automations/*.md` concept and no `automations:` block. The Agent file owns its triggers; each trigger names a `template`, which is one of the built-in automation templates, and the charter carries the standing instructions. Fewer concepts, one file per Agent, and the existing rule that an automation is owned by one Agent holds. Standalone automations stay app-defined. If custom automation steps are needed later, add `.0/automations/<id>.md` with the same frontmatter rules and reference it from `template`; not needed now.
- **Where results live.** Findings go to the Findings store, linked to the Thread. The Thread holds the transcript and the summary. A pull request trigger can post one summary comment, edited in place (`commentOnPr`). Memory notes the Agent writes stay on the instance.
- **`run <file> --once`.** It creates a Thread you can open in the console: it applies the file to a throwaway Agent (or runs the managed one) against the current folder, prints a machine-readable result and a markdown summary suitable for a pull request comment, and prints the Thread link. This needs the Agent run path to be callable without a trigger; it is left for a follow-up.

## Free versus hosted or enterprise

Everything above is free and open source. Team sharing of Agent folders, audit export, sign-in controls and policy distribution are out of scope here.

## Open questions

1. **Apply from the default branch automatically?** Recommendation: not in this slice. Ship the validate recipe and a documented apply step on merge; a hosted apply action can come with the enterprise gateway.
2. **Should `status: active` be allowed in files at all?** Recommendation: yes, because deployable Agents must run unattended, with `--allow-changes` and the review gate as the controls. Revisit if teams ask for a separate approval step.
3. **Budget in files: per run and per month?** Recommendation: keep the two fields the runner enforces (daily, runs per day) and add per run or per month only when the runner enforces them.
4. **Storage schema version.** Recommendation: add a stored `schemaVersion` and a migrator for Agent rows as a separate change, then let export drop the shims it reads today.
5. **`.0/agents` as the default folder?** Recommendation: yes for docs and `export --all`; the apply commands take any path, so nothing depends on it.
