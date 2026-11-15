# Positioning options and how we make money

Status: **proposal for the owner, nothing here is approved.** README, docs landing text and UI copy are not changed by this file. Evidence was read from `origin/main` (dfc71260), the running dev console and public pricing pages on 2026-11-15. Where something was not verified it says so.

The earlier idea (lead with the open-source pull request reviewer, "runs on your own infrastructure with your own model") is **not** assumed. Self-hosting and your own model keys are a trust line under the headline, not the headline.

## 1. The wedge: four open options

| Option | One line | For | Against | Cheapest test |
| --- | --- | --- | --- | --- |
| A. Pull request reviewer | "Security review on every pull request." | Concrete, visible in the first week, easy to compare. The code path exists (`github-pr` trigger, comment option, forks and drafts skipped). | Crowded: CodeRabbit sells PR security review inside its $90/user Advanced plan. First-run path today is long (see appendix). | Record the 5-minute demo below on three real repositories; count how many a stranger could finish without help. |
| B. Always-on teammate for a repo and its dependencies | "Watches your repository and dependencies, tells you what changed." | Matches the Agents model (standing job, budget, memory). Recurring use gives a reason to pay. | Hardest to demo in five minutes; value shows after days. | Run Dependency Watcher plus PR Security Reviewer on 5 design-partner repositories for two weeks; ask what they would miss if it stopped. |
| C. Build your own security agents | "Write a job, give it scope and tools, let it run." | Fits the existing product (Agents, skills, plugins, CLI). Strong for security engineers and consultancies. | Abstract; "framework" wording invites comparison with agent toolkits, not security tools. Smaller buyer. | Ask 5 security engineers to build one agent from the docs alone; time it. |
| D. LLM and agent red team | "Test your AI app or agent before attackers do." | Hot budget line, closest to what Promptfoo monetises. We already scan MCP endpoints and LLM apps. | Promptfoo is the incumbent with a free tier of 10k probes a month; we would be second. | Ship one `0 scan` example against a public vulnerable LLM app and publish the report. |

Recommendation to discuss, not decide: test A and B together with the same design partners (one product, two entry points), because both are the same Agent with different triggers, and keep C and D as proof of depth rather than lead messages.

### Category line options (pick by what the first user does, not by how we feel)

1. "Security agents that review every pull request and watch your dependencies." (A+B)
2. "An open-source security teammate that works in your repositories." (B)
3. "Open-source agents for application security." (C, broadest, least specific)

### Trust line (under any headline)

"Open source. Runs on your own machine or server, with the model and keys you choose. Nothing leaves it unless you turn it on." Keep it to one sentence, below the headline.

### 5-minute demo script (option A, works with today's code; the web steps are the long part)

1. `gh auth login` (once), then `0` and open the console. Expected: browser app, New thread screen.
2. Settings, Models: add a key. Expected: a model name shows on the composer.
3. Agents, **Create an agent**, preset **PR Security Reviewer**, Create. Expected: paused Agent page.
4. Settings tab: add the repository under Repositories, Save. Overview: turn the Agent on.
5. Automations tab, **Set up** next to "Review pull requests", then Add trigger: GitHub pull request, `owner/name`. Leave comment off. Turn the trigger on and approve.
6. Open a small pull request that adds an obvious flaw (string-built SQL). Expected within about 60 seconds (poll interval): the trigger shows a run, the Activations tab lists it, **Open** shows the Thread with findings. No comment appears on GitHub.
7. Optional: `0 agents triggers check <agent> <trigger>` to poll immediately instead of waiting.

The old pull requests are never reviewed: the first poll only records them. That is the biggest gap for a demo (appendix).

## 2. What to build next (ranked)

1. **One guided path to a first result**: connect check, repository, "try it on an open pull request". Without it no option above can be tested with strangers.
2. **Result you can paste**: summary line, Findings count, copy as pull request comment.
3. **Second-run state** on the Agent page: last reviewed pull request, findings, time.
4. **Honest docs for one job end to end**, including the CLI line (`0 agents create --preset pr-security-reviewer` exists; `--repo` does not).
5. Dependency Watcher as the second Agent (option B).
6. Only then: team features (sharing, history) that the paid model below depends on.

## 3. What to stop saying

Wording audit, nothing changed yet. "Find / prove" claims everything; the product reviews, watches and reports. "Platform" and "framework" describe how we are built, not what the user gets.

