# Connecting GitHub without a pasted token

Status: implemented (options 1 to 3); OAuth App and GitHub App are proposals that need an owner decision.

## Problem

Connecting GitHub meant pasting a personal access token. The console talks to the engine on the same computer, so the engine can reuse credentials that are already there.

## Finding that shaped the design

Every GitHub path already goes through `gh`: repository listing, draft pull requests, the skills catalog, plugin install (`gh auth git-credential`) and sentinels. `gh` resolves its own credential for each call. So the engine does not need `gh auth token` at all. It never reads, caches or logs the token, which is stronger than "read at use time". A pasted token is also handed to `gh auth login --with-token`, so it ends up in the same store.

Consequence: a signed-in `gh` is used automatically. There is no separate opt-in step. Disconnect runs `gh auth logout`, which signs the CLI out of github.com on that computer.

## Options considered

| Option | Needs | Verdict |
| --- | --- | --- |
| 1. Reuse the GitHub CLI login | `gh` installed and signed in | Shipped. Zero clicks. Shows user, scopes and missing scopes. |
| 2. `gh auth login --web` device flow driven by the engine | `gh` installed | Shipped. Code and URL are parsed from output, the URL is pinned to `github.com/login/device`. |
| 3. Fine-grained token with a prefilled creation page | Nothing | Shipped as the fallback. Parameters verified against GitHub docs: `name` (40 chars), `description`, `target_name`, `expires_in` (1 to 366 or `none`), and permissions as `name=level`. |
| 4. OAuth device flow with our own OAuth App | Org-owned OAuth App, client id in the engine | Not built. Removes the `gh` dependency. Scopes are coarse (`repo` grants all repositories). |
| 5. GitHub App with installation tokens | Org-owned GitHub App, private key held by a service | Not built. Best for pull requests: per-repository install, short-lived tokens, PRs attributed to the app. |

## Why 4 and 5 need an owner decision

Both need an app registered under the organization, which is an ownership, branding and liability choice, not an engineering one.

- OAuth App: public client id embedded in the open-source engine (no secret needed for device flow); org owns the app name shown on the consent screen; the scope set (`repo`, `read:org`) is what every user is asked to grant.
- GitHub App: the user-to-server device flow needs the app's client id too. Installation tokens (server-side) need a private key, which means an org-run service. That conflicts with local-first unless it is optional.
- Decisions: who creates the app, which org owns it, the app name and logo, the permission list, whether a hosted token service is acceptable, and who rotates the key.

## Security properties

- All mutating routes (`github/connect`, `github/device-auth`, `DELETE github`) are in the privileged table: browser only, owner only in team mode.
- Audit events: `github.connect`, `github.auth.start`, `github.auth.connected`, `github.auth.failed`, `github.auth.cancel`, `github.disconnect`. No token values.
- The sign-in process is single-flight, killed on cancel and after five minutes, started with an argument array (no shell) and an allowlisted environment (no `GH_TOKEN`, proxies or API keys).
- Output is parsed defensively; a mode other than `login` or `refresh` is rejected; errors are fixed strings.
- Fine-grained tokens report no scopes, so missing scopes are only reported for classic and OAuth logins.
- Remote computers: the sign-in runs on the computer the console is attached to. The card names it.

## Roadmap

1. Now: options 1 to 3 in one card.
2. Next: decide on an org-owned OAuth App; if yes, add it as option 2 for computers without `gh` (device flow, store through `gh` or the OS keychain).
3. Later: GitHub App for pull requests, per-repository installs, optional hosted token broker for teams.

## Open questions

- Should a signed-in `gh` need a one-time confirmation before 0 uses it? Today it is used immediately, as repository listing already did.
- Is a disconnect that signs the CLI out of other tools acceptable, or should 0 keep its own separate `GH_CONFIG_DIR`?
