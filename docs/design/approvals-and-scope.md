# Approvals and scope: one simple model

Status: proposal for the product owner. Date: 2026-11-14. No code changed.
Sources: Capy's live app (read-only, logged-in session, screenshots kept
outside the repo) and docs.capy.ai (`admin/security`, `machines`, `desktop`,
`secrets`), plus an audit of `origin/main` at c66f2121. No credentials were read.

Owner's question: we should not have YOLO anywhere, and "Ask before acting /
Act without asking" plus scopes and permissions feels over-complicated. Does
Capy have something else?

## 1. Short answers

- Capy has **no per-thread approval or autonomy control at all**. The composer's
  tune icon holds machine size, setup, env vars, MCP servers, pin, folder, tags.
  Reasoning effort and Fast are a separate chip. An agent just acts.
- Capy's safety comes from **where it runs**, not from prompts. A cloud thread is
  a Firecracker microVM where everything is allowed. A thread on your own device
  runs as you and the docs say plainly it "isn't a sandbox". The only prompts are
  at the **boundary**: using a device you did not pre-approve, and clicking or
  typing in apps (computer use).
- We have four stacked concepts (mode, scope plugin, scope rules, decisions) and
  two vocabularies (threads vs Agents). Most of the complexity is naming and
  duplication. The one genuinely safety-critical piece, not testing unauthorized
  third-party targets, is real, must stay, and is currently weaker than the UI
  suggests (see 3.4).

## 2. What Capy does (facts, with confidence)

Evidence: live app screenshots and DOM text (high), docs.capy.ai (high).

| Topic | Capy behaviour | Confidence |
|---|---|---|
| (a) Composer options | Chips: Project, Run on (Cloud / Other devices), `+` (attach, env vars, context), **Thread configuration** (sliders icon: Machine size "4 CPU / 16 GB", Setup and snapshots, Environment variables, MCP servers, Pin, Folder, Tags), Model, **Model configuration** (Reasoning: Low, Medium, High, Extra high, Max; Modes: Fast switch). No plan/build mode, no permissions, no approval option anywhere in the composer. | High, seen live |
| (b) Approvals | No "approve this command" UI for the agent's commands. Approval prompts exist only for resource access: per-thread request to use a device, per-thread request to message a device thread ("Allow request" shortcut), and a one-time prompt for computer use. Rules never to merge a PR, never expose secrets and never fabricate results are hard-coded and cannot be overridden by AGENTS.md. | High (docs and device page), medium on exact prompt copy (not triggered) |
| Auto-approve settings | Per **device**, not per project or thread: Settings > Devices > device > Access: **Personal** (only your threads; your other threads ask) or **Shared** (team can run on it). "Agent access: Every thread of yours may use this device without asking" with value **Always allow** (other value: ask). "Computer use: Every thread asks you once before Capy clicks or types in applications on this device; Always allow in that prompt switches this" with value **Ask each thread**. "Looking at the screen never asks." | High, seen live |
| Automations | "Runs as: Each run uses this person's access, models and bill". Limits: "Max runs per day: Extra events are skipped and start no thread". Machine size per run. | High (earlier notes plus live) |
| (c) Cloud vs device | Cloud: isolated microVM, public internet reachable, Tailscale off until connected, hold no GitHub token, deleted 30 days asleep. Device: "the agent reads and edits files and runs commands as you, under your local git identity, even when a teammate starts the thread. A linked folder sets where the agent starts, but it isn't a sandbox." | High, docs |
| (d) Scope | No allowed-repos/branches/domains concept on the agent. Repo reach = which repos the GitHub App installation covers and which repos the project contains. No egress controls (public internet open; private reach only via Tailscale ACLs). Secrets: agent sees variable names, never values; values are on the machine so "code the agent runs can read anything on the machine"; advice is scoped, revocable credentials. | High, docs |
| (e) Settings pages | Security = sign-in only (2FA, backup codes, passkeys). Identity and access = domains, SSO, MFA. Devices = Access / Agent access / Computer use. Threads = concurrent subagents (8), nesting depth (3). Git = PR behaviour. Cloud credentials = OIDC. No permissions page. Screenshots: `/tmp/capy-perms/` (01 to 18). | High, seen live |
| (f) Copy worth borrowing | "Every thread of yours may use this device without asking", "Always allow", "Ask each thread", "asks you once", "Looking at the screen never asks", "isn't a sandbox", "Extra events are skipped and start no thread". Plain sentences, a verb the user already knows, no mode names. | High |