| File:line | Current | Proposed |
| --- | --- | --- |
| README.md:28 | "open-source framework for building and deploying security agents. They find vulnerabilities across ... prove them, fix them, verify the fix and keep watching. It runs on your own infrastructure, with the LLMs you choose." | One sentence of what it does for the chosen wedge, then the trust line separately. Example: "Open-source security agents that review your pull requests and watch your dependencies." |
| docs/src/content/docs/index.mdx:3 | same "framework ... find ... prove" description | Same replacement, shorter (search snippet). |
| docs/src/content/docs/index.mdx:12 | same text as meta description, plus "runs on your own infrastructure" | Same replacement; trust line only on the page body. |
| docs/src/content/docs/index.mdx:8 | "Build and Run Security Agents" | "Security agents for your repositories" |
| README.md:76 | "**Find vulnerabilities** in source code, web apps and APIs, MCP endpoints and packages" | "**Review** code, web apps and APIs, MCP endpoints and packages" |
| README.md:103 | "Proven in public" | "Disclosed in public" (it is a record of disclosures; "proven" overclaims for every finding) |
| docs/src/content/docs/index.mdx:80 | "describe the job, for example 'Review ./my-app for injection bugs and verify what you find'" | Keep "Review"; drop "verify what you find" unless verification is on by default. |
| docs/src/content/docs/index.mdx:106 | "Find and fix vulnerable packages." | "Check dependencies and propose upgrades." |
| docs/src/content/docs/agents.md:3 | "Standing watchers with a scope, ..." | Fine, but line 6 "persistent agent" repeats the word; use "A named job that runs on its own". |
| packages/web/src/console/home-context.ts:70 | empty-state chip "Find context" / "Explain this folder" | No "find"; first chip should be the wedge (for A: "Review pull requests"). Naming is an owner decision. |
| packages/web/src/console/agent-onboarding.tsx:66 | "Set up your coding agent" (first thing on the empty state) | Keep, but below the wedge action. |

"Platform" and "framework" appear only on the lines above in the files audited (README, docs index, web empty state). Other pages were not audited.

## 4. How we make money

### 4.1 What the market charges (public pages, 2026-11-15)

| Vendor | Unit | Numbers | Free includes | Paid adds |
| --- | --- | --- | --- | --- |
| Promptfoo | contact sales | Community free; Enterprise and On-Premise custom | Evals, CI, local or self-host, 10k red-team probes a month | Team sharing, continuous monitoring, compliance dashboard, SSO and permissions, API, managed cloud, SLA; On-Premise adds own infra, dedicated runner, deployment engineer |
| CodeRabbit | per user | $30/$60/$90 per user a month monthly ($24/$48/$72 annual); 1/5/10 linked repos; overage $0.25 per reviewed file | (page lists paid tiers) | PR security review only from Advanced; SSO, audit logs, SLA in Enterprise |
| Semgrep | per contributor | Free up to 10 contributors and 10 repos; Teams from $30 (Code, Supply Chain) and $15 (Secrets) per contributor a month | Scanning for small teams | SSO, RBAC, more repos, support |
| Socket | per developer | Free 1 seat; Team $25, Business $50 per seat a month (5 and 20 seat minimums) | Malicious package blocking, PR warn | Reachability, ticketing, SSO at $50, SCIM and audit log in Enterprise |
| Snyk | contributing developer | Free 5 projects; Team from $25 a month (up to 10 developers); Enterprise prepaid credits at $1 each, e.g. 1.0 credit per active contributor per day, 4,000 credits per AI pen test | Limited tests | Projects, integrations, credit pool |
| ProjectDiscovery | seat | Free 1 seat; pay-as-you-go $200 per seat a month ($2,100 annual) up to 5 seats | Limited one-time usage | Dedicated sandbox, frontier models; Enterprise adds SSO, BYOK, on-prem |

Pattern: free for individuals and small teams, per-seat or per-contributor for teams ($15 to $90), and SSO, audit, roles, SLA and private deployment reserved for custom contracts. Only Snyk and CodeRabbit bill by use. Contributor means "committed in the last 90 days" at Semgrep, Socket and Snyk.

### 4.2 What we already have that a customer could pay for

Open source today (verified in the repo docs): server mode and compose image, team accounts with owner, editor and viewer, OIDC, local audit log, Findings API tokens, GitHub Action, Agents with budgets and a review gate, remote Computers.

Decided in `docs/design/enterprise-edition.md` and `deployment-packaging.md`: enterprise is a separate private repository (gateway in front of the engine, SAML, SCIM, custom roles, audit export, license file verified offline, signed policy); on-prem and vendor-run single tenant are **by contract only**; **no hosted inference**, no self-serve multi-tenant cloud. Four of five open-source seams were reverted, so enterprise code does not yet have hooks in this repository, and no license key is pinned.

Also exists: the private 0cloud repository documents a hosted, metered product (PR Security, Code Security Audit, Dependency Security) with prepaid workspace credit and per-run price rules, kept internal and not shown on the website. Numbers are deliberately not copied into this public file; Fabian should read `0cloud/docs/decisions.md` (Pricing) next to this page.

Missing: any public price, a billing path for open-source users, hosted offer for individuals, team history and sharing in the open product, a customer who has paid.

### 4.3 Three candidate models

