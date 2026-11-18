---
title: Agents
description: Standing jobs with a scope and a review gate, plus the saved automations they run and the GitHub pull request trigger.
---

An Agent is a persistent agent with a name, a standing job, a scope, files and a schedule, configured once. It is one thread that never ends, plus triggers: it wakes on a schedule or when a GitHub pull request is opened or updated, does its work in that thread, and answers you there whenever you write to it. An **automation** is a workflow template plus a trigger: a saved list of steps that runs against a target and keeps its results. An Agent owns automations.

## Create one

1. Run `0` and click **+** next to **Agents** in the sidebar. The Agents page, the command palette and the **Create an agent** chip on the home screen open the same dialog.
2. Optionally pick a **Start from** preset. It fills the name, avatar and instructions; **Blank** is the default. Click the avatar to change its glyph or colour.
3. Type a name, then check the **Folder** it works on, the **Computer** it runs on and its **Model** (the current default unless you pick one).
4. Click **Create agent**. The agent is **active** and you land in its own thread: tell it what to do in the composer, or open **View agent** for Overview (status, last 7 days, memory and files, activity), Automations and Settings.

Creating an agent never turns a schedule on. A preset only suggests automations; none exists until you add it on the Automations tab, and a schedule starts only after you review and turn it on. Production targets stay off.

Agents run on the engine behind the browser app. With no server running, nothing fires.

Each Agent has a scope, a model, skills, instructions (`AGENTS.md`) and its own memory (`NOTES.md`), plus `handoffs/` and `reports/` folders.

## One thread that never ends

The Agent's page is its real conversation, the same transcript and composer every thread has. Everything it does happens there:

- **Your messages.** Type in the composer and the message goes into the thread. If the Agent is in the middle of a turn, yours waits its turn rather than stopping it. Each message is recorded as one of the Agent's turns and counts toward its spend, but never toward its turn limit.
- **Wake-ups.** When a schedule or a pull request trigger fires, the work arrives in the same thread as a quiet centered line, such as *Schedule · Woke on schedule, worked for 54s*. Click it to see what arrived and how it ended. A red x marks a turn that failed. The chip names the cause: Schedule, GitHub or You.
- **Pause and Resume.** Pause turns the triggers off. The thread still answers you.
- **Needs you.** The sidebar row shows the Agent's last message and a glyph only when it is working, waiting on you or failed. A row that needs you says so in place of its age.
- **Older threads.** Work from before this change, or with `ZERO_AGENTS_PERSISTENT_THREAD=0` set, ran in a thread of its own. Those stay as ordinary threads and are listed under Activity in Overview with an **Open** link.

Every wake-up message carries the Agent's instructions, scope and skills again, so a long thread that has been summarised never loses its limits. If you change the scope, model or skills, the next wake-up starts a fresh thread with the new ones and says so; the old thread stays as an ordinary thread.

## Presets

A preset fills in the job, skills and instructions. A new Agent starts with production targets off and no automations; its Automations tab suggests the preset's automations to add. Every preset uses only the schedule, manual and GitHub pull request triggers.

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

There is one mode: an Agent has shell access, like a thread. There is no access setting to choose. What limits an Agent is its scope, the optional sandbox (SmolVM or Docker) and one global setting. No preset opens pull requests unprompted; each preset's instructions say what it may do.

