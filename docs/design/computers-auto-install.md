# Computers: a Capy-grade "Add computer" flow

Status: proposal. Nothing here is implemented. Owner decisions are listed at the end.

## 1. How Capy does it

Sources: public docs (docs.capy.ai/desktop, /dock) and read-only inspection of
`/Applications/Capy.app` v0.8.0. The live web UI was not captured (the browser
CDP handshake timed out), so web copy below comes from docs and earlier notes.
Credential files were never opened.

Facts:
- Capy calls other machines "devices" (Settings, Devices). There are two ways in.
  - Desktop app: sign in (Google, GitHub or email) and the machine is enrolled
    automatically. "Run on" then offers "This Mac".
  - Headless `capy dock` CLI: `curl -fsSL https://downloads.capy.ai/stable/dock/install.sh | sh`
    (PowerShell `irm ... | iex`). Refuses to run as root. Checks checksum, plus a
    signature on macOS and Windows. Installs to `~/.capy/dock-install/<version>`,
    symlinked from `~/.capy/bin`. Idempotent: rerun to update. `capy dock verify`
    checks files against a manifest signed into the binary.
- Pairing is a device-code flow. `capy dock` needs an interactive TTY (so the
  code never lands in a log) and prints a link, a QR code and a short code. The
  signed-in browser shows hostname and system, an organization picker and a name
  field, requires ticking "this is a machine I'm setting up right now", and warns
  never to approve a code someone else sent. The terminal then confirms org and name.
- Connectivity is outbound only. The desktop app dials
  `wss://device-tunnel-production.cloud.capy.ai/tunnel` (log events
  `device-tunnel-connected`, `device-tunnel-dial-ended`; redials with jitter).
  A second socket carries realtime tray updates. No inbound ports.
- No launchd daemon or LaunchAgent. The Electron main process stays alive as a
  menu-bar tray app; closing the window keeps the device online, Quit takes it
  offline. Launch-at-login is the Electron login-item API. The dock CLI has no
  documented service installer (tmux, systemd or launchd by hand).
- Desktop stack: Electron, bundle `ai.capy.desktop`, Squirrel.Mac, generic
  update feed on a CloudFront `stable/` channel (`app-update.yml`), a bundled
  native helper `kappu-macos` (local socket, keep-awake, accessibility-based
  computer use), and a registered `capy://` URL scheme.
- Device protocol event names in the bundle: enroll, describe, rename, revoke,
  access grant/deny/revoke, code_approve, code_deny, computer_use_*. Devices are
  scoped per org and have a `device_` id. Credentials live in Application Support.
- States: Online, Offline/asleep (threads wait up to 24h), update available
  (Update button in tab bar; rerun installer for dock). Removal: "Revoke device".
  Settings has Access (who can run), keep-awake, cloud checkpoints.
- Threads move between machines through cloud checkpoints (commits plus
  staged, unstaged and small untracked files; gitignored files and processes stay).

Uncertain or unverified: how `capy://` completes sign-in, whether a local server
opens while running (app was not running), agent spawn internals, dialog empty
and waiting states, revoke confirmation text, the "Finish setting up" card.

## 2. How ours works today

Entry points: Computers page "Add computer" (`packages/web/src/pages/workers-page.tsx`)
or `0 worker deploy --ssh user@host | --lima name` (`packages/cli/src/commands/worker.ts`).

1. `GET /api/workers/hosts` lists aliases from `~/.ssh/config`
   (`packages/cli/src/worker-hosts.ts`); manual `user@host` also allowed.
2. `POST /api/workers/deploy` (`packages/cli/src/commands/dashboard.ts`, ~L385)
   validates the host (`^[A-Za-z0-9._@-]+$`, no leading `-`) and spawns
   `0 worker deploy` with a 1h timeout.
