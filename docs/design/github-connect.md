# Connecting GitHub without a pasted token

## Problem

Connecting GitHub meant pasting a personal access token. The console talks to the engine on the same computer, so the engine can reuse credentials that are already there.

## Finding that shaped the design

Every GitHub path already goes through `gh`: repository listing, draft pull requests, the skills catalog, plugin install (`gh auth git-credential`) and sentinels. `gh` resolves its own credential for each call. So the engine does not need `gh auth token` at all. It never reads, caches or logs the token, which is stronger than "read at use time". A pasted token is also handed to `gh auth login --with-token`, so it ends up in the same store.

Consequence: a signed-in `gh` is used automatically. There is no separate opt-in step. 0 has no Disconnect: the card only connects and shows status, and never signs the CLI out. To sign out, run `gh auth logout` yourself.

## Options

| Option | Needs | Verdict |
| --- | --- | --- |
| 1. Reuse the GitHub CLI login | `gh` installed and signed in | Shipped. Zero clicks. Shows user, scopes and missing scopes. |
| 2. `gh auth login --web` device flow driven by the engine | `gh` installed | Shipped. Code and URL are parsed from output, the URL is pinned to `github.com/login/device`. |
| 3. Fine-grained token with a prefilled creation page | Nothing | Shipped as the fallback. Parameters verified against GitHub docs: `name` (40 chars), `description`, `target_name`, `expires_in` (1 to 366 or `none`), and permissions as `name=level`. |

## Security properties

- All mutating routes (`github/connect`, `github/device-auth`) are in the privileged table: browser only, owner only in team mode.
- Audit events: `github.connect`, `github.auth.start`, `github.auth.connected`, `github.auth.failed`, `github.auth.cancel`. No token values.
- The sign-in process is single-flight, killed on cancel and after five minutes, started with an argument array (no shell) and an allowlisted environment (no `GH_TOKEN`, proxies or API keys).
- Output is parsed defensively; a mode other than `login` or `refresh` is rejected; errors are fixed strings.
- Fine-grained tokens report no scopes, so missing scopes are only reported for classic logins.
- Remote computers: the sign-in runs on the computer the console is attached to. The card names it.