| | Per-seat teams | Per-repository Agents | Metered hosted runs (0cloud) |
| --- | --- | --- | --- |
| Buyer | Security lead or engineering manager at a 10 to 200 developer company | Same, for a few critical repositories | Founder or CTO without a security team |
| Unit and price hypothesis | Per contributor, $20 to $40 a month, free up to 5 contributors (Semgrep, Socket range) | Per repository with Agents on, $50 to $150 a month, free for 1 repository | Per completed run, whole-dollar minimum, prepaid credit (Snyk and 0cloud pattern) |
| What we sell | Shared history, team Memory, roles, SSO, audit export | Agents kept running, scheduled scans, comments, dependency watch | We run it, they do nothing |
| Gross margin | High: users bring their own model keys, we resell no tokens | High, same reason | Lower and variable: we pay inference and sandbox, margin is the price multiplier; contradicts "no hosted inference" unless the owner reverses it for 0cloud |
| Sales motion | Bottom-up: free CLI, one engineer, team invite, upgrade | Bottom-up per repository, easy to start, hard to expand | Self-serve checkout, no sales |
| Free must include | Everything one person needs, including CI and PR review, plus 1 repository | Full Agent for 1 repository | Small monthly credit so the first run costs nothing |
| Paid need appears when | A second person asks to see the same Findings | A fifth repository needs the same setup | The first run is wanted without setting up a model key |

A sales-led enterprise contract (SSO, on-prem, SLA) sits on top of any of them and is what the existing design already assumes.

### 4.4 Cheap validation before Nov 23

Five design-partner questions:
1. Who else reads the output today, and how do they get it (Slack, ticket, screenshot)?
2. What would you have to see in a quarter to keep paying, and who signs?
3. Would you pay per person, per repository or per run, and which feels unfair?
4. Which of these must we have before you could buy: SSO, audit export, shared history, support response time?
5. Would you rather run it yourself or have us run it, and why?

Measure from existing opt-out usage telemetry (counts only, no content): weekly active installs, installs that created an Agent, Agents with a `github-pr` trigger turned on, runs per Agent, installs in server mode or with team accounts. Not verified: which of these counters exist in the allowlist; check `configuration.md` Telemetry before promising any number.

Pricing page test: a one-page "Plans" with Free, Team (price shown, button "Ask for access") and Enterprise (contact), no checkout. Count clicks on each. Needs the owner's approval because `0cloud` decisions say no pricing on the website.

### 4.5 What we do not know

- Whether anyone pays for open-source security agents when the free path is complete.
- Whether the buyer is security or engineering, and who holds the budget.
- Whether per seat, per repository or per run matches how value shows up.
- Real inference and sandbox cost per reviewed pull request (0cloud has measurements; not read here).
- Whether we reverse "no hosted inference", and what legal and abuse terms a hosted offer needs.
- Telemetry coverage and volume: current install and active counts were not read.
- Competitor numbers change; prices above are page snapshots, and Promptfoo and Socket enterprise pages list "contact sales".

## Appendix: first-run audit, option A (headless Chromium, dev console, screenshots in /tmp/pr-first-run-shots/)

Path measured with a fresh Agent: landing, Agents (empty: "No agents yet"), Create an agent, Preset menu (11 presets, no search, PR Security Reviewer second), name prefilled, Create, paused Agent page, Settings, Automations tab, Set up (leaves to `/automations`, a 5-step workflow named "Review pull requests", whose step names read as a whole-repository review, not a diff review).

- **7 clicks and 4 screens just to have an owned automation**, then about 8 more (Add trigger, kind, repository, two switches, Add, turn on, approve) and a second screen of scope in Settings. Roughly 16 clicks, then a wait for the next poll.
- **Result needs a new commit.** The first poll only records open pull requests; `Run now` takes a free-text task and does not fetch a diff; `triggers check` only re-polls. So a user with an open pull request cannot see a result without pushing again. This is the main dead end.
- Run now is disabled while paused, and paused cannot turn on without a repository in scope; the repository is then typed again for the trigger.
- Three nouns to reach one behaviour: Agent, Automation, trigger. Tabs say Activations; the run dialog says "chat" where the product says Thread; empty text says "Its standing chat appears after the first run" and "No thread yet" as the Agent's job line when the job is empty.
- GitHub is never connected in this flow. The preset lists "GitHub CLI signed in on this machine" as an input, so the user leaves the app to a terminal (`gh auth login`); a blocked trigger shows only after polling fails. The GitHub connection card lives in Settings (not walked) and the webhook card sits at the bottom of the Agents page, server mode only; GitHub's own webhook screens are an unavoidable external step.
- Landing offers "Set up your coding agent", "Explain this folder" and a setup checklist; nothing mentions pull requests.
- CLI: `0 agents create --preset pr-security-reviewer` works but has no `--repo`, no positional preset and no trigger creation; `0 agents triggers add` needs an automation id that the CLI cannot create from a template (not found in `commands/sentinels.ts`). Docs `agents.md` show the CLI create line only for `pen-tester` and give no end-to-end pull request example.
- Docs consistency: `ci/github-action.md` correctly says the Action never comments and points to Agents; `agents.md` calls the Agent "a persistent agent" and "standing watchers" in one page; `docker.md` and `agents.md` both describe the webhook but only `agents.md` says polling is the fallback.
- Not walked: GitHub connection card, a real run on an open pull request, reading the result and the second-run state (no `gh` account in the sandbox home; a run would also spend model credit).