3. `deployWorker` (`packages/cli/src/worker-deploy.ts`): over
   `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes`, installs Node 24 and clang
   via sudo/apt if missing, scp's the local `dist/` plus vendor tarball to
   `/tmp/zero-engine`, runs `npm install --omit=dev`, starts
   `node dist/0.js web --host 127.0.0.1 --engine-token-env ZERO_WORKER_TOKEN`,
   waits for `ZERO_DASHBOARD_READY`.
4. A detached `ssh -N -L P:127.0.0.1:P` tunnel (P hashed from host, 20000-39999).
5. Registration: engines registry entry `ssh-worker-<hash>` with bearer env,
   token file `workers/<id>.env` (0600), metadata `workers/<id>.json`.
6. Operation: `BackendRegistry` proxies with `Authorization: Bearer`
   (`packages/cli/src/web/backend-connections.ts`: HTTPS or loopback HTTP only,
   `redirect: "error"`). `managed-host-reconnect.ts` repairs managed hosts;
   UI has Reconnect and "Stop 0 on this computer".
7. Local CLI auto-update (`packages/cli/src/utils/update-check.ts`) runs the root
   `install.sh` at most daily, TTY only. It does not touch remotes.

Good: loopback bind on the remote, strict host keys, 64-hex token at 0600,
zod-strict routes, PID verification before kill.

## 3. The gap

1. Linux only (apt, sudo, `/proc`); no macOS or Windows computer.
2. Needs a pre-existing SSH key and known_hosts entry; no trust-on-first-use UI.
3. Lives in `/tmp/zero-engine`; not a service; dies on reboot or tmp cleanup.
4. No remote update path or version check; controller/engine skew.
5. Heavy deploy: full scp plus `npm install` (up to 15 min) and the controller
   must hold `dist/` and `vendor/`.
6. No pairing, no outbound relay, so NAT and Tailscale-only hosts need manual ssh config.
7. Poor feedback: one "Deploying..." state, errors collapsed to a generic message;
   `host:port` and IPv6 rejected without explanation.
8. No uninstall, no device list with last-seen, no revoke, no desktop app
   (`packages/` has only bench, cli, engine, web; `release.yml` says desktop is dev-only).
9. Hash-derived tunnel ports can collide.

## 4. Proposed design

### 4.1 User experience
Add computer dialog offers three tabs: **Install command** (default), **Pairing
code** (for a machine you are standing at), **SSH push** (advanced). The first
two share one backend object, a short-lived pairing code.

Flow:
1. User clicks Add computer. Server mints a pairing code: 8 chars, single use,
   10 min TTL, bound to the signed-in account and workspace, stored hashed.
2. Dialog shows `curl -fsSL https://get.0.security/stable/install.sh | sh` and
   the code separately, plus a deep link `zero://pair?code=...` and QR.
   The command line contains no secret; the code is typed or approved on the web.
3. Installer downloads the signed `0` binary for the OS/arch, verifies the
   checksum and signature, installs to `~/.0/install/<version>` with a symlink in
   `~/.0/bin`, refuses root, and runs `0 computer pair`.
4. `0 computer pair` requires a TTY, prints the code and link, generates an
   Ed25519 device key (private key never leaves the machine), and polls.
5. The web page shows hostname, OS and key fingerprint; user picks the name and
   ticks "I am setting up this computer right now", then Approve. Server stores
   the public key and issues a device certificate (short-lived credential,
   refreshed over the tunnel).
6. The installer registers a user-level service (`launchd` LaunchAgent,
   `systemd --user` unit plus linger, Windows per-user Scheduled Task/service)
   and the computer goes Connected.

### 4.2 Connectivity
Outbound only. The daemon dials a relay over WSS and authenticates with the
device key. The controller reaches the engine through the relay; the engine
keeps binding loopback only, so no inbound ports. Direct path: if both ends are
on one tailnet (`tailscale status --json`), prefer a direct HTTPS or Tailscale
path and fall back to relay. The existing `BackendRegistry` is reused: the relay
presents a loopback or HTTPS URL, so `backend-connections.ts` rules stay intact.