Not verified: the exact text of the per-thread "Device access" submenu and the
device-request prompt (a prompt cannot be triggered read-only; the thread menu
item did not open reliably). Everything else above was read directly.

Lesson: Capy asks **once, per resource, at the boundary, and remembers**. It
never asks per action. It separates "sandboxed so allowed" from "on your machine
so you chose the folder and the device".

## 3. What we have today

### 3.1 Autonomy modes (the approvals axis)

Engine type `ConsoleAutonomyMode = standard | copilot | yolo | recon`
(`packages/engine/src/console/turn-engine/types.ts`), mirrored in
`DesktopConsoleAutonomyMode` (`engine/src/shared/desktop-console.ts`, default
`yolo`) and persisted in the session checkpoint (zod enum in
`console/session-checkpoint.ts`).

| Value | Meaning in the engine | Where users see it |
|---|---|---|
| `standard` | Every effectful tool is put to the operator (`approveTool`); out-of-scope targets and paths go through `requestScope` and `requestLocalScope`. | Web "Ask before acting"; docs app.md; CLI `--mode standard` |
| `yolo` | No per-action prompts. **Also changes capabilities**: enables `publicNetwork` for public-network tools, full shell syntax, lifts the source-audit allow-list, auto-grants any non-dangerous local path, auto-expands target-related hosts, asks only for unrelated named hosts. Default for new threads and CLI. | Web "Act without asking"; CLI `--yolo`, `--mode yolo`; docs commands.md, app.md, scope.md; prompt text "YOLO mode:" in `prompt-and-runtime.ts`; many tests |
| `copilot` | Like yolo but only inside the established engagement. | Hidden in the picker; legacy label "Auto" in `mode-picker.tsx`; selectable in CLI and `0 missions` |
| `recon` | Passive, read-only; effectful tools refused, never prompted. | Hidden; legacy label "Recon"; Agents "Report only" maps to it |

Surfaces:

- Composer: sliders icon with a two-item menu (`console/mode-picker.tsx`,
  `autonomy-options.ts`). Tooltip reads "Options: Ask before acting".
- Thread settings, Permissions card (`components/console-control/system-control.tsx`):
  Focus, Scope rules (in and out textareas), "Autonomy" select, a checkbox "I
  confirm actions run without asking first" for yolo, and a second checkbox
  "Folder and scope reviewed". Saving needs both.
- CLI: `0 lab console --mode <standard|recon|copilot|yolo>` (default yolo),
  `--yolo`, `--scope <file>` (headless yolo requires an `in_scope` entry only when
  scope enforcement is on). `0 missions --mode`. `0 campaign` hard-codes
  `autonomyMode: "yolo"`. `scripts/sync-cli-docs.mjs` pins the doc text.
- Agents (Sentinels, `web/src/sentinels/model.ts`, `cli/src/web/sentinel-runner.ts`):
  **Approval** = "Report only / Ask first / Act on its own", mapped
  `observe -> recon`, `propose -> standard`, `act -> yolo`; **Access** = "Read only
  / Read and web / Run commands"; plus Targets, Off limits, Production switch,
  Daily budget, Runs per day. Untrusted triggers force `recon`.
- Automations (`components/automations/automation-form.tsx`): a URL field labelled
  **Scope** ("Only test what you are authorised to test"), approval gates
  `launch-authorized-run` and `enable-reviewed-trigger`, run caps per Agent.
