---
title: Sentinels
description: Standing watchers with a scope, an autonomy level, budgets and a review gate.
---

A Sentinel is a named, standing agent that you configure once and that then
runs missions for you: on a schedule, when a GitHub pull request opens, or when
you start it by hand. Each Sentinel has a scope, a tool-access level, a
model, memory files (`AGENTS.md`, `NOTES.md`, plus `handoffs/` and
`reports/`), and hard budgets. Open them from **Sentinels** in the browser.

Sentinels run on the engine behind the browser console. Without a running
server nothing fires.

## Presets

A preset fills in the name, job, skills, autonomy and tool access. A new
Sentinel always starts **paused** so you can read its instructions and scope
first.

| Preset | Default autonomy | Job |
| --- | --- | --- |
| `pr-security-reviewer` | propose | Review each opened or updated pull request diff and draft inline comments. |
| `pen-tester` | observe | Scheduled, scoped, non-destructive tests of authorised web and API targets. |
| `dependency-watcher` | propose | Watch lockfiles and advisories; flag risky package changes. |

You can also start from a blank Sentinel. Earlier builds shipped more presets
(secrets hunter, attack-surface monitor, cloud posture auditor, fix engineer,
incident triage); Sentinels already created from them keep working.

## Autonomy, scope and tools

- **Autonomy**: `observe` produces read-only drafts, `propose` (the default)
  queues proposals that wait for your approval, `act` may publish without
  per-item approval. No preset defaults to `act`.
- **Tool access**: `read-only` (default), `read-web`, or `exec`.
- **Scope**: repositories, targets, domains and explicit out-of-scope entries.
  Production targets stay off unless you turn `production` on.

## Budgets

Each Sentinel has one daily cap: 10 USD per rolling 24 hours and 20 runs per
day by default (both editable). When the cap is reached the runner stops the
run, pauses the Sentinel and shows it as needing you; resuming clears the
pause. Records saved with the older per-run cost and time caps load normally;
those two caps are ignored.

## Triggers

- **schedule**: minutes (every 5 minutes or more), hourly, daily, weekdays,
  weekly or cron, in an IANA timezone.
- **manual**: run it now.
- **github-pr**: polls open pull requests with the connected `gh` account
  (poll interval at least 60 seconds). There are no webhooks. The first poll
  only records pull requests that are already open and never reviews them.
  If `gh` is missing or signed out, the trigger shows a blocked status and
  retries on the next poll.

Other trigger kinds (push, webhook, finding-created) are not available.

## Review gate

Scheduled and polled runs are autonomous, so they need an **active, reviewed**
Sentinel. The review covers a fingerprint of scope, model, tool access,
autonomy, skills and the engine it runs on. If any of those change, the Sentinel needs a new
acknowledgement before the next autonomous run. Manual runs are launched by a
person and are not blocked by it.

## API summary

All routes are under `/api/console` and need the dashboard control token. In
team mode, viewers are read-only and editors can only delete their own
Sentinels.

| Route | Purpose |
| --- | --- |
| `GET sentinel-presets` | List presets. |
| `GET` / `POST sentinels` | List, or create (optionally `{ "preset": "<id>" }` plus overrides). |
| `GET` / `PATCH` / `DELETE sentinels/:id` | Read, update (requires `version`), delete (requires `?version=`). |
| `POST sentinels/:id/pause`, `resume`, `acknowledge` | Status and review gate. |
| `GET sentinels/:id/budget` | Spend against the daily cap; usage is `{ runs, costUsd }`. |
| `.../triggers` (list returns the configured triggers only, no `kinds` array), `.../run`, `.../activations`, `.../automations`, `.../files` | Triggers, manual run, run history, owned automations, memory files. |
