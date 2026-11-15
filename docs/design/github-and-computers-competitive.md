# GitHub connection and machine setup: competitive memo

Status: decision memo for the product owner. Date: 2026-11-14.
Sources: public docs of Capy and Conductor, read-only inspection of the locally
installed apps, and an audit of this repo. No credentials were read.
"Cabbie" returned no results anywhere; we assume it means **Capy** (the user's
spoken name for it). Correct us if it is a different product.

## 1. The hypothesis: "they solved it because they are cloud, right?"

Short answer: **half right, and the half that is wrong matters.**

### GitHub connection

| Product | Cloud or local | Mechanism | Evidence / confidence |
|---|---|---|---|
| Capy cloud | Cloud | GitHub App installed by an org owner or admin; clone/fetch always via the App; push and PR as the commit author (you, or `capy-ai[bot]`); cloud VMs hold no GitHub token | docs.capy.ai/integrations/github.md. High |
| Capy desktop (paired device) | Local | Your own git credentials in a local worktree, "not a sandbox", no machine-time charge | docs.capy.ai/desktop.md. High |
| Conductor cloud (v0.78.0) | Cloud | GitHub App, multi-org, up to 50 repos | Changelog 0.78.0. High on App, low on VM-side token handling (undocumented) |
| Conductor local (macOS app) | Local | User's own `gh` login. Docs: "expects GitHub authentication to work in your terminal environment"; fix is `gh auth login`. Ships a bundled `gh` 2.100.0 | conductor.build/docs/installation and troubleshooting; bundle inspected. High on gh reliance, medium on whether the bundled gh shares the terminal login |

So the user's hypothesis holds for the **cloud** products and fails for the
**local** ones. Conductor's local mode has exactly our situation and solved it
the way we do: reuse `gh`. Capy's local desktop path does the same thing with
the machine's credentials. Neither hides the local problem; they avoid it by not
owning a token locally. Conductor's own troubleshooting docs and a "gh auth
timeout" changelog fix show that this approach carries a real support burden
(expired or missing gh login).

### Machine setup

| Product | Cloud or local | Model | Confidence |
|---|---|---|---|
| Capy cloud | Cloud | Isolated VM per project; `.capy/setup.json` (`initialize`, `refresh`, startup) plus hourly snapshots; ~1-2 s boot | High (docs) |
| Capy devices | Local or BYO | Desktop app pairs the computer as a "device" (macOS, Windows, Linux app); headless Linux uses a "Dock CLI" with no public docs; device threads pause up to 24 h while offline | High for app, none for Dock CLI |
| Conductor local | Local, macOS only | Git worktrees on your Mac; no way to point at your own SSH host | High (docs, comparison sites) |
| Conductor cloud | Cloud | Shared "Cloud computer" per org (install script, env, secrets, versioned builds, rollback); Vercel microVMs; paid plan | High |

Machine setup is where "because they are cloud" is mostly true. Capy's snapshots,
parallel clean VMs, always-on runs and webhook triggers are cloud features.
But Capy also ships the hybrid: the same threads on a cloud VM or on a paired
local device, with handoff through Capy's cloud. Conductor has no bring-your-own
machine path at all. We already have one (`0 worker deploy --ssh/--lima`).

## 2. Comparison table

| Product | GitHub auth mechanism | PR creation | Machine / environment model | Install / update path |
|---|---|---|---|---|
| 0 (today) | User's `gh` login; device code via `gh auth login --web`; paste token via `--with-token`; no OAuth app or GitHub App | Local `gh` and `git` in `pr-emitter.ts`; dry run if `gh auth status` fails | Local engine on 127.0.0.1; remote engines via `0 worker deploy --ssh/--lima`, bearer token plus SSH tunnel; no GitHub credentials on the remote | npm/CLI; remote install is a manual deploy command |
| Capy cloud | GitHub App (+ optional per-user connection) | By App or commit author, co-author modes, optional signed commits | Per-project VM, setup.json, snapshots | Hosted |
| Capy desktop | Local credentials | Local git/gh as you | Local worktree under `~/.capy/worktrees`, paired device | Electron app (.dmg, Windows, Linux); updater not inspected |
| Conductor local | User's `gh` (bundled 2.100.0) | `gh` and GitHub API; Checks tab can gate merge | Local worktrees, macOS only | Native/Tauri-style app, drag to Applications; first-launch tool check |
| Conductor cloud | GitHub App | Via App, GitHub only | Org "Cloud computer", microVMs | Hosted |
| Cursor / Codex cloud | GitHub App (search-level evidence) | App | Hosted agents | Hosted |
| Warp | GitHub App plus per-user OAuth (search-level) | App | Local terminal plus cloud agents | App |

