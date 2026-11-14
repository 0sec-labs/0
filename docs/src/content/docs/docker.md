---
title: Docker image
description: Run the headless 0 container image from GitHub Container Registry, with its contents, usage and security model.
---

The Docker publishing workflow builds a **Linux amd64** image on GitHub
Container Registry. The Dockerfile contains some architecture-aware dependency
provisioning, but the current publisher is not multi-architecture:

```
ghcr.io/0sec-labs/0:latest
ghcr.io/0sec-labs/0:<sha>
ghcr.io/0sec-labs/0:main
```

**Sources:** [`Dockerfile`](https://github.com/0sec-labs/0/blob/main/scripts/docker/Dockerfile),
[`docker-publish.yml`](https://github.com/0sec-labs/0/blob/main/.github/workflows/docker-publish.yml).
Use a digest or the published short-SHA tag when repeatability matters;
`latest` follows eligible main builds, not a promise of a stable release.

### Image contents

The runtime image (based on `ubuntu:24.04`) includes:

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

### Usage

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY=$KEY \
  -v "$PWD:/work" -w /work \
  ghcr.io/0sec-labs/0:latest review .

# Scan a web target
docker run --rm \
  -e OPENAI_API_KEY=$KEY \
  -v "$PWD:/work:ro" -w /work \
  ghcr.io/0sec-labs/0:latest scan \
    --target https://example.com \
    --scope /work/scope.json
```

The container runs as the `ubuntu` user (uid 1000). Mount your working directory
at `/work` if you need the container to read source code or write reports.

### Security model

- The image drops privileges to the `ubuntu` user before executing commands
- `INSTALL_SECLISTS=1` adds optional wordlists. AzureHound is included by default;
  changing `AZUREHOUND_VERSION` also requires matching recorded checksums
- Ubuntu packages follow the configured apt repositories; the Dockerfile pins
  the listed AD Python package versions and verifies AzureHound/FoxGuard downloads
- The AD tools venv is deliberately not on `PATH` to avoid shadowing system
  Python packages

### Build your own

```bash
docker build -f scripts/docker/Dockerfile -t 0:local .
docker build -f scripts/docker/Dockerfile --build-arg INSTALL_SECLISTS=1 -t 0:full .
```
