---
title: Sentinels
description: Sentinels: standing jobs with a scope and a review gate, plus the prompt-based automations they run and the GitHub pull request trigger.
---

A Sentinel is a named standing job with a scope, files and a schedule, configured once. It is one thread that never ends, plus triggers: it wakes on a schedule or when a GitHub pull request is opened or updated, does its work in that thread, and answers you there whenever you write to it. An **automation** is a saved prompt plus a trigger: when the trigger fires, the prompt is sent into the Sentinel's thread. A Sentinel owns automations.

## Create one

1. Run `0` and click **+** next to **Sentinels** in the sidebar. The Sentinels page, the command palette and the **Create a sentinel** chip on the home screen open the same dialog.
2. Optionally pick a **Start from** preset. It fills the name, avatar and instructions; **Blank** is the default. Click the avatar to change its glyph or colour.
3. Type a name, then check the **Folder** it works on, the **Computer** it runs on and its **Model** (the current default unless you pick one).
4. Click **Create sentinel**. The sentinel is **active** and you land in its own thread: tell it what to do in the composer, or open **View sentinel** for Overview (status, last 7 days, memory and files, activity), Automations and Settings.

Creating a sentinel never turns a schedule on. A preset only suggests automations; none exists until you add it on the Automations tab, and a schedule starts only after you review and turn it on. Production targets stay off.

Sentinels run on the engine behind the browser app. With no server running, nothing fires.

Each Sentinel has a scope, a model, skills, instructions (`AGENTS.md`) and its own memory (`NOTES.md`), plus `handoffs/` and `reports/` folders.

## One thread that never ends

The Sentinel's page is its real conversation, the same transcript and composer every thread has. Everything it does happens there:

- **Your messages.** Type in the composer and the message goes into the thread. If the Sentinel is in the middle of a turn, yours waits its turn rather than stopping it. Each message is recorded as one of the Sentinel's turns and counts toward its spend, but never toward its turn limit.
- **Wake-ups.** When a schedule or a pull request trigger fires, the work arrives in the same thread as a quiet centered line, such as *Schedule · Woke on schedule, worked for 54s*. Click it to see what arrived and how it ended. A red x marks a turn that failed. The chip names the cause: Schedule, GitHub or You.
- **Pause and Resume.** Pause turns the triggers off. The thread still answers you.
- **Needs you.** The sidebar row shows the Sentinel's last message and a glyph only when it is working, waiting on you or failed. A row that needs you says so in place of its age.
- **Older threads.** Work from before this change, or with `ZERO_AGENTS_PERSISTENT_THREAD=0` set, ran in a thread of its own. Those stay as ordinary threads and are listed under Activity in Overview with an **Open** link.

Every wake-up message carries the Sentinel's instructions, scope and skills again, so a long thread that has been summarised never loses its limits. If you change the scope, model or skills, the next wake-up starts a fresh thread with the new ones and says so; the old thread stays as an ordinary thread.

## Presets

A preset fills in the job, skills and instructions. A new Sentinel starts with production targets off and no automations; its Automations tab suggests the preset's automations to add. Every preset uses only the schedule, manual and GitHub pull request triggers.

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

There is one mode: a Sentinel has shell access, like a thread. There is no access setting to choose. What limits a Sentinel is its scope, the optional sandbox (SmolVM or Docker) and one global setting. No preset opens pull requests unprompted; each preset's instructions say what it may do.

