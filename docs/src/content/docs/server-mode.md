---
title: Server mode and Docker
description: Run one-shot prompts from the 0 container image, or run the app on a server for a team (experimental, single node).
---


The image is Linux amd64 only. Its entry point is the `0` CLI, so arguments after the image name are `0` arguments. With no arguments it starts the web console (see [Run the app on a server](#run-the-app-on-a-server-experimental-single-node)).

## One-shot prompts

```bash
docker run --rm -e OPENAI_API_KEY=$KEY -v "$PWD:/work" -w /work \
  ghcr.io/0sec-labs/0security:latest -p "Review this folder for injection bugs"
```

Tags:

```
ghcr.io/0sec-labs/0security:latest
ghcr.io/0sec-labs/0security:<sha>
ghcr.io/0sec-labs/0security:edge      # nightly build of the newest green main commit
ghcr.io/0sec-labs/0security:v0.41.0   # releases only
ghcr.io/0sec-labs/0security:0.41.0    # releases only
ghcr.io/0sec-labs/0security:0.41      # releases only, follows the latest 0.37.x
```

**Sources:** [`Dockerfile`](https://github.com/0sec-labs/0security/blob/main/deploy/docker/Dockerfile),
[`docker-publish.yml`](https://github.com/0sec-labs/0security/blob/main/.github/workflows/docker-publish.yml).
Use a version tag, a digest or a short-SHA tag when you need repeatable runs. `latest` is the most recent release; use `edge` for the nightly main build.

## Image contents

The image is based on `ubuntu:24.04` and includes:

| Category | Tools |
|----------|-------|
| **Node.js runtime** | Node 24 (copied from builder stage), npm, npx |
| **Static analysis** | FoxGuard (pre-provisioned, checksum-pinned) |
| **Web pentesting** | sqlmap, nmap, nikto, gobuster, hydra, ffuf, wfuzz, whatweb, wafw00f, dirb |
| **Active Directory** | impacket (0.13.1), certipy-ad (5.1.0), bloodhound-ce (1.9.1), ldap-utils, krb5-user |
| **Cloud identity** | AzureHound (v3.0.0, checksum-pinned) |
| **Source analysis** | ripgrep (for fast source-tree searches), jq, git |
| **Container analysis** | skopeo |
| **Scripting** | python3, python3-requests, python3-bs4 |
| **Optional** | SecLists wordlists (`INSTALL_SECLISTS=1` build arg, ~1GB extra) |

## Mounts and state

```bash
# Ask about a web target
docker run --rm \
  -e OPENAI_API_KEY=$KEY \
  -v "$PWD:/work:ro" -w /work \
  ghcr.io/0sec-labs/0security:latest -p "Check the login flow"
```

The container runs as the `ubuntu` user (uid 1000). Mount your working directory
at `/work` so the container can read source and write reports. State lives in `/data` (`HOME=/data`, so `/data/.0`). Mount a volume there if you want findings to outlive the container: `-v zero-data:/data`.

## Run the app on a server (experimental, single node)

This is the one supported way to run the web console for more than one person on a server. It is **experimental**: one node, one container, one volume. There is no high availability. See [Teams and enterprise](#teams-and-enterprise).

For infrastructure setup on AWS (EC2/ECS) or Azure (VM/Container Instances) with persistent disks, cloud secret stores, automated backups and TLS ingress, see [Self-hosting on Azure and AWS](/self-hosting/).

### Start it

```bash
git clone --depth 1 https://github.com/0sec-labs/0security && cd 0security/deploy/compose
cp .env.example .env            # set ZERO_ACCESS_TOKEN (openssl rand -base64 32) and your provider key
docker compose up -d
```

The console answers on `http://127.0.0.1:48123` on that machine. To reach it from elsewhere, use the proxy profile, which adds Caddy with automatic HTTPS. Point a DNS name at the server, open ports 80 and 443, and set these in `.env`:

```bash
ZERO_DOMAIN=0.example.com
ZERO_PUBLIC_URL=https://0.example.com
ZERO_ALLOWED_HOSTS=0.example.com
```

```bash
docker compose --profile proxy up -d
```

Without Compose: `docker run -d --name zero -p 127.0.0.1:48123:48123 -v zero-data:/data -e ZERO_ACCESS_TOKEN=... ghcr.io/0sec-labs/0security:v0.41.0`.

Open the address and enter the access token. If you left `ZERO_ACCESS_TOKEN` empty, the first start generates one, prints it once in `docker compose logs zero` and stores it (mode 0600) in `/data/.0/access-token`. With [team accounts](#teams) configured (`ZERO_TEAM_CONFIG`), people sign in with those instead.

### Server mode flags

`0 --host 0.0.0.0 --server-mode` is the image default. It is off unless you pass it; a plain `0` still binds loopback only.

| Flag | Environment | Purpose |
|---|---|---|
| `--server-mode` | `ZERO_SERVER_MODE=1` | Allow a network bind and require sign-in. |
| `--allowed-host <name>` | `ZERO_ALLOWED_HOSTS` | Host names the console answers to. Any other `Host` gets 403. Required with `0.0.0.0`. |
| `--trusted-proxy <cidr>` | `ZERO_TRUSTED_PROXY` | Proxy addresses whose `X-Forwarded-*` headers are trusted. |
| `--public-url <url>` | `ZERO_PUBLIC_URL` | The public https address, for secure cookies and single sign-on. |
| `--access-token-env <name>` | `ZERO_ACCESS_TOKEN` | The access token, 32 characters or more. |
| `--shutdown-timeout <seconds>` | | How long `docker stop` lets running requests finish (default 20). |

The server refuses to start without a credential, with a too-short access token, or with a network bind and no allowed host. If you publish the port without a trusted TLS proxy it prints a warning: plain HTTP sends the access token and the session cookie in clear text, so do not do that.

`GET /healthz` (the process is up) and `GET /readyz` (the database answers; 503 while starting or stopping) need no sign-in. `/readyz` returns only `{"status": ...}`; `/healthz` also returns `modelTransport` counters (consecutive and total model-call connection failures, pool rebuilds, last failure code), which contain no secrets. The image health check uses `/healthz`.

### Sizing

- Minimum: 2 vCPU and 4 GB of memory, with an SSD volume. Add roughly 1 vCPU and 1 to 2 GB for each Thread that runs at the same time, and more disk for large reports.
- Run **one replica**. The SQLite database has one owner process; two containers on one volume will corrupt it.
- Example limits are in the compose file (commented). Model calls go to your provider with your keys; nothing is hosted for you.

### Back up

Either stop the container and copy the volume, or take an online SQLite backup while it runs:

```bash
docker compose stop zero
docker run --rm -v zero_zero-data:/data -v "$PWD:/backup" ubuntu:24.04 tar czf /backup/zero-data-$(date +%F).tgz -C /data .
docker compose start zero
```

```bash
docker compose exec zero node -e "const {DatabaseSync,backup}=require('node:sqlite');(async()=>{const db=new DatabaseSync('/data/.0/0.db',{readOnly:true});await backup(db,'/data/backup.db');db.close()})()"
docker compose cp zero:/data/backup.db ./zero-backup.db && docker compose exec zero rm /data/backup.db && chmod 600 zero-backup.db
```

Restore by stopping the container, extracting the archive into the volume, and starting it again. Keep the backup safe: it contains your findings.

### Upgrade

```bash
# set ZERO_IMAGE_TAG=v0.41.0 in .env (or keep latest), then
docker compose pull && docker compose up -d
```

Database migrations run on start. Take a backup first: there is no in-place rollback, so to go back, restore the backup and pin the older tag.

The container never updates itself. The console detects Docker and shows `docker pull ghcr.io/0sec-labs/0security:latest` on its update card instead of an **Update and restart** button, and the background installer is off. Pull the new image and recreate the container as above.

### Remote computers over SSH

The image includes the OpenSSH client, so Settings or `0 computers add --ssh user@host` can install and connect a [remote computer](/computers/) from inside the container. Host key checking stays on: the deploy never uses `StrictHostKeyChecking=no`, so the remote host must already be in `known_hosts`.

1. Use a dedicated key for this, not your personal one: `ssh-keygen -t ed25519 -f zero_ed25519 -N ""`, then add `zero_ed25519.pub` to the remote user's `authorized_keys`. The key must not need a passphrase prompt (the deploy runs non-interactively).
2. Record the host key and verify its fingerprint out of band before trusting it: `ssh-keyscan -t ed25519 host.example.com > known_hosts`, then compare `ssh-keygen -lf known_hosts` with the fingerprint on the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, run on the server). Do not paste an unverified scan blindly.
3. Mount both read-only. OpenSSH reads `/home/ubuntu/.ssh` (the container user's account home), not `$HOME`:

```bash
docker run -d ... \
  -v "$PWD/zero_ed25519:/home/ubuntu/.ssh/id_ed25519:ro" \
  -v "$PWD/known_hosts:/home/ubuntu/.ssh/known_hosts:ro" \
  ghcr.io/0sec-labs/0security:v0.41.0
```

The container runs as uid 1000. The key file must be readable by that user and not by others: on a Linux host run `sudo chown 1000:1000 zero_ed25519 && chmod 600 zero_ed25519`. OpenSSH refuses a key that is group- or world-readable and owned by the same user, and a key you cannot read at all. Commented lines in the compose file show the same mounts.

Alternative without a key file in the container: forward an agent socket. On Linux, `-v "$SSH_AUTH_SOCK:/ssh-agent" -e SSH_AUTH_SOCK=/ssh-agent` (the socket must be accessible to uid 1000, for example start the agent as that user or `chmod` the socket); on Docker Desktop for Mac use `-v /run/host-services/ssh-auth.sock:/ssh-agent`. You still mount `known_hosts`.

The remote computer needs: Linux, Node.js, an SSH account that can run `bash`, and outbound network access to your model provider. The console reaches it through an SSH tunnel (`-L`) that the container opens, so the remote needs no inbound port other than SSH. The deployment record is kept in `/data`, but the tunnel process does not survive a container restart: reconnect from Computers after restarting.

### Pull request reviews

A Sentinel with a `github-pr` trigger polls `gh pr list`, so it needs no inbound address and works from a container behind a proxy. It only needs GitHub access from the container: set `GH_TOKEN` (or `GITHUB_TOKEN`) in `.env` to a fine-grained token limited to the repositories you review (Contents, Pull requests and Metadata, read), or run `docker compose exec -it zero gh auth login` once (the credential is kept under `/data/.config/gh`). Reviews are drafts in the app and post nothing to GitHub unless you turn on comments. Details are in [Sentinels](/sentinels/#github-pull-request-trigger).

With a public HTTPS address (`ZERO_PUBLIC_URL`), the optional GitHub webhook at `https://<your domain>/api/webhooks/github` makes pull request Sentinels react right after a push. It is the only address that answers without sign-in, and it requires a valid `X-Hub-Signature-256` on every request. Set it up as described in [Sentinels](/sentinels/#faster-with-a-github-webhook-server-mode), keep `--trusted-proxy` set so the rate limit sees the real sender, and rotate the secret if it leaks (the old one works for 5 minutes). From a terminal: `docker compose exec zero 0 sentinels webhook secret rotate --yes`.

### Not supported

- High availability, failover, or more than one replica.
- Sharing the volume between containers or hosts.
- Webhooks other than the optional GitHub pull request webhook above (pull request triggers poll without it).
- Shared sandboxes or per-customer isolation inside one container. Everyone who signs in shares the same computer and the same data.
- A hosted service. Dedicated and on-premises deployments are arranged by contract.
- Anything other than a TLS-terminating proxy in front of it for access over the internet.

### Threat model in short

The console can run security tools and use your model keys, so access to it is full control. In server mode: an anonymous visitor only sees a sign-in page and never receives the console's control token; sign-in sets an `HttpOnly`, `SameSite=Strict` cookie (and `Secure` over HTTPS); wrong tokens are throttled with growing delays; requests for unknown host names, from other origins, or without same-origin evidence on changes are refused; forwarded headers count only from `--trusted-proxy`; sign-ins, failures and refusals are written to the audit log. Keep the access token secret, use HTTPS, and restrict who can reach the port.

## Supply chain

- Commands run as the `ubuntu` user.
- Ubuntu packages follow the configured apt repositories. The Dockerfile pins the AD Python packages and verifies the AzureHound and FoxGuard downloads.
- Changing `AZUREHOUND_VERSION` also needs matching checksums in the Dockerfile.
- The AD tools venv is not on `PATH`, so it cannot shadow system Python packages.

## Build your own

```bash
docker build -f deploy/docker/Dockerfile -t 0:local .
docker build -f deploy/docker/Dockerfile --build-arg INSTALL_SECLISTS=1 -t 0:full .
```

The published image embeds the project's telemetry keys like the release binaries do. Building the Dockerfile yourself embeds nothing unless you pass the `zero_release_sentry_dsn` and `zero_release_posthog_key` BuildKit secrets.

## Teams

Local use needs no account. Use team mode when several people share one computer and its threads.

In the browser app, choose **Team**, enter a workspace name, your display name, account ID and password, and you are signed in as owner. Add editors and viewers from **Team settings** in the account menu. Only owners add accounts.

From a terminal:

```bash
0 config set team init --config ./team.json --name "Security" --owner alex --display-name "Alex"
0 config set team add-user --config ./team.json --user morgan --display-name "Morgan" --role editor
0 config get team --config ./team.json
0 --team-config ./team.json
```

Passwords are read from a prompt or stdin, never from arguments. The file stores salted scrypt hashes. Keep it private (`0600`). `init` never overwrites an existing file. Edits to the file apply when the computer restarts, and a restart ends open threads.

Owners and editors can change work. Viewers can read. Messages keep their authors, and avatars show who is viewing or typing.

Limits: members share one computer workspace, not separate tenants. Each team gets its own thread directory, findings database and reports by default. Existing personal threads are not imported. Use `--db-path` to choose the database to share. The computer binds to loopback. Remote access and a reverse proxy are your deployment work.

### OIDC sign-in

Add an `oidc` object and give each member the provider's verified `oidcSub`. Names and email claims never grant membership or roles.

```json
{
  "workspace": { "id": "your-workspace-id", "name": "Security" },
  "users": [
    { "id": "alex", "name": "Alex", "role": "owner", "oidcSub": "provider-subject-id" }
  ],
  "oidc": {
    "issuer": "https://identity.example.com",
    "clientId": "your-client-id",
    "clientSecretEnv": "ZERO_TEAM_OIDC_SECRET",
    "redirectUri": "http://127.0.0.1:48123/api/team/auth/callback"
  }
}
```

Register the exact callback URL with your provider. Omit `clientSecretEnv` for a public client. Sign-in uses the authorization code flow with PKCE and checks issuer, audience, nonce and signature. Session cookies are HTTP-only and last eight hours.

## Teams and enterprise

0 is open source under MIT OR Apache-2.0. The CLI, the engine, the browser app and the team workspace are all in the [`0sec-labs/0security`](https://github.com/0sec-labs/0security) repository, and nothing in them needs an account, a license key or a 0security-hosted service. Model calls (to the provider you choose, with your own key) and findings stay on your computer, your CI runner or your servers. The one automatic upload is the anonymous telemetry described in [Configuration](/configuration/#telemetry).

A team workspace shares one computer between members. It is not a multi-tenant service: sessions are held in memory (members sign in again after a restart), and results from several computers are not merged. Enterprise is arranged with us rather than self-served, for example running 0 on your own infrastructure with our help or a dedicated deployment that we operate for you, one customer per deployment, by contract. We do not publish a Helm chart or a Terraform module and do not offer a shared multi-tenant cloud. [Book a demo](https://0.security/enterprise/).