### 4.3 Identity and credentials
- Host identity pinned to the device public key; the controller stores the
  fingerprint and rejects a changed key until re-approved.
- No long-lived secret in argv or in a URL. Pairing code is one-time; device
  credentials are short-lived and rotated; the bearer for the engine is minted
  per session over the tunnel, not a static env token.
- Provider keys and scopes stay on the computer. Forwarding the OpenAI key stays
  an explicit, per-computer opt-in.

### 4.4 Status states
Waiting (code issued, no daemon yet; countdown), Pairing (approval pending),
Connected, Offline (last seen N min ago), Update available, Update failed
(rolled back), Revoked. Shown in the Computers list with Rename, Revoke, Update
now, and Uninstall instructions.

### 4.5 Updates, rollback, uninstall
- Daemon checks the channel feed (`stable`, `beta`) daily and on connect, downloads
  into `~/.0/install/<new>`, verifies signature, flips the symlink, restarts,
  health-checks for 60s, and flips back on failure. Controller shows version skew.
- `0 computer verify|status|doctor|update|uninstall`. Uninstall stops the service,
  removes the unit, install dir and local credentials, and notifies the server.
- Revoke on the web invalidates the device credential; next connect fails and
  the daemon reports "revoked" and stops redialing.

### 4.6 SSH push (advanced path)
Keep today's deploy but fix it: show the host key fingerprint and require explicit
trust (write to a dedicated known_hosts file), accept `host:port` and IPv6,
stream step progress and real stderr, install the signed binary via the same
installer instead of scp plus `npm install`, install the service, then pair
over the same code mechanism. Remove `/tmp/zero-engine`.

### 4.7 Desktop app: Tauri vs Electron
Evidence from Capy: Electron plus Squirrel.Mac, a generic CDN feed, a native
helper for keep-awake, tray as the always-on process. Our requirement is a thin
tray wrapping the same daemon, which is a Rust or Bun-compiled binary today.
Recommendation: Tauri 2 tray shell (small, signed updater built in, no second
Node runtime), with the daemon as the supervised sidecar; the tray only shows
status, opens the web UI and toggles keep-awake. Electron is the fallback if a
bundled web UI or deep native plugin needs outweigh size. Decision needed (section 8).

## 5. Security model and threats

| Threat | Mitigation |
|---|---|
| Pairing code theft or phishing ("approve this code") | Single use, 10 min TTL, hashed at rest, mandatory "setting up now" tick, hostname and fingerprint shown, TTY required for first run, warning copy |
| MITM or tampering of the install script | HTTPS only, versioned immutable artifacts, checksum plus signature verified by a pinned public key in the script, `install.sh` is tiny and published with a hash in docs |
| Rogue computer joins | Approval bound to signed-in account and workspace; per-device key; revoke; per-computer access control |
| Device credential theft | Short-lived certs, private key in OS keychain or 0600, revocation list checked on connect |
| Relay compromise | End-to-end: engine requests signed by controller, relay forwards opaque frames; relay never holds provider keys |
| Scope or credential leakage off the computer | Scopes and provider keys remain local; only results stream; forwarding opt-in |
| Rollback or downgrade attack | Feed manifest signed with version monotonic check |
| Replayed pairing after revoke | Device ids never reused; revoked key fingerprints retained |

## 6. What we already have and should reuse
- `workers-page.tsx` dialog, `worker-hosts.ts` ssh alias discovery.
- `BackendRegistry` and `backend-connections.ts` URL, bearer and redirect rules,
  `X-0-Expected-Engine-ID`.
- `managed-host-reconnect.ts` and `0 worker repair|stop` semantics (generalize
  to the daemon).