- **Ask before running commands.** One global setting (**Settings → Helpers**), off by default; see [Configuration](/configuration/#ask-before-running-commands). When on, a Sentinel needs your approval for its commands, as in threads. Sentinels that used Ask first before now follow this setting; turn it on to keep confirmations.
- **Scope.** Repositories, targets, domains and explicit out-of-scope entries. Production targets stay off until you turn `production` on. See [Scope](/configuration/#scope).

## Cost

A Sentinel has no spending cap. Its thread shows what it has cost so far, like any thread, and nothing stops or pauses it because of cost. Older records that carry a daily cap load normally and the cap is ignored.

## Triggers

| Trigger | Behavior |
| --- | --- |
| `schedule` | Every N minutes (5 or more), hourly, daily, weekdays, weekly or cron, in an IANA timezone. |
| `manual` | Run it now. |
| `github-pr` | Polls open pull requests through the connected `gh` account, at least every 60 seconds. |

`github-pr` polls by default. In server mode you can also add a [GitHub webhook](#faster-with-a-github-webhook-server-mode) so a push is picked up in seconds; polling stays on as the fallback. The first poll only records pull requests that are already open and never reviews them. If `gh` is missing or signed out, the trigger shows a blocked status and retries on the next poll. Push and finding-created triggers do not exist.

### GitHub pull request trigger

`github-pr` polls GitHub for new and updated pull requests. The sections below cover the webhook that speeds it up and what a run does.

#### Faster with a GitHub webhook (server mode)

Polling needs nothing. If you run `0 --server-mode` behind a public HTTPS address (see [Server mode](/server-mode/)), a webhook makes pull request Sentinels react right after a push. It is only an accelerator: a delivery asks the Sentinel's trigger to check GitHub now, exactly as a poll would, so forks, drafts, comments and the one-review-per-commit rule behave the same. If the webhook is off or unreachable, polling keeps working.

1. Open **Sentinels** (or Settings > Git) and choose **Set up webhook**. Copy the secret now; it is shown once. The card also shows the payload URL, built from `--public-url`.
2. On GitHub, open the repository (or organisation), **Settings**, **Webhooks**, **Add webhook**. Payload URL: the one on the card. Content type: `application/json`. Secret: the secret. Events: **Let me select individual events**, then only **Pull requests**. Keep **Active** on and add the webhook.
3. GitHub sends a ping. On the card, **Test** lists the last 5 deliveries as received, ignored or rejected, with no content.

The trigger must exist and be on for that repository and base branch; deliveries for anything else are ignored. Rotate the secret with the card or `0 sentinels webhook secret rotate --yes`; the old secret still works for 5 minutes so you can update GitHub without losing deliveries. Deliveries are checked by signature before anything is read, limited to 1 MB, deduplicated by delivery id and rate limited. The route does not exist outside server mode.

#### What a pull request run does

A new commit on an open pull request wakes the Sentinel in its thread with one turn, recorded in its activity. If an older commit of the same pull request is still waiting, the newer one replaces it. Pull request reviews run one at a time, in the order they arrive. Closed and merged pull requests are ignored. The run gets the pull request's diff, fetched through `gh pr diff`, as untrusted data. 0 does not check out or execute the pull request branch itself; the run works in the repository's local checked-out folder.

By default a run **posts nothing to GitHub**. Results are in the Sentinel's activity and thread only. Two options on the trigger change that, and both are off by default:

| Option | UI label | CLI flag | Effect |
| --- | --- | --- | --- |
| `commentOnPr` | Comment on the pull request | `--comment` | When a run completes, posts one summary comment with the reviewed commit and each finding's severity, title and repository-relative location. No proof-of-concept steps, evidence, descriptions or local paths. The comment carries a hidden marker per Sentinel, so a later push edits it in place. At most one comment per pull request per minute and 30 per hour. |
| `includeForks` | Include pull requests from forks | `--include-forks` | Without it, fork pull requests are skipped and recorded as a skipped activation with the reason `fork pull request`. With it, the run uses the same limits as every pull request run (below), and the activation and any comment say it is untrusted. |

Draft pull requests are skipped the same way, with the reason `draft pull request`, and are reviewed once when marked ready for review. Changing a trigger's repository, branch or options turns it off and records a new baseline, so turning on comments or forks needs a fresh approval.

#### Limits for pull request runs

The pull request is untrusted content, and a run has shell access, so these limits apply by default:

- **Scope.** The run's scope is that repository's checked-out folder. It cannot reach other folders, and network scope rules still apply to live targets.
- **Environment.** The shell starts with an allowlisted environment: `PATH`, home and temporary directory basics, locale, `TERM` and CI variables. Other provider keys and tokens are removed. Set `ZERO_BASH_ENV_ALLOW` to a comma-separated list of extra variable names to pass through, or `ZERO_BASH_ENV_PASSTHROUGH_ALL=1` to turn the allowlist off.
- **Sandbox.** When the container sandbox (SmolVM or Docker) is available and enabled, the run uses it. Otherwise it runs on the host and the Sentinel detail shows a one-line note saying so.

```bash
0 sentinels set <sentinel> --trigger add --automation <automation> --kind github-pr --repo owner/name --comment --include-forks
0 sentinels set <sentinel> --trigger check <trigger>
```

The Sentinel's `gh` account needs permission to comment when `--comment` is on. A failed comment is shown on the activation and does not fail the review. Comments are posted with the signed-in `gh` account, so they appear as that person.

## Review gate

Scheduled and polled turns are autonomous, so the Sentinel must be **active and reviewed**. The review covers a fingerprint of its scope, model, access level, skills and engine. If any of these change, it needs a new acknowledgement before the next autonomous turn. Your own messages are never blocked.


## From the CLI

Everything on the Sentinels page works from `0 sentinels`. Commands attach to a running engine; without one, reads and edits work against the control database directly. `sentinels run` sends a message into the Sentinel's thread, so it needs the engine. Pass `--json` for machine output.

```bash
0 sentinels list --presets
0 sentinels set --create --preset pen-tester --name "Nightly probe"
0 sentinels set SENTINEL_ID --mission "Watch the lockfile"
0 sentinels set SENTINEL_ID --files put reports/scope.md --file ./scope.md
0 sentinels set SENTINEL_ID --state active --acknowledge
0 sentinels run SENTINEL_ID --task "Re-test the login flow" --yes
0 sentinels run SENTINEL_ID --history
0 sentinels set SENTINEL_ID --state deleted --yes
```

`delete`, `run` and enabling a trigger need `--yes` because the CLI never prompts. IDs may be abbreviated to a unique prefix.

## Automations

An **automation** is a saved prompt plus a trigger (a schedule, a manual run or a GitHub pull request). When the trigger fires, the prompt goes into the Sentinel's own thread as a wake-up message, and the Sentinel does the work there with its scope, skills and memory. There are no steps to wire together: change what the Sentinel does by changing the prompt. Use one when you want the same job repeated or scheduled.

In the browser, open a Sentinel, add an automation from a preset's suggestions (or describe a custom one in the thread), and set its **Triggers** schedule. A schedule fires only while the app and its computer are running.

Run the Sentinel by hand from the CLI; it sends a message into the Sentinel's thread and needs the engine:

```bash
0 sentinels run SENTINEL_ID --task "Re-test the login flow" --yes
0 sentinels run SENTINEL_ID --history
```

- A completed turn exits `0` even when it found something. Read the findings, not only the exit code.
- Cost is shown on the thread, like any thread. Nothing stops a Sentinel because of what it costs.
- Applying a patch needs your approval. A patch is not evidence that it fixes the finding; see [Findings](/findings/#verified-and-not-verified).

To work on a Sentinel you see in the browser from the CLI, attach to that computer with `--engine-url` and `--engine-token-env`, or `--engine <id>` for a registered one; see [Computers](/computers/).

## Older Sentinels

The API fields `access`, `autonomy` and `toolAccess` are ignored on write and no longer returned. Sentinels saved with `observe`, `propose`, `run` or `act` still load and all mean the single mode. A Sentinel that was read-only is marked as needing review once, because its authority widened. Keep GitHub credentials off machines that should not publish.

## Next steps

- [Skills](/skills/): instructions a Sentinel loads.
- [Extensions](/extensions/): connect GitHub and other services.
- [Configuration](/configuration/#scope): authorization rules.
