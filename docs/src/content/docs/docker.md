---
title: Docker
description: Run 0 from the ghcr.io/0sec-labs/0 container image.
---

The image is Linux amd64 only and starts the `0` CLI, so arguments after the image name are `0` arguments.

```bash
docker run --rm -e ANTHROPIC_API_KEY=$KEY -v "$PWD:/work" -w /work \
  ghcr.io/0sec-labs/0:latest scan source . --runtime api --depth quick --cost-ceiling 2
```

Tags are `latest`, `main` and the short commit SHA. `latest` follows eligible main builds, not a stable release. Pin a digest or a SHA tag for repeatable runs. Sources: [`Dockerfile`](https://github.com/0sec-labs/0/blob/main/scripts/docker/Dockerfile) and [`docker-publish.yml`](https://github.com/0sec-labs/0/blob/main/.github/workflows/docker-publish.yml).

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
  ghcr.io/0sec-labs/0:latest scan web \
    --target https://example.com \
    --scope /work/scope.json
```

The container runs as the `ubuntu` user (uid 1000). Mount your working directory
at `/work` so the container can read source and write reports. Scanning a web target needs a [scope file](/scope/). The image has no state volume, so mount a volume at `/home/ubuntu/.0` if you want findings to outlive the container.

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

Next: [CI/CD](/ci/github-action/), [Scan web and APIs](/scan-web/).