- **Ask before running commands.** One global setting (**Settings → Helpers**), off by default; see [Configuration](/configuration/#ask-before-running-commands). When on, an Agent needs your approval for its commands, as in threads. Agents that used Ask first before now follow this setting; turn it on to keep confirmations.
- **Scope.** Repositories, targets, domains and explicit out-of-scope entries. Production targets stay off until you turn `production` on. See [Scope](/configuration/#scope).

## Cost

An Agent has no spending cap. Its thread shows what it has cost so far, like any thread, and nothing stops or pauses it because of cost. Older records that carry a daily cap load normally and the cap is ignored.

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

Polling needs nothing. If you run `0 --server-mode` behind a public HTTPS address (see [Server mode](/server-mode/)), a webhook makes pull request Agents react right after a push. It is only an accelerator: a delivery asks the Agent's trigger to check GitHub now, exactly as a poll would, so forks, drafts, comments and the one-review-per-commit rule behave the same. If the webhook is off or unreachable, polling keeps working.

1. Open **Agents** (or Settings > Git) and choose **Set up webhook**. Copy the secret now; it is shown once. The card also shows the payload URL, built from `--public-url`.
2. On GitHub, open the repository (or organisation), **Settings**, **Webhooks**, **Add webhook**. Payload URL: the one on the card. Content type: `application/json`. Secret: the secret. Events: **Let me select individual events**, then only **Pull requests**. Keep **Active** on and add the webhook.
3. GitHub sends a ping. On the card, **Test** lists the last 5 deliveries as received, ignored or rejected, with no content.

The trigger must exist and be on for that repository and base branch; deliveries for anything else are ignored. Rotate the secret with the card or `0 agents webhook secret rotate --yes`; the old secret still works for 5 minutes so you can update GitHub without losing deliveries. Deliveries are checked by signature before anything is read, limited to 1 MB, deduplicated by delivery id and rate limited. The route does not exist outside server mode.

#### What a pull request run does

A new commit on an open pull request wakes the Agent in its thread with one turn, recorded in its activity. If an older commit of the same pull request is still waiting, the newer one replaces it. Pull request reviews run one at a time, in the order they arrive. Closed and merged pull requests are ignored. The run gets the pull request's diff, fetched through `gh pr diff`, as untrusted data. 0 does not check out or execute the pull request branch itself; the run works in the repository's local checked-out folder.

By default a run **posts nothing to GitHub**. Results are in the Agent's activity and thread only. Two options on the trigger change that, and both are off by default:

| Option | UI label | CLI flag | Effect |
| --- | --- | --- | --- |
| `commentOnPr` | Comment on the pull request | `--comment` | When a run completes, posts one summary comment with the reviewed commit and each finding's severity, title and repository-relative location. No proof-of-concept steps, evidence, descriptions or local paths. The comment carries a hidden marker per Agent, so a later push edits it in place. At most one comment per pull request per minute and 30 per hour. |
| `includeForks` | Include pull requests from forks | `--include-forks` | Without it, fork pull requests are skipped and recorded as a skipped activation with the reason `fork pull request`. With it, the run uses the same limits as every pull request run (below), and the activation and any comment say it is untrusted. |

Draft pull requests are skipped the same way, with the reason `draft pull request`, and are reviewed once when marked ready for review. Changing a trigger's repository, branch or options turns it off and records a new baseline, so turning on comments or forks needs a fresh approval.

#### Limits for pull request runs

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

Scheduled and polled turns are autonomous, so the Agent must be **active and reviewed**. The review covers a fingerprint of its scope, model, access level, skills and engine. If any of these change, it needs a new acknowledgement before the next autonomous turn. Your own messages are never blocked.


## From the CLI

Everything on the Agents page works from `0 agents`. Commands attach to a running engine; without one, reads and edits work against the control database directly. `agents run` sends a message into the Agent's thread, so it needs the engine. Pass `--json` for machine output.

```bash
0 agents list --presets
0 agents set --create --preset pen-tester --name "Nightly probe"
0 agents set AGENT_ID --mission "Watch the lockfile"
0 agents set AGENT_ID --files put reports/scope.md --file ./scope.md
0 agents set AGENT_ID --state active --acknowledge
0 agents run AGENT_ID --task "Re-test the login flow" --yes
0 agents run AGENT_ID --history
0 agents set AGENT_ID --state deleted --yes
```

`delete`, `run` and enabling a trigger need `--yes` because the CLI never prompts. IDs may be abbreviated to a unique prefix.

## Automations

A **template** is a versioned starter definition, an **automation** is a saved definition you can edit, and a **run** is one execution with its step results, findings and evidence. Use one when you want the same job repeated, scheduled or handed to a pipeline. Scan steps use the model connection from [Models](/models/); the model of a coding agent that calls 0 over MCP does not configure it.

In the browser, open an Agent, add an automation from a template (or describe a custom one in a thread), edit its **Steps**, and set a **Triggers** schedule. A schedule fires only while the app and its computer are running.

```bash
0 agents list --automation --templates
0 agents set --automation create --template repository-review --name "Weekly review" --target /absolute/path/to/repo
0 agents run --automation --template repository-review --revision 1 \
  --target /absolute/path/to/repo --workspace /absolute/path/to/repo \
  --time-cap 600000 --cost-cap 5 --format json > run.json
0 agents run --automation AUTOMATION_ID --revision 3 \
  --target https://target.example.com --scope /absolute/path/to/scope.json
```

`set --automation` also takes `edit`, `duplicate`, `delete` and `triggers`; `delete`, `triggers remove` and `triggers enable` need `--yes`. Other flags of `run` are `--model`, `--inputs <path>` (a JSON object of artifact inputs, such as a finding to verify), `--allow-apply` (permit patch-apply steps) and `--chat <id>` (attach to an existing thread). The command stays in the foreground, and Ctrl-C cancels.

Templates for source targets include `repository-review`, `finding-verification` (needs a finding and a replay runner), `fix-candidate` (needs a finding and a `testCommand`), `security-research` and `deep-source-review`. A template whose prerequisites are missing fails before launch; it never turns into a plain scan.

- A completed run exits `0` even when it found something. Execution failure exits `2` and cancellation `130`. Read the findings in the JSON, not only the exit code. The `scan` shortcuts keep their own convention and can exit `1` on findings.
- Steps run in order, and earlier findings pass forward as evidence. One deadline and one cost ledger cover the run. Cost accounting is an estimate, so in-flight calls can pass the cap.
- Partial results stay on record when later work fails or the run is cancelled. Run history does not resume interrupted work; `0 lab runs resume SCAN_ID --chat SESSION_ID` resumes a persisted scan in an existing thread when the computer supports it.
- Applying a patch needs `--allow-apply` on the foreground command and approval of the exact candidate that process created. A candidate is not evidence that it fixes the finding; see [Findings](/findings/#verify-and-fix).
- `0 lab runs list|show|cancel` reads retained runs, including the one-step runs that `0 scan` records.

To work on the runs you see in the browser from a CLI or MCP client, attach to that computer with `--engine-url` and `--engine-token-env`, or `--engine <id>` for a registered one; see [Computers](/computers/).

## Older Agents

The API fields `access`, `autonomy` and `toolAccess` are ignored on write and no longer returned. Agents saved with `observe`, `propose`, `run` or `act` still load and all mean the single mode. An Agent that was read-only is marked as needing review once, because its authority widened. Keep GitHub credentials off machines that should not publish.

## Next steps

- [Skills](/skills/): instructions an Agent loads.
- [Extensions](/extensions/): connect GitHub and other services.
- [Configuration](/configuration/#scope): authorization rules.