- Env: no YOLO env variable exists. The strings `yolo` appear in 66 files:
  engine core, CLI, web labels (internal key), docs, CHANGELOG and tests.

### 3.2 Scope (the authorization axis)

- **Scope plugin** (`engine/src/scope/*`): off by default (`0 plugin enable
  scope`). When off, host checks, exclusions and local filesystem scope are not
  enforced; SSRF/private-network blocking, credential protection, sandboxing and
  limits still apply. `ZERO_REQUIRE_SCOPE=1` / `scan --require-scope` makes
  unscoped local runs fail, but only if the plugin is on.
- **Scope policy** (`in_scope`, `out_of_scope` hostnames, wildcard, IPv4 CIDR;
  exclusions win): `--scope <file>` on scan, console, campaign.
- **Local scope**: `localScopePath` ("Limited to ..."), set from the chosen
  workspace; `requestLocalScope` asks for other directories; yolo auto-grants.
- **Allowed hosts**: `--allowed-host` / `ZERO_ALLOWED_HOSTS` is server-mode Host
  header allow-listing, unrelated to testing targets (name collision only).
  `ZERO_TARGET_ALLOWED_HOSTS` is a scan target host allow-list.
- **"Scope" in the UI means four different things**: the thread's In scope / Out
  of scope textareas; the Automation URL field; the Agent run dialog row listing
  Targets; and a card title on the scan detail page that is only metadata
  (target, times, mode). There is no literal "authorized engagements" object; the
  closest are `--engagement-profile` (pacing posture) and attribution headers.

### 3.3 Decisions UI

`web/src/console/approvals.tsx` renders five decision kinds produced by the
gateway (`cli/src/web/console-gateway.ts`, `#decisionCallbacks`):

| Kind | Card label | Today |
|---|---|---|
| `tool` | Tool use, "Allow this one tool action." | Only in standard |
| `scope` | New targets, "Allow targets" | Standard, copilot out-of-engagement, yolo unrelated hosts, shell with unresolvable destination |
| `local-scope` | Folder access, "Allow folder" | Standard; yolo auto-grants |
| `audit-escalation` | Beyond code review | Source-audit threads |
| `operator-question` | Question, "Answering doesn't grant any permissions." | All modes |

Grants are in-memory per thread (`Nothing is persisted as authorization`); denied
hosts and paths are remembered per thread. Switching to Auto resumes pending tool
approvals but leaves scope, folder and question cards alone (app.md).

### 3.4 Isolation and what protects third parties

- Workbench: SmolVM microVM (Kali guest) running the whole harness, with explicit
  provider and network grants; host execution is the other profile
  (`docs/architecture.md`, `configuration.md`). `run_command` on host is "not a
  sandbox".
- Always-on rails regardless of mode: credential protection, private-network and
  loopback blocking (SSRF rail), dangerous-local-root refusal, resource budgets.
- What stops the agent attacking a stranger's host is **only** the scope layer:
  `requestScope` asking for an unrelated named host, and, when enabled, the
  scope plugin. In yolo with the plugin off (the default) a target given in the
  prompt or discovered as "target-related" is allowed without a recorded
  authorization, and the docs say "No mode grants testing authorization". So the
  legal safeguard is mostly policy text plus the ask-for-unrelated-hosts rule.
  This is the weak spot to fix, independent of the approvals UX.

### 3.5 Overlaps and contradictions

1. Two vocabularies for the same thing: "Ask before acting / Act without asking"
   (threads) vs "Report only / Ask first / Act on its own" (Agents), each mapped
   to the same four engine modes.
2. Agent **Approval** x **Access** is redundant: "Report only" with "Run commands"
   is contradictory (recon refuses exec anyway); "Act on its own" with "Read only"
   has nothing to approve.
3. `yolo` is not only "don't ask": it also unlocks capabilities. Renaming the label
   without untangling this risks a silent safety change.
4. Auto-mode confirmation is asked up to three times (YOLO checkbox, scope
   checkbox, then per-thread cards) while the default for new threads is already
   yolo.
