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

Each Agent has a scope, a model, skills, a daily budget and memory files: `AGENTS.md` and `NOTES.md`, plus `handoffs/` and `reports/` folders.

## Presets

A new Agent always starts paused and with production targets off. A preset fills in the job and skills. Its page also suggests automations to add. Every preset uses only the schedule, manual and GitHub pull request triggers.

| Preset | Job |
| --- | --- |
| `pen-tester` | Scheduled, scoped, non-destructive tests of authorized web and API targets. |
| `pr-security-reviewer` | Review each opened or updated pull request diff and draft comments. |
| `dependency-watcher` | Watch lockfiles and advisories and propose safe upgrades. |
| `fix-engineer` | Turn a confirmed finding into a tested draft fix for review. |
| `secrets-hunter` | Find leaked credentials in code and git history, reported redacted. |
| `attack-surface-monitor` | Re-map the in-scope external surface daily and report what is new. |
| `cloud-posture-auditor` | Review infrastructure-as-code in your repositories. Its instructions forbid connecting to a cloud account. |
| `incident-triage` | Assess an alert or finding: genuine, exploitable, duplicate, how severe. |
| `regression-tester` | Re-check known findings and API spec drift to catch regressions. |
| `release-gate` | Review what changed since the last release before you ship. |

## Limits and scope

There is one mode: an Agent has shell access, like a thread. There is no access setting to choose. What limits an Agent is its scope, its budget, the optional sandbox (SmolVM or Docker) and one global setting. No preset opens pull requests unprompted; each preset's instructions say what it may do.

- **Ask before running commands.** One global setting (Settings, Helpers), off by default. When on, an Agent needs your approval for its commands, as in threads. Agents that used Ask first before now follow this setting; turn it on to keep confirmations.
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

`github-pr` polls by default. In server mode you can also add a [GitHub webhook](#faster-with-a-github-webhook-server-mode) so a push is picked up in seconds; polling stays on as the fallback. The first poll only records pull requests that are already open and never reviews them. If `gh` is missing or signed out, the trigger shows a blocked status and retries on the next poll. Push and finding-created triggers do not exist.

### Faster with a GitHub webhook (server mode)

Polling needs nothing. If you run `0 --server-mode` behind a public HTTPS address (see [Docker](/docker/)), a webhook makes pull request Agents react right after a push. It is only an accelerator: a delivery asks the Agent's trigger to check GitHub now, exactly as a poll would, so forks, drafts, comments and the one-review-per-commit rule behave the same. If the webhook is off or unreachable, polling keeps working.

1. Open **Agents** (or Settings > Git) and choose **Set up webhook**. Copy the secret now; it is shown once. The card also shows the payload URL, built from `--public-url`.
2. On GitHub, open the repository (or organisation), **Settings**, **Webhooks**, **Add webhook**. Payload URL: the one on the card. Content type: `application/json`. Secret: the secret. Events: **Let me select individual events**, then only **Pull requests**. Keep **Active** on and add the webhook.
3. GitHub sends a ping. On the card, **Test** lists the last 5 deliveries as received, ignored or rejected, with no content.

The trigger must exist and be on for that repository and base branch; deliveries for anything else are ignored. Rotate the secret with the card or `0 agents webhook secret rotate --yes`; the old secret still works for 5 minutes so you can update GitHub without losing deliveries. Deliveries are checked by signature before anything is read, limited to 1 MB, deduplicated by delivery id and rate limited. The route does not exist outside server mode.

### What a pull request run does

A new commit on an open pull request starts one thread, recorded as an activation on the Agent with a link to the thread. Closed and merged pull requests are ignored. The run gets the pull request's diff, fetched through `gh pr diff`, as untrusted data. 0 does not check out or execute the pull request branch itself; the run works in the repository's local checked-out folder.

By default a run **posts nothing to GitHub**. Results are in the Agent's activity and thread only. Two options on the trigger change that, and both are off by default:

| Option | UI label | CLI flag | Effect |
| --- | --- | --- | --- |
| `commentOnPr` | Comment on the pull request | `--comment` | When a run completes, posts one summary comment with the reviewed commit and each finding's severity, title and repository-relative location. No proof-of-concept steps, evidence, descriptions or local paths. The comment carries a hidden marker per Agent, so a later push edits it in place. At most one comment per pull request per minute and 30 per hour. |
| `includeForks` | Include pull requests from forks | `--include-forks` | Without it, fork pull requests are skipped and recorded as a skipped activation with the reason `fork pull request`. With it, the run uses the same limits as every pull request run (below), and the activation and any comment say it is untrusted. |

Draft pull requests are skipped the same way, with the reason `draft pull request`, and are reviewed once when marked ready for review. Changing a trigger's repository, branch or options turns it off and records a new baseline, so turning on comments or forks needs a fresh approval.

### Limits for pull request runs

The pull request is untrusted content, and a run has shell access, so these limits apply by default:

- **Scope.** The run's scope is that repository's checked-out folder. It cannot reach other folders, and network scope rules still apply to live targets.
- **Environment.** The shell starts with an allowlisted environment: `PATH`, home and temporary directory basics, locale, `TERM` and CI variables. Other provider keys and tokens are removed. Set `ZERO_BASH_ENV_ALLOW` to a comma-separated list of extra variable names to pass through, or `ZERO_BASH_ENV_PASSTHROUGH_ALL=1` to turn the allowlist off.
- **Sandbox.** When the container sandbox (SmolVM or Docker) is available and enabled, the run uses it. Otherwise it runs on the host and the Agent detail shows a one-line note saying so.

```bash
0 agents set <agent> --trigger add --automation <automation> --kind github-pr --repo owner/name --comment --include-forks
0 agents set <agent> --trigger check <trigger>
```

The Agent's `gh` account needs permission to comment when `--comment` is on. A failed comment is shown on the activation and does not fail the review. Comments are posted with the signed-in `gh` account, so they appear as that person.

## Review gate

Scheduled and polled runs are autonomous, so the Agent must be **active and reviewed**. The review covers a fingerprint of its scope, model, access level, skills and engine. If any of these change, it needs a new acknowledgement before the next autonomous run. A manual run is started by a person and is not blocked.


## From the CLI

Everything on the Agents page works from `0 agents`. Commands attach to a running engine; without one, reads and edits work against the control database directly. Running an Agent starts a thread, so `run` needs the engine. Pass `--json` for machine output.

```bash
0 agents list --presets
0 agents set --create --preset pen-tester --name "Nightly probe"
0 agents set AGENT_ID --daily-usd 5
0 agents set AGENT_ID --files put reports/scope.md --file ./scope.md
0 agents set AGENT_ID --state active --acknowledge
0 agents run AGENT_ID --task "Re-test the login flow" --yes
0 agents run AGENT_ID --history
0 agents set AGENT_ID --state deleted --yes
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

## Older Agents

The API fields `access`, `autonomy` and `toolAccess` (and the older `accessLevel` with `commands` and `pull-requests`) are optional and ignored on write, and are no longer returned. Older Agents saved with `observe`, `propose`, `run` or `act` still load and all mean the single mode; stored rows are not rewritten. An Agent that was read-only is marked as needing review once, because its authority widened. Keep GitHub credentials off machines that should not publish.