## 3. What a local-first product can do better, and what it cannot

Legitimately better (and what we already do):
- Reuse the machine's `gh`, git credential helper and SSH keys. No second
  credential system, no token held by us, no account required, repos never
  leave the machine.
- No per-seat machine charge; works on any git host the user's git already
  speaks (today we hardcode github.com; fixable).
- Remote engines on the user's own servers with the console dialing out.
- Privacy story: code and chat stay on the user's machines.

Not possible without a cloud (or at least hosted) piece:
- Webhook-triggered work (PR opened, CI failed, Slack/Linear) when no machine
  is online.
- GitHub App installation tokens refreshed centrally, org-wide install with
  fine-grained revocable permissions, and "bot" authorship.
- Pairing relay: a laptop and a phone or a NAT-ed server finding each other
  without a manual SSH tunnel, plus cloud/device handoff.
- Hosted runners: clean per-task VMs, snapshots, always-on runs when the laptop
  sleeps.
- Central audit, SSO and RBAC across a team (see `enterprise-edition.md`).

Known weakness of the local path (evidence from Conductor): it breaks when the
gh token expires or is missing. We should surface that state clearly, not hide it.

## 4. Recommendations, three tiers

**Now (no hosted component).** Ship what branch `feat/github-connect` is
building: reuse `gh`, device-code sign-in driven through `gh auth login --web`,
and a guided fine-grained PAT path for users without gh or with restricted
accounts. Add: clear "unavailable / expired" states, a GitHub-host setting
instead of a hardcoded github.com, and a one-click "copy gh credentials to this
remote engine" (opt-in, explicit) so remote engines can push.

**Next (only if we accept a hosted component).** A GitHub App for PR automation
(webhooks, CI-fix, review triggers, bot authorship) behind a small relay that
stores installation metadata and mints short-lived tokens. Keep gh reuse as the
default for local use; the App is additive, per organization, and optional.
Capy's split is the model to copy: App for clone/fetch/webhooks, user identity
for authorship.

**Later (hosted computers).** Hosted per-task VMs with setup config and
snapshots, only after the App and relay exist and there is paying demand for
always-on runs. Do not start here; it brings tenancy, billing, a token vault and
abuse handling.

## 5. Machine-setup recommendation

The "Add computer" flow (pairing, daemon, relay) is proposed in
`docs/design/computers-auto-install.md` on branch `docs/computers-design`
(commit 16a4aabe, not yet on main). This memo does not duplicate it. The
competitive evidence supports its direction with three adjustments:
- Treat a paired local device as the first-class path (Capy does; Conductor
  lacks it). Our SSH deploy is already ahead of Conductor here.
- Keep the no-relay path (SSH tunnel plus bearer token) working. Capy's own
  device path accepts "offline for up to 24 h" and keep-awake as limits; we can
  too.
- Per-project environment as a committed file (Capy's `.capy/setup.json`
  pattern) is cheap and works for local, remote and later hosted machines.
  Consider that file before any snapshot infrastructure.
- Headless Linux onboarding is Capy's undocumented gap ("Dock CLI"); a single
  documented `0 worker deploy`-style command is a differentiator.

## 6. Open owner decisions

| Decision | Recommended default |
|---|---|
| Do we accept any hosted component (relay, GitHub App backend)? | Not yet. Decide after `feat/github-connect` ships and at least a few users ask for webhooks or always-on runs. |
| Is "Cabbie" a different product from Capy? | Assume Capy; confirm the name, then rerun the comparison if not. |
| Forward gh credentials to remote engines? | Yes, opt-in per host with an explicit prompt; never automatic. |
| Support GitHub Enterprise hosts and non-GitHub forges? | Add a configurable GitHub host now; defer GitLab and Bitbucket. |
| Where does the per-project environment config live? | A committed file in the repo, modeled on `.capy/setup.json`. |
| Merge `docs/computers-design` before or after this memo? | Merge it first as the design; keep this memo as supporting evidence. |

## Known gaps in the evidence

- Capy's GitHub App permission list, how its VMs push without a token, SSO/SAML
  behavior and the Dock CLI are undocumented.
- Whether Conductor's bundled gh shares the terminal gh login, and how its cloud
  sandboxes authorize git, were not verified.
- Cursor, Codex, Warp and Zed lines rest on search snippets only.
- We did not read the web frontend of our own Git settings UI.
