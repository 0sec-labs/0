# How people use 0security: a usage-design study

Status: study, 2026-11-15. Nothing here is built because of this document. It walked the 0.34 console on a dev engine (no jobs started, no model spend), the CLI help of 0.33, and the results of our own fix experiment (small samples, one model, one run per repo).

Direction under test: a recurring job with a verifiable outcome, run on the user's own model keys. Free for one person, a paid team layer later. Examples: triage the security alerts you already have and open fixes your own CI verifies; repair failing CI; a weekly burn-down report.

## 1. Five people

Step counts are from today's product. "Dead end" means the user cannot continue without leaving the product or reading source. Screens are in `/tmp/usage-shots/` of the study machine (not committed).

### a. Solo developer, a repo full of Dependabot and npm-audit alerts

- Trigger: GitHub shows "47 alerts" on a side project and nothing is moving.
- First 5 minutes today, about 9 steps:
  1. `curl -fsSL .../install.sh | bash`
  2. `0 doctor` (it suggests `0 scan ...`, not a fix)
  3. Connect a model (Settings, Models) or reuse a key in the environment
  4. `gh auth login` (the console reuses it) or Settings, Git and pull requests, Sign in with GitHub
  5. `0 web`, open the browser
  6. Agents, New agent, pick "Dependency Watcher" (it proposes upgrades; it does not open a PR on its own)
  7. The Agent opens Paused, with "Add scope to say what it covers, then turn it on"
  8. Add scope, switch it on, Run now
  9. Wait for a Thread, read the diff, apply it by hand
- Dead end: nothing lists the alerts you already have. The Agent works from the lockfile, so "close these 47" never appears as a list with a before and after count. `0 scan deps fix` runs the package manager on the host without a safety net.
- Day 7: a pull request waiting in the repo, or nothing, because no schedule is on by default and a schedule only fires while `0 web` is running.
- Day 30 reason to pay: none for a single person. The free tier must be complete for them. They pay when they bring the repo to work.
- Quits when: a pull request breaks the build (ERESOLVE-style peer conflicts were the main failure in our experiment), or the laptop is closed and nothing ran.

### b. Platform engineer, flaky CI, 40 repos

- Trigger: the same three workflows go red every week and someone re-runs them by hand.
- First 5 minutes today, about 8 steps, then a wall: install, model, `gh auth login`, `0 web`, New agent, pick "Fix Engineer", point it at one repo.
- Dead end: there is no CI-failure trigger. Agent triggers are `schedule`, `manual` and `github-pr` (`0 agents triggers add --kind`). Nothing reacts to a failed check or workflow run. There is no 40-repo list either; each repo is its own folder and its own Agent.
- Day 7: only if they wrote a schedule that polls. A red build that turns into a pull request with the fix is the loop that would bring them back.
- Day 30 reason to pay: one view across repos (what failed, what was fixed, what was rejected), shared budget, a shared Computer to run on instead of laptops.
- Quits when: the Agent proposes a fix for the same flake twice after it was rejected, or comments on pull requests nobody asked about.

### c. Security lead, weekly burn-down for leadership and an auditor

- Trigger: Friday report is built by hand from three scanner exports.
- First 5 minutes today: install, model, `0 web`, Findings. The page says "0 of 0 ... No findings yet", and the only action is "Start a thread". About 6 steps to an empty screen.
- Dead end: no report of "open, closed this week, median age" exists. Findings are per Thread. There is no export aimed at an auditor (who closed what, what proved it, when).
- Day 7: only a recurring email or document would bring them back. Browser notifications exist (Settings, Notifications), and the test notification is blocked in headless Chromium until permission is granted; there is no email or Slack.
- Day 30 reason to pay: the weekly report with evidence links, an audit log, accounts and roles.
- Quits when: the numbers do not match their scanner, or the report cannot be forwarded to someone without an account.

### d. Consultant or pentester, repeatable evidence for clients

- Trigger: the third client this quarter asks for "proof it was fixed".
- First 5 minutes today, about 7 steps: install, model, `0 web`, New thread, "Whitebox pentest" or "Explain this folder" chip, set a scope, run. `0 automation run --template repository-review --target ... --format json` works from the CLI.
- Dead end: results are tied to one Thread and one local database. There is no per-client folder of runs, and no "re-run last quarter's scope and show what changed".
- Day 7: a re-test run per client on a schedule (Automations has hourly, daily, weekly triggers, and they stop when the server stops).
- Day 30 reason to pay: low. They are single-player. Pay for branding of reports or a shared Computer.
- Quits when: a re-test cannot reuse the original scope and evidence format.

