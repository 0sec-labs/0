---
title: Agents
description: Standing watchers with a scope, an access level, a daily budget and a review gate.
---

An Agent is a persistent agent with a name, a standing job, a scope, files and a schedule, configured once. It then runs threads for you on a schedule, when a GitHub pull request opens, or when you start it by hand.

## Create one

1. Run `0` and open **Agents**.
2. Pick a preset, or **Start from scratch**.
3. Confirm the name. The Agent is created **paused**, with production targets off.
4. On its page, set its scope, budget and instructions, then resume it. Scheduled and polled runs also need the review described below.

Agents run on the engine behind the browser app. With no server running, nothing fires.

Each Agent has a scope, an access level, a model, skills, a daily budget and memory files: `AGENTS.md` and `NOTES.md`, plus `handoffs/` and `reports/` folders.

## Presets

A new Agent always starts paused, read-only and with production targets off. A preset fills in the job, skills and access level. Its page also suggests automations to add. Every preset uses only the schedule, manual and GitHub pull request triggers.

| Preset | Access | Job |
| --- | --- | --- |
| `pen-tester` | Read-only | Scheduled, scoped, non-destructive tests of authorized web and API targets. |
| `pr-security-reviewer` | Can run commands | Review each opened or updated pull request diff and draft comments. |
| `dependency-watcher` | Can run commands | Watch lockfiles and advisories and propose safe upgrades. |
| `fix-engineer` | Can run commands | Turn a confirmed finding into a tested draft fix for review. |
| `secrets-hunter` | Read-only | Find leaked credentials in code and git history, reported redacted. |
| `attack-surface-monitor` | Read-only | Re-map the in-scope external surface daily and report what is new. |
| `cloud-posture-auditor` | Read-only | Review infrastructure-as-code in your repositories. Its instructions forbid connecting to a cloud account. |
| `incident-triage` | Can run commands | Assess an alert or finding: genuine, exploitable, duplicate, how severe. |
| `regression-tester` | Read-only | Re-check known findings and API spec drift to catch regressions. |
| `release-gate` | Can run commands | Review what changed since the last release before you ship. |

## Access, tools and scope

- **Access.** One choice per Agent. **Read-only** can read and report. **Can run commands** also runs tools and commands, but does not open pull requests or post comments. **Can open pull requests** also publishes fixes and comments. No preset defaults to opening pull requests.
- **Ask before running commands.** When this setting is on (Settings, Helpers), an Agent's commands need your approval, as in threads.
- **Scope.** Repositories, targets, domains and explicit out-of-scope entries. Production targets stay off until you turn `production` on.

## Budget

Each Agent has one daily cap: 10 USD per rolling 24 hours and 20 runs per day by default. Both are editable. At the cap the runner stops the run, pauses the Agent and marks it as needing you. Resuming clears the pause. Autonomous runs and budget pauses are recorded in **Settings → Audit log**.

Records saved with older per-run cost and time caps load normally, and those two caps are ignored.

## Triggers

| Trigger | Behavior |
| --- | --- |
| `schedule` | Every N minutes (5 or more), hourly, daily, weekdays, weekly or cron, in an IANA timezone. |
| `manual` | Run it now. |
| `github-pr` | Polls open pull requests through the connected `gh` account, at least every 60 seconds. |

`github-pr` has no webhooks. The first poll only records pull requests that are already open and never reviews them. If `gh` is missing or signed out, the trigger shows a blocked status and retries on the next poll. Push, webhook and finding-created triggers do not exist.

### What a pull request run does

A new commit on an open pull request starts one thread, recorded as an activation on the Agent with a link to the thread. Closed and merged pull requests are ignored. The run gets the pull request's diff, fetched through `gh pr diff`, as untrusted data. Nothing is cloned, checked out or executed from the pull request.

By default a run **posts nothing to GitHub**. Results are in the Agent's activity and thread only. Two options on the trigger change that, and both are off by default:

| Option | UI label | CLI flag | Effect |
| --- | --- | --- | --- |
| `commentOnPr` | Comment on the pull request | `--comment` | When a run completes, posts one summary comment with the reviewed commit and each finding's severity, title and repository-relative location. No proof-of-concept steps, evidence, descriptions or local paths. The comment carries a hidden marker per Agent, so a later push edits it in place. At most one comment per pull request per minute and 30 per hour. |
| `includeForks` | Include pull requests from forks | `--include-forks` | Without it, fork pull requests are skipped and recorded as a skipped activation with the reason `fork pull request`. With it, the run is read-only analysis of the diff in recon mode with GET-only requests, and the activation and any comment say it is untrusted. |

Draft pull requests are skipped the same way, with the reason `draft pull request`, and are reviewed once when marked ready for review. Changing a trigger's repository, branch or options turns it off and records a new baseline, so turning on comments or forks needs a fresh approval.

```bash
0 agents triggers add <agent> --automation <automation> --kind github-pr --repo owner/name --comment --include-forks
0 agents triggers check <agent> <trigger>
```

The Agent's `gh` account needs permission to comment when `--comment` is on. A failed comment is shown on the activation and does not fail the review. Comments are posted with the signed-in `gh` account, so they appear as that person.

## Review gate

Scheduled and polled runs are autonomous, so the Agent must be **active and reviewed**. The review covers a fingerprint of its scope, model, access level, skills and engine. If any of these change, it needs a new acknowledgement before the next autonomous run. A manual run is started by a person and is not blocked.


## From the CLI

Everything on the Agents page works from `0 agents`. Commands attach to a running engine; without one, reads and edits work against the control database directly. Running an Agent starts a thread, so `run` needs the engine. Pass `--json` for machine output.

```bash
0 agents presets
0 agents create --preset pen-tester --name "Nightly probe" --access read-only
0 agents set AGENT_ID --daily-usd 5 --access read-only
0 agents files put AGENT_ID reports/scope.md --file ./scope.md
0 agents resume AGENT_ID --acknowledge
0 agents run AGENT_ID --task "Re-test the login flow" --yes
0 agents activations AGENT_ID
0 agents delete AGENT_ID --yes
```

`delete`, `run` and enabling a trigger need `--yes` because the CLI never prompts. IDs may be abbreviated to a unique prefix.

## API

Routes sit under `/api/console` and need the dashboard control token. In team mode, viewers are read-only and editors can delete only their own Agents.

| Route | Purpose |
| --- | --- |
| `GET sentinel-presets` | List presets. |
| `GET` / `POST sentinels` | List, or create. `POST` accepts `{ "preset": "<id>" }` plus overrides. |
| `GET` / `PATCH` / `DELETE sentinels/:id` | Read, update (needs `version`), delete (needs `?version=`). |
| `POST sentinels/:id/pause`, `resume`, `acknowledge` | Status and review gate. |
| `GET sentinels/:id/budget` | Spend against the daily cap, as `{ runs, costUsd }`. |
| `.../triggers`, `.../triggers/:id/check`, `.../run`, `.../activations`, `.../automations`, `.../files` | Triggers, manual run, run history, owned automations, memory files. |

## Next steps

- [Automations](/automations/): the saved jobs an Agent can own.
- [Skills](/skills/): instructions an Agent loads.
- [Scope](/scope/): authorization rules.

## Access levels and older Agents

The API keeps its field names (`autonomy`, `toolAccess`) and adds a derived `accessLevel`. A request may send `accessLevel` instead of `autonomy`; an explicit `autonomy` wins. Stored values are never rewritten, so existing Agents keep exactly their behavior.

| Access level | Stored `autonomy` | What runs |
| --- | --- | --- |
| Read-only | `observe` | Passive reads and reports. Commands are refused. |
| Can run commands | `run` (new), `propose` (older Agents) | Runs commands. Mutating web requests are blocked. Its instructions forbid pull requests, pushes and comments. `propose` Agents keep asking before every action, as before. |
| Can open pull requests | `act` | Publishes without per-item approval. |

For Read-only, an Agent keeps the web lookups its preset allows. Moving an Agent to another level in the form uses the standard values for that level and never widens it past the level you pick. Untrusted fork pull requests always run read-only. Commands under **Can run commands** are not technically unable to publish, so keep GitHub credentials off machines that should not publish.
