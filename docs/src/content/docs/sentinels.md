---
title: Sentinels
description: Standing watchers with a scope, an autonomy level, a daily budget and a review gate.
---

A Sentinel is a named agent you configure once. It then runs missions for you on a schedule, when a GitHub pull request opens, or when you start it by hand.

## Create one

1. Run `0` and open **Sentinels**.
2. Pick a preset, or **Start from scratch**.
3. Confirm the name. The Sentinel is created **paused**, with production targets off.
4. On its page, set its scope, budget and instructions, then resume it. Scheduled and polled runs also need the review described below.

Sentinels run on the engine behind the browser app. With no server running, nothing fires.

Each Sentinel has a scope, a tool-access level, a model, skills, a daily budget and memory files: `AGENTS.md` and `NOTES.md`, plus `handoffs/` and `reports/` folders.

## Presets

A preset fills in the job, skills, autonomy and tool access. Its page also suggests automations to add. Every preset uses only the schedule, manual and GitHub pull request triggers.

| Preset | Autonomy | Tool access | Job |
| --- | --- | --- | --- |
| `pen-tester` | observe | `read-web` | Scheduled, scoped, non-destructive tests of authorized web and API targets. |
| `pr-security-reviewer` | propose | `read-only` | Review each opened or updated pull request diff and draft comments. |
| `dependency-watcher` | propose | `read-only` | Watch lockfiles and advisories and propose safe upgrades. |
| `fix-engineer` | propose | `read-only` | Turn a confirmed finding into a tested draft fix for review. |
| `secrets-hunter` | observe | `read-only` | Find leaked credentials in code and git history, reported redacted. |
| `attack-surface-monitor` | observe | `read-web` | Re-map the in-scope external surface daily and report what is new. |
| `cloud-posture-auditor` | observe | `read-only` | Review infrastructure-as-code in your repositories. Its instructions forbid connecting to a cloud account. |
| `incident-triage` | propose | `read-only` | Assess an alert or finding: real, exploitable, duplicate, how severe. |
| `regression-tester` | observe | `read-web` | Re-check known findings and API spec drift to catch regressions. |
| `release-gate` | propose | `read-only` | Review what changed since the last release before you ship. |

## Autonomy, tools and scope

- **Autonomy.** `observe` produces read-only drafts. `propose` (the default) queues proposals that wait for your approval. `act` may publish without per-item approval. No preset defaults to `act`.
- **Tool access.** `read-only` (default), `read-web` or `exec`.
- **Scope.** Repositories, targets, domains and explicit out-of-scope entries. Production targets stay off until you turn `production` on.

## Budget

Each Sentinel has one daily cap: 10 USD per rolling 24 hours and 20 runs per day by default. Both are editable. At the cap the runner stops the run, pauses the Sentinel and marks it as needing you. Resuming clears the pause. Autonomous runs and budget pauses are recorded in **Settings → Audit log**.

Records saved with older per-run cost and time caps load normally, and those two caps are ignored.

## Triggers

| Trigger | Behavior |
| --- | --- |
| `schedule` | Every N minutes (5 or more), hourly, daily, weekdays, weekly or cron, in an IANA timezone. |
| `manual` | Run it now. |
| `github-pr` | Polls open pull requests through the connected `gh` account, at least every 60 seconds. |

`github-pr` has no webhooks. The first poll only records pull requests that are already open and never reviews them. If `gh` is missing or signed out, the trigger shows a blocked status and retries on the next poll. Push, webhook and finding-created triggers do not exist.

## Review gate

Scheduled and polled runs are autonomous, so the Sentinel must be **active and reviewed**. The review covers a fingerprint of its scope, model, tool access, autonomy, skills and engine. If any of these change, it needs a new acknowledgement before the next autonomous run. A manual run is started by a person and is not blocked.

## API

Routes sit under `/api/console` and need the dashboard control token. In team mode, viewers are read-only and editors can delete only their own Sentinels.

| Route | Purpose |
| --- | --- |
| `GET sentinel-presets` | List presets. |
| `GET` / `POST sentinels` | List, or create. `POST` accepts `{ "preset": "<id>" }` plus overrides. |
| `GET` / `PATCH` / `DELETE sentinels/:id` | Read, update (needs `version`), delete (needs `?version=`). |
| `POST sentinels/:id/pause`, `resume`, `acknowledge` | Status and review gate. |
| `GET sentinels/:id/budget` | Spend against the daily cap, as `{ runs, costUsd }`. |
| `.../triggers`, `.../run`, `.../activations`, `.../automations`, `.../files` | Triggers, manual run, run history, owned automations, memory files. |

## Related

- [Automations](/automations/): the saved jobs a Sentinel can own.
- [Skills](/skills/): instructions a Sentinel loads.
- [Scope](/scope/): authorization rules.