- `worker-deploy.ts` Runner abstraction (ssh, Lima) for the SSH push path.
- `update-check.ts` policy handling (`automatic`), `install.sh` checksum logic.
- Release pipeline (`release.yml`: four standalone binaries plus checksums).
- Team permission policy on `feat/team-permission-policy` for device access grants.

## 7. Phased plan

| Phase | Scope | Effort |
|---|---|---|
| P0 | Pairing code API, approval page, `0 computer pair`, hosted install script, dialog tabs and copy, status states Waiting/Connected | M (2-3 wks) |
| P1 | Daemon and per-OS service units, signed channel feed, auto-update with rollback, `verify/status/doctor/uninstall`, SSH push rework | L (3-4 wks) |
| P2 | Relay service with device-key auth, Tailscale-aware direct path, bearer minting over tunnel | L (4-6 wks) |
| P3 | Tauri tray app, deep link `zero://`, keep-awake helper | M (3 wks) |

Files to change or add:
- `packages/cli/src/commands/computer.ts` (new: pair, status, doctor, verify, update, uninstall)
- `packages/cli/src/computer/{pairing,daemon,service-launchd,service-systemd,service-windows,updater}.ts` (new)
- `packages/cli/src/commands/dashboard.ts` (pairing and device routes beside `/api/workers/*`)
- `packages/cli/src/worker-deploy.ts` (use installer, host-key trust, real errors)
- `packages/cli/src/web/backend-connections.ts` (relay or tailnet transport adapter)
- `packages/web/src/pages/workers-page.tsx` (dialog, states, list actions)
- `install.sh` and new `scripts/computer-install.sh`, `.github/workflows/release.yml` (sign, publish channel manifest)
- `docs/src/content/docs/engines.md` (new Computers section)
- `packages/desktop/` (P3, new)

## 8. UI copy

- Title: "Add a computer". Subtitle: "Run 0 on another machine. It connects out to you; nothing is opened to the internet."
- Waiting: "Run this on the computer, as the user that should run 0. Waiting for it to connect... Code expires in 09:41." Buttons: Copy command, Copy code, Cancel.
- Pairing: "Approve this computer? Name: [host]. System: macOS 15 arm64. Key: 4F:A1:.. [ ] I am setting this up right now. Never approve a code someone sent you." Buttons: Approve, Deny.
- Connected: "[name] is connected. Version 1.4.2." Button: Done.
- Offline: "Last seen 5 hours ago. Start 0 on that computer or wake it."
- Update available: "Version 1.5.0 is available." Button: Update now. Failure: "Update failed; rolled back to 1.4.2. See logs."
- Expired: "This code expired. Generate a new one."
- Error (ssh): "Could not verify the host key for [host]. Fingerprint SHA256:... Trust this host?"
- Revoke: "Revoke [name]? It disconnects now and must pair again."

## 9. Test plan
- Unit: code TTL, single use, hashing, account binding; host-key pinning; version
  monotonic and signature checks; host validation including `host:port` and IPv6.
- Integration: two engines in-process (pattern from existing backend-connection
  tests) for pair, approve, deny, revoke, reconnect, update with forced failure
  and rollback.
- Installer: shellcheck, run in containers (Debian, Alpine rejected with clear
  message), macOS runner, Windows runner; tampered checksum and bad signature must abort.
- Service: launchd, systemd --user and Task install and uninstall idempotent;
  reboot survival on a VM.
- Security: negative tests for replayed codes, revoked keys, changed host key.
- Browser qualification with real screenshots of each dialog state.

## 10. Open decisions for the owner
1. Relay hosting: self-run (Cloudflare Workers/Durable Objects) vs customers
   self-hosting vs Tailscale-only first. Affects cost and enterprise story.
2. Signing keys: who holds the release signing key; Apple Developer ID and
   Windows code-signing certificate procurement; feed domain.
3. Desktop framework: Tauri (recommended) vs Electron (Capy's choice).
4. Whether Windows is in P1 or deferred.
5. Whether the install command is hosted on a dedicated domain or GitHub raw.