5. Default is yolo, but docs say "use a scope file for every live target" and the
   scope plugin is off. Defaults and guidance disagree.
6. Hidden legacy modes: the composer shows two, the engine has four, `copilot` is
   labelled "Auto" (which would collide with the proposed Auto).
7. "Scope" names four things (3.2). "Allowed hosts" names two unrelated things.
8. Three layers of grants (tool, target, folder) each with its own card and copy.

## 4. Proposal: fewest user-facing concepts

Two user-facing concepts, each with plain language:

1. **Approvals**: Ask or Auto. Per thread. What happens when the agent wants to
   change something.
2. **Targets**: which outside systems you are authorized to test. Asked once per
   target, remembered. The only "scope" users ever meet.

Everything else is either implied (the folder you chose, the sandbox you run in)
or internal.

### 4.1 Approvals (one control, two states)

- Label **Approvals** with values **Ask** ("Asks before each change") and **Auto**
  ("Works without asking. Still asks before testing a new target."). No mode
  names, no YOLO, no icons that imply danger.
- Shown in the composer as a small chip only when it matters: threads whose role
  can run effectful tools. Hidden for read-only threads and Agents with read-only
  access, because nothing can ask.
- **Ask** prompts only for effectful actions (writes, shell, network requests that
  change state). Read-only tools never prompt. A card has "Allow once" and
  "Allow for this thread" (remembered by action class, not by raw command).
- **Auto** never skips the Targets prompt (4.2) or the hard rails (credentials,
  private network, dangerous roots, budgets).
- Agents: the same two states plus **Report only**, which is not a third setting
  but the derived label when Access has no effectful tools (Read only, or Read and
  web). The Agent form becomes **Access** (Read only / Read and web / Run
  commands) with **Approvals** (Ask / Auto) shown only when Access is Run commands.
- Default (recommended): **Ask where there is no sandbox, Auto inside the
  workbench microVM and for read-only roles**. One sentence in the UI explains it:
  "Auto is on because this thread runs in the sandbox." New automations and
  Agents start with Ask. This mirrors Capy: sandboxed = allowed, your own machine
  = you decide.

### 4.2 Targets (the one real safety boundary)

- One concept, one place: a **target authorization** record
  `{host pattern, who confirmed, when, project}`. When a thread or Agent first
  needs an external, non-loopback, non-private host, a single card asks "Are you
  authorized to test `host`?" with **Allow for this thread**, **Always for this
  project** and **Don't allow**. Remembered, listed in Settings > Targets (view,
  remove), and passed to automations headless.
- The thread's Focus field, In scope and Out of scope textareas, the "Folder and
  scope reviewed" checkbox, the Agent Targets list and the Automation "Scope" URL
  collapse into: **Target** (what you want tested; typing a target is the
  authorization act, with a one-line attestation on first use) and **Off limits**
  (exclusions, always win, kept as is).
- Local folder: **the chosen folder is the scope.** No scope decision for paths
  inside it, no "Limited to" text, no checkbox. Paths outside it keep the
  existing floor (dangerous roots refused) and, in Ask, the Folder access card.
- Headless runs (automations, CLI): no prompt channel, so only the declared Target
  and Off limits apply and anything else is refused with a clear message. This is
  today's behaviour, now stated once.
- Safety fix included: external-target authorization is **always on**, not tied to
  the plugin toggle (see decision 2). The plugin remains for advanced policy files,
  but the "no authorization recorded" state for third-party hosts disappears.

### 4.3 Naming and migration

- No `YOLO` in UI, docs, CLI help, error messages, prompts or the changelog going
  forward. Replace with Approvals: Ask / Auto.
- CLI: new visible `--approvals <ask|auto>` and `--auto`. Keep `--yolo`, `--mode
  <standard|recon|copilot|yolo>` as **hidden aliases** (accepted, undocumented, no
  deprecation noise), including conflict errors reworded without "YOLO".
