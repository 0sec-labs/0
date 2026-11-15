---
title: Docker
description: Run one-shot scans from the 0 container image, or run the web console on a server (experimental, single node).
---

The image is Linux amd64 only. Its entry point is the `0` CLI, so arguments after the image name are `0` arguments. With no arguments it starts the web console (see [Run the web console on a server](#run-the-web-console-on-a-server-experimental-single-node)).

## One-shot scans

```bash
docker run --rm -e OPENAI_API_KEY=$KEY -v "$PWD:/work" -w /work \
  ghcr.io/0sec-labs/0security:latest scan source . --runtime api --depth quick --cost-ceiling 2
```

Tags:

```
ghcr.io/0sec-labs/0security:latest
ghcr.io/0sec-labs/0security:<sha>
ghcr.io/0sec-labs/0security:edge      # nightly build of the newest green main commit
ghcr.io/0sec-labs/0security:v0.30.1   # releases only
ghcr.io/0sec-labs/0security:0.30.1    # releases only
ghcr.io/0sec-labs/0security:0.30      # releases only, follows the latest 0.30.x
```

**Sources:** [`Dockerfile`](https://github.com/0sec-labs/0security/blob/main/scripts/docker/Dockerfile),
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
| **Source analysis** | ripgrep (for fast source-tree searches in audit/scan), jq, git |
| **Container analysis** | skopeo |
| **Scripting** | python3, python3-requests, python3-bs4 |
| **Optional** | SecLists wordlists (`INSTALL_SECLISTS=1` build arg, ~1GB extra) |

## Mounts and state

```bash
# Scan a web target
docker run --rm \
  -e OPENAI_API_KEY=$KEY \
  -v "$PWD:/work:ro" -w /work \
  ghcr.io/0sec-labs/0security:latest scan web \
    --target https://example.com \
    --scope /work/scope.json
```

The container runs as the `ubuntu` user (uid 1000). Mount your working directory
at `/work` so the container can read source and write reports. Scanning a web target needs a [scope file](/scope/). State lives in `/data` (`HOME=/data`, so `/data/.0`). Mount a volume there if you want findings to outlive the container: `-v zero-data:/data`.

## Run the web console on a server (experimental, single node)

This is the one supported way to run the web console for more than one person on a server. It is **experimental**: one node, one container, one volume. There is no high availability and no Helm chart or Terraform module. Organizations that need more run 0 under an [Enterprise](/open-source-and-enterprise/) arrangement.

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

Without Compose: `docker run -d --name zero -p 127.0.0.1:48123:48123 -v zero-data:/data -e ZERO_ACCESS_TOKEN=... ghcr.io/0sec-labs/0security:v0.30.1`.

Open the address and enter the access token. If you left `ZERO_ACCESS_TOKEN` empty, the first start generates one, prints it once in `docker compose logs zero` and stores it (mode 0600) in `/data/.0/access-token`. With [team accounts](/engines/) configured (`ZERO_TEAM_CONFIG`), people sign in with those instead.

### Server mode flags

`web --host 0.0.0.0 --server-mode` is the image default. It is off unless you pass it; a plain `0 web` still binds loopback only.

| Flag | Environment | Purpose |
|---|---|---|
| `--server-mode` | `ZERO_SERVER_MODE=1` | Allow a network bind and require sign-in. |
| `--allowed-host <name>` | `ZERO_ALLOWED_HOSTS` | Host names the console answers to. Any other `Host` gets 403. Required with `0.0.0.0`. |
| `--trusted-proxy <cidr>` | `ZERO_TRUSTED_PROXY` | Proxy addresses whose `X-Forwarded-*` headers are trusted. |
| `--public-url <url>` | `ZERO_PUBLIC_URL` | The public https address, for secure cookies and single sign-on. |
| `--access-token-env <name>` | `ZERO_ACCESS_TOKEN` | The access token, 32 characters or more. |
| `--shutdown-timeout <seconds>` | | How long `docker stop` lets running requests finish (default 20). |

The server refuses to start without a credential, with a too-short access token, or with a network bind and no allowed host. If you publish the port without a trusted TLS proxy it prints a warning: plain HTTP sends the access token and the session cookie in clear text, so do not do that.

`GET /healthz` (the process is up) and `GET /readyz` (the database answers; 503 while starting or stopping) need no sign-in and return only `{"status": ...}`. The image health check uses `/healthz`.

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
# set ZERO_IMAGE_TAG=v0.30.2 in .env (or keep latest), then
docker compose pull && docker compose up -d
```

Database migrations run on start. Take a backup first: there is no in-place rollback, so to go back, restore the backup and pin the older tag.

### Remote computers over SSH

The image includes the OpenSSH client, so Settings or `0 computers deploy --ssh user@host` can install and connect a [remote computer](/engines/) from inside the container. Host key checking stays on: the deploy never uses `StrictHostKeyChecking=no`, so the remote host must already be in `known_hosts`.

1. Use a dedicated key for this, not your personal one: `ssh-keygen -t ed25519 -f zero_ed25519 -N ""`, then add `zero_ed25519.pub` to the remote user's `authorized_keys`. The key must not need a passphrase prompt (the deploy runs non-interactively).
2. Record the host key and verify its fingerprint out of band before trusting it: `ssh-keyscan -t ed25519 host.example.com > known_hosts`, then compare `ssh-keygen -lf known_hosts` with the fingerprint on the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, run on the server). Do not paste an unverified scan blindly.
3. Mount both read-only. OpenSSH reads `/home/ubuntu/.ssh` (the container user's account home), not `$HOME`:

```bash
docker run -d ... \
  -v "$PWD/zero_ed25519:/home/ubuntu/.ssh/id_ed25519:ro" \
  -v "$PWD/known_hosts:/home/ubuntu/.ssh/known_hosts:ro" \
  ghcr.io/0sec-labs/0security:v0.30.1
```

The container runs as uid 1000. The key file must be readable by that user and not by others: on a Linux host run `sudo chown 1000:1000 zero_ed25519 && chmod 600 zero_ed25519`. OpenSSH refuses a key that is group- or world-readable and owned by the same user, and a key you cannot read at all. Commented lines in the compose file show the same mounts.

Alternative without a key file in the container: forward an agent socket. On Linux, `-v "$SSH_AUTH_SOCK:/ssh-agent" -e SSH_AUTH_SOCK=/ssh-agent` (the socket must be accessible to uid 1000, for example start the agent as that user or `chmod` the socket); on Docker Desktop for Mac use `-v /run/host-services/ssh-auth.sock:/ssh-agent`. You still mount `known_hosts`.

The remote computer needs: Linux, Node.js, an SSH account that can run `bash`, and outbound network access to your model provider. The console reaches it through an SSH tunnel (`-L`) that the container opens, so the remote needs no inbound port other than SSH. The deployment record is kept in `/data`, but the tunnel process does not survive a container restart: reconnect from Computers after restarting.

### Pull request reviews

An Agent with a `github-pr` trigger finds new and updated pull requests by **polling** `gh pr list` (at least every 60 seconds, default 2 minutes). No inbound webhook and no public address are needed, so it works from a container behind a proxy or a firewall. It only needs working GitHub access from the container:

- **Environment token (simplest).** Set `GH_TOKEN` (or `GITHUB_TOKEN`) in `.env` to a fine-grained personal access token limited to the repositories you review, with Contents (read), Pull requests (read), and Metadata (read). Settings then shows **Connected as <account> via token**.
- **`gh auth login` once.** Run `docker compose exec -it zero gh auth login`. The credential is stored under `/data/.config/gh` in the state volume and survives restarts and upgrades. Settings shows **Connected as <account> via GitHub CLI**. You can also sign in from the GitHub card in Settings.

Create the Agent (for example **PR Security Reviewer**), choose the repository and the pull-request trigger, and set the poll interval. The first poll only records the pull requests that are already open; it reviews only ones opened or updated after that. If `gh` is not authenticated the trigger shows **blocked** with the reason and retries at the next poll.

What a review does: it reads the pull request diff with read-only tools and produces a **draft review with inline comments, a summary and findings in the console**. It does **not** post comments or reviews to GitHub, and it never approves or requests changes: you read the draft and decide what to publish. Fixes are proposed as drafts and need your approval before anything is pushed or a pull request is opened. Because PR content is untrusted, review only repositories whose pull requests you are willing to have the model read, and keep the token narrow.

### Not supported

- High availability, failover, or more than one replica.
- Sharing the volume between containers or hosts.
- Accepting GitHub webhooks (pull request triggers poll instead).
- Shared sandboxes or per-customer isolation inside one container. Everyone who signs in shares the same computer and the same data.
- A Helm chart, a Terraform module, or a hosted service. Dedicated and on-premises deployments are arranged by contract.
- Anything other than a TLS-terminating proxy in front of it for access over the internet.

### Threat model in short

The console can run security tools and use your model keys, so access to it is full control. In server mode: an anonymous visitor only sees a sign-in page and never receives the console's control token; sign-in sets an `HttpOnly`, `SameSite=Strict` cookie (and `Secure` over HTTPS); wrong tokens are throttled with growing delays; requests for unknown host names, from other origins, or without same-origin evidence on changes are refused; forwarded headers count only from `--trusted-proxy`; sign-ins, failures and refusals are written to the audit log. Keep the access token secret, use HTTPS, and restrict who can reach the port. The [design notes](https://github.com/0sec-labs/0security/blob/main/docs/design/deployment-packaging.md) hold the full model.

## Moving from the old image name

The image is now published only as `ghcr.io/0sec-labs/0security`. `ghcr.io/0sec-labs/0` is no longer updated, so pulling `ghcr.io/0sec-labs/0:latest` silently keeps the last version you already had. Switch your `docker run`, Compose files and CI to `ghcr.io/0sec-labs/0security`.

## Supply chain

- Commands run as the `ubuntu` user.
- Ubuntu packages follow the configured apt repositories. The Dockerfile pins the AD Python packages and verifies the AzureHound and FoxGuard downloads.
- Changing `AZUREHOUND_VERSION` also needs matching checksums in the Dockerfile.
- The AD tools venv is not on `PATH`, so it cannot shadow system Python packages.

## Build your own

```bash
docker build -f scripts/docker/Dockerfile -t 0:local .
docker build -f scripts/docker/Dockerfile --build-arg INSTALL_SECLISTS=1 -t 0:full .
```

The published image embeds the project's telemetry keys like the release binaries do. Building the Dockerfile yourself embeds nothing unless you pass the `zero_release_sentry_dsn` and `zero_release_posthog_key` BuildKit secrets.

Next: [CI/CD](/ci/github-action/), [Scan web and APIs](/scan-web/).