### e. Open-source maintainer drowning in AI-generated reports

- Trigger: the fifth "critical vulnerability" this week that does not reproduce.
- First 5 minutes today, about 8 steps: install, model, `gh auth login`, `0 web`, New agent, "Incident Triage" preset ("real, exploitable, duplicate, how severe"), then paste each report into a Thread.
- Dead end: the intake is paste-only. There is no trigger on a new GitHub security advisory or issue, only on pull requests.
- Day 7: a triage verdict per report that they can paste back as a reply. Lowest cost per report wins.
- Day 30 reason to pay: none. They stay free and talk about the tool. This is adoption, not revenue.
- Quits when: a verdict is confidently wrong about a real report, or the free tier needs a paid model they do not have.

## 2. The ideal loop (the recurring job on one page)

Target: one person goes from install to a verified result in 5 minutes, and the second week needs no action from them.

1. Install and first run. `curl ... | bash`, then `0 fix` (new, one command). It finds the model key you already have, finds `gh`, and asks one question: which repo. It runs read-only, lists your existing alerts with a count, and shows one proposed fix with the check it ran. Read-only first, so no approval is needed to see value.
2. Pull request that your CI checks. "Can make changes" is asked at one moment: the first time it wants to open a draft pull request. It opens one pull request per fix, as a draft, from a branch it owns. It never merges.
3. Notice. The pull request description shows: the alert it closes, the check that proves it (the detector re-run and your CI result), what it did not touch.
4. Friday digest. One message per team or person, not per repo.
5. Add repos, then invite teammates. Add repos from one list. Invite when the digest has a second reader.

Notification surfaces, each with one job:

| Surface | Says | When |
| --- | --- | --- |
| Pull request body | Alert closed, how verified, what changed, one line on risk | Once, at opening |
| Check run on that pull request | Pass or fail of the re-run of the original detector | On every push to that branch only |
| Pull request comment | Only on pull requests the Agent opened, and only when it needs a decision | Never on your own pull requests unless `--comment` is set (today's default, keep it) |
| Console inbox | Fix ready, needs your approval, run failed, budget reached | As they happen |
| Friday digest (email or Slack) | Opened, merged, rejected, still open; spend; the one thing that needs a human | Weekly, skipped if nothing happened |

Approval moments:
- Read-only: reading, scanning, listing alerts, proposing a patch as text. No approval.
- Can make changes: opening a branch and a draft pull request. Asked once per repo, and again when the access level, scope or model changes (today `0 agents acknowledge` does that).
- Never without a person: merge, force push, run package managers or scripts on the host, edit workflow permissions beyond what the fix needs.

Where Memory improves run two:
- Accepted and rejected fixes: "rejected: major bump of the framework, owner prefers pinning" stops the same pull request coming back.
- Repo conventions: test command, lockfile policy, commit style, branch name, the usual reviewer.
- Known false positives per repo, so the digest shrinks over time rather than grows.
- Memory must be visible and removable (`0 memory list`, `disable`). Show "used 3 memories" in the pull request.

## 3. Gap list, ranked by impact

Effort: S under a week, M one to three weeks, L more.

| # | Step | Exists today | Missing | Effort |
| --- | --- | --- | --- | --- |
| 1 | Headless start (`0 threads start`) | Command exists | It always creates the thread and then fails with "already processing a turn"; hit by every fix-experiment lane. A fix is in progress | S |
| 2 | Verified fix, end to end | Agents, Threads, `scan fix`, draft PR emitter | A single "fix this alert" path that re-runs the detector, rejects downgrades and floor bumps, and attaches the result. `scan fix` needs a proof-of-concept finding, `scan deps fix` runs the package manager blind | M |
| 3 | Scheduler without `0 web` | Hourly, daily, weekly triggers inside `0 web` | A background service (launchd, systemd, or the Action) so Friday happens with the laptop closed | M |
| 4 | Import the alerts you already have | Nothing | Read Dependabot, code scanning and npm-audit alerts as Findings with a before and after count | M |
| 5 | Friday digest | Browser notifications only | Email and Slack message, skipped when empty | M |
| 6 | CI-failure trigger | `schedule`, `manual`, `github-pr` | A `workflow-failed` trigger (poll `gh run list`, webhook as accelerator) and a "repair CI" preset | M |
| 7 | GitHub App | `gh` login, polling, webhook receiver in server mode; manual manifest flow not built | Check runs need an App; attribution to the `gh` user is confusing; needs an owner decision on app ownership | L |
| 8 | Multi-repo view | One Agent per folder | A repo list with status, spend, open pull requests; one digest across repos | M |
| 9 | Verification gate | Not present | Guard in the engine: detector must be clean after the fix, tests must run, no silent config weakening. Secrets lane: generated config disabled every rule in all six cases | M |
| 10 | Preset defaults | Presets exist | Presets open Paused with no scope; the Dependency Watcher preset says "Can make changes" while tool access shows "read-only" (CLI `agents show`). One consistent first-run state | S |
| 11 | Team layer | Accounts, roles in `--team-config` | Shared inbox, shared budget, audit export. Not needed before the single-player loop works | L |

Evidence for ranking 1, 2 and 9: merge-ready as is, per class, in our experiment (small and hand-picked, indicative only): workflow permissions about 7 of 8; config and IaC 2 of 9; dependency upgrades 2 of 11, with 7 of 11 after small edits; secrets 0 of 6. Cost per fix was roughly one to ten cents on the engine's own estimate. So start with the classes that verify cheaply (workflows, lockfile-only bumps) and gate the rest.

## 4. Metrics and how to collect them

- Activation: first verified fix merged within 7 days of install. A fix counts as verified when the detector re-run was clean and the repo's CI passed.
- Retention: weeks with at least one run (Agent or Automation), per install.
- Expansion: repos per team, and teams with a second reader of the digest.

Today's telemetry is a single `usage` event per run: tool counts, error categories, finding severity counts, turns, duration, cost, version, surface, OS, and a random install id. No IP, no free text. It cannot tell an Agent run from a manual one, whether a finding was fixed, or whether CI was involved. Keep the same boundary: counts and enums only, never repo names, file paths or text. All events honour the existing opt-out.

Events to add (counters and finite labels):
- `agent_run`: trigger kind (`schedule`, `manual`, `github-pr`, `ci-failure`), preset id, access level, outcome (`ok`, `failed`, `budget`, `nothing-to-do`).
- `fix_proposed`: class (`dependency`, `workflow`, `config`, `secret`, `other`), verified yes or no.
- `fix_outcome`: `pr-opened`, `merged`, `closed-unmerged`, `edited-then-merged`, each with days since proposal. Merged and closed come from polling the pull request the Agent opened.
- `digest_sent`: channel, empty or not, opened or clicked is not collected.
- `repos_connected`: a count of watched repos per install, bucketed (1, 2-5, 6-20, 21+).
- `memory_used`: count of memories applied in a run, and `memory_rejected` count.
- `first_value`: one-time, minutes from install to first visible result.
- `team_invite`: count only.

An install that opts out cannot be counted. Say so beside every number and treat it as a floor.

## 5. Moments of delight, and anti-patterns

Build first:
1. "47 alerts, 31 closed, by Friday": a before and after count in the digest, with the pull requests that did it. Nobody else shows the burn-down caused by their own tool.
2. A red build that fixes itself: the failed check on `main` becomes a draft pull request with the one-line cause, and the check goes green. The user did nothing.
3. "I remember you rejected this": a pull request description that says which earlier rejection it followed, and a one-click way to forget it.

Anti-patterns (each makes the product noise):
1. Unreviewed pull request spam. Cap open pull requests per repo (suggest 3), never open a second for the same alert, stop after two rejections in a row until a person says continue.
2. Comments on every pull request. The `--comment` default of off is right. Reviews of other people's pull requests are opt-in per repo, and edit one comment in place.
3. A digest that always sends. An empty week is no message. A digest of raw findings with no action, or one that repeats last week's list, trains people to ignore it.

Also avoid: a model bill the user did not expect (show spend per run and per week in the digest, honour the budget cap), and running anything on the host that touches the user's package manager without telling them.

## Open questions

- Does the first screen say what 0 will do before it asks for a key and GitHub access?
- Should `0 fix` be the front door, with Threads and Agents as what you graduate to? This study says yes for single-player.
- Who owns a GitHub App (see `github-connect.md`)? Check runs and a per-repo install depend on it.
- Free versus paid is a line to test with real teams after activation is measured. This document does not set it.