- Storage: **do not migrate data.** Keep the persisted values (`standard`, `yolo`,
  `copilot`, `recon`) and the internal engine type. Add one mapping module at the
  API edge: `ask <- standard|recon`, `auto <- yolo|copilot`, writes use the
  internal values. Audit event names and checkpoint enum stay internal. Legacy
  `copilot` already displays as "Auto", so it lands in the right place.
- Agents: `observe -> Access capped to Read and web, Report only`, `propose ->
  Ask`, `act -> Auto`. An `observe` Agent with Run commands is shown as Read and
  web (it was already refused exec by recon); note this in the change log.
- Decouple capabilities from approvals before renaming (see risks): an internal
  `ExecutionPolicy` flag set (`publicNetwork`, `fullShell`, `liftAuditAllowList`,
  `autoGrantLocalPaths`) derived from mode, so Auto is behaviour-identical to
  today's yolo and tests assert it.

### 4.4 What to remove, rename, merge, keep

| Action | Item |
|---|---|
| Remove (user-facing) | `YOLO` strings; the two confirmation checkboxes in the Permissions card; "Recon" and "Co-pilot" as visible modes; scope-plugin on/off as a user decision for external targets; "Limited to" local scope text; the Scope card title on scan detail (rename to "Run details"). |
| Rename | "Ask before acting / Act without asking" to **Ask / Auto** under the label **Approvals**; Agent "Approval" to **Approvals** and "Report only / Ask first / Act on its own" to the derived model; Automation "Scope" to **Target**; Permissions card to **Approvals and targets**; "New targets" card to **Authorize target**; "Allowed hosts" in server docs to "Accepted host names" to stop the collision. |
| Merge | Thread Focus + In scope + Agent Targets + Automation Scope into **Target**; Agent Approval + Access into Access with conditional Approvals; tool / scope / folder cards share one card layout and one verb ("Allow"); Daily budget and Runs per day into one **Limits** group (Capy uses "Limits" the same way). |
| Keep | Off limits exclusions (always win); `operator-question` card; hard rails (credentials, private network, dangerous roots, budgets); scope policy file for advanced and CI use; run caps; workbench isolation; `ZERO_REQUIRE_SCOPE`; "scope is not OS isolation" warning; attribution headers and engagement profile. |

## 5. Files and areas to touch

Sizes: S under half a day, M about 1 to 2 days, L 3+ days.

| Area | Files | Change | Size |
|---|---|---|---|
| Engine policy | `engine/src/console/turn-engine/{types,session,prompt-and-runtime,tool-targets}.ts`, `agent/tools.ts`, `agent/types.ts`, `plugins/guards.ts` | Extract `ExecutionPolicy` from mode with golden tests; reword prompt strings (no YOLO); always-on external-target authorization; remembered target records | L |
| Engine shared | `shared/desktop-console.ts`, `console/session-checkpoint.ts` | Add `approvals` mapping helpers; keep enum; default selection by execution profile | S |
| Engine scope | `scope/{activation,scope-guard,enforcement}.ts` | Always-on external-host check, plugin only for policy files; diagnostics copy | M |
| Gateway / API | `cli/src/web/console-gateway.ts`, `local-provider-sessions.ts`, `host-console-worker.ts`, `workbench-console-session.ts` | Accept `approvals: ask|auto` and legacy; decision copy; per-project target store; yolo-specific branches go through policy flags | M |
| Agents | `web/src/sentinels/model.ts`, `components/sentinels/{sentinel-fields,run-sentinel-dialog}.tsx`, `cli/src/web/sentinel-runner.ts` | Access-first form, derived Report only, mapping and migration of saved Agents | M |
| Automations | `components/automations/automation-form.tsx`, `cli/src/commands/missions.ts`, `campaign.ts` | Rename Scope to Target, Limits group, approvals flag, stop hard-coding `"yolo"` | S |
| Web thread UI | `console/{mode-picker,autonomy-options,approvals,conversation}.tsx`, `components/console-control/{system-control,web-settings}.tsx`, `pages/{console-page,workers-page,scans-page}.tsx` | New Approvals chip (conditional), Permissions card rewrite, Settings > Targets list, decision cards copy, scan detail title | M to L |
| CLI | `cli/src/commands/console.ts` (+tests), `dashboard.ts`, `missions.ts`, `campaign.ts`, `scripts/sync-cli-docs.mjs` | `--approvals`, `--auto`, hidden `--yolo` and `--mode`; reworded errors; doc-sync strings | M |
| Docs | `docs/src/content/docs/{app,commands,scope,configuration,architecture}.md`, `docs/CHANGELOG.md` (new entry only; history stays), generated CLI reference | Remove YOLO wording, document Approvals and Targets, default rule, rail list | M |
| Tests | about 40 test files that name `yolo` (turn-engine 76 hits, console-gateway 27, guards, tools, escalation, workbench), `scripts/dashboard-autonomy-modes.test.mjs`, web tests | Keep internal-value tests; add mapping, default-by-profile, hidden-alias, Agent migration, always-on target authorization and Auto-equals-old-yolo golden tests | L |
| Plugin docs | `engine/src/plugins/{DESIGN,SELF-EXTENSION}.md`, `manifest.ts`, `loader.ts` | Reword YOLO mentions | S |

Rough total: 2 to 3 engineer-weeks, mostly the engine policy extraction and tests.
The web and docs rename alone, without the safety fix, is about 3 to 4 days.

## 6. Risks

- **Security regression through the rename.** Because yolo also grants
  capabilities, a naive Auto = standard-minus-prompts could widen or narrow
  behaviour. Mitigation: policy-flag extraction plus golden tests before any UI
  change; ship the engine step first with no visible change.
- **Default change.** Today new threads and the CLI default to yolo. Moving to
  Ask on host execution is safer but changes behaviour for existing users and
  scripted CLI use. Mitigation: existing threads keep their stored mode; CLI
  without a TTY keeps today's behaviour for one release with a one-line notice;
  document the rule.
- **Existing automations and Agents.** Headless runs cannot prompt. Agents saved
  as `act` become Auto, `propose` Ask, `observe` Report only (Access capped).
  Any automation relying on target-related hosts being auto-allowed with no
  declared Target would now be refused. Mitigation: dry-run report listing
  affected automations, and a migration that copies the Agent or automation's
  existing target into its Target list.
- **Always-on target authorization** adds a first-use prompt for people who never
  enabled the scope plugin. That is the intended safety property, but it is a
  visible change; keep the card to one click and remember per project.
- **Remembered grants** must record who, when and project, expire on explicit
  revoke, and never apply to private or loopback ranges (those stay refused).
- **Hiding the control** for read-only roles must not hide state when a thread's
  tools change mid-run; show the chip whenever any effectful tool is enabled.
- **Docs and external references** to `--yolo` in scripts, issues and the
  CHANGELOG: aliases remain, history is not rewritten.
- **Capy comparison caveat.** Capy can skip approvals because its cloud default is
  a throwaway VM and it is not a security-testing product. Our scope boundary has
  legal weight Capy does not need; do not copy its "no scope" stance.

## 7. Open decisions for the owner

1. **Default Approvals.** Recommended: Ask on host execution, Auto inside the
   workbench and for read-only roles; new Agents and automations start at Ask.
   Alternative: keep Auto everywhere (least disruption, weakest default).
2. **Make external-target authorization always on.** Recommended: yes. Third-party
   hosts always need a remembered "I am authorized" confirmation, the scope plugin
   becomes advanced policy only. Alternative: leave the plugin off by default and
   only rename (cheaper, keeps the weak spot in 3.4).
3. **Agent model.** Recommended: Access first, Approvals shown only for Run
   commands, "Report only" derived; migrate `observe` Agents to Read and web.
   Alternative: keep the three-way Approval select but relabel it to Ask / Auto /
   Report only (smaller change, keeps the Approval x Access redundancy).
