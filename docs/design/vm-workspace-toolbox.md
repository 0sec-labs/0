# VM workspace and toolbox images

The VM is the execution boundary. Its image supplies Linux, 0, the model-agent
executables, browsers, and tools. SmolVM remains the hypervisor/runtime: choosing
Kali does not replace it. A Kali image is optional; a full Kali distribution and
its entire tool catalogue are not the default workspace.

## Profile contract

| Profile | Image and tools | Build floor / archive cap |
| --- | --- | --- |
| `core-web` (default) | Digest-pinned Debian Node slim base; shell, Python, Git/GitHub CLI, curl, jq, ripgrep, nmap, sqlmap, ffuf, gobuster, FoxGuard, pinned model-agent CLIs, current 0, Playwright Chromium | 30 GiB free / 6 GiB archive |
| `source` | Core web tools plus build-essential, CMake, pkg-config, GDB, binutils, strace, patch | 40 GiB free / 8 GiB archive |
| `kali` (explicit) | Caller-supplied **pre-provisioned Kali image pinned with `@sha256`**; core tools plus nikto, WPScan, Hydra, John, wfuzz, WhatWeb, radare2, pwntools and Unicorn | 50 GiB free / 8 GiB archive |

The numbers are conservative admission settings, not measured image sizes.
The build preflight measures free space on the archive output filesystem; a
remote Docker daemon or separate builder data store needs its own disk quota.
The archive cap is enforced during export; the preflight is not a hard quota on
Docker build cache or temporary layers.
The default Debian profile contains tools also used in Kali. It is **not a Kali
image**. No metapackage or wordlist corpus is installed implicitly. Source
profiling selects required development tools rather than enabling root access.
Additional tools require rebuilding and approving another immutable image;
missing tools do not trigger apt, pip, or npm bootstrap at workspace startup.

`scripts/workbench-profiles.json` owns profile names, required packages,
startup probes, disk floors, archive caps and recommended guest resources.
`scripts/workbench-tools.json` retains runtime/provider version pins and describes
the default profile, while the installed inventory is the proof for one image.
Runtime admission remains responsible for aggregate memory, CPU, elapsed time,
workspace disk and retained runs; image defaults do not bypass those limits.

## Build inputs and receipts

`scripts/docker/Dockerfile.workbench` builds the current checked-out CLI and web assets. Both
build and runtime Node images are digest-pinned. The minimal runtime image uses
the official Linux ARM64 manifest for Node 24.21.0 bookworm slim. Debian OS
packages resolve exclusively from the dated `20260929T000000Z` main/security
archives. Package signatures remain enforced; only historical Release expiry
is disabled, as [Debian snapshot documents](https://snapshot.debian.org/).
The snapshot index confirms the curated arm64 tools; e.g. nmap 7.93, sqlmap 1.7.2,
ffuf 1.1.0 and gobuster 3.5.0. These versions are frozen build inputs, not claims
that they are the latest security-tool releases.

Node/npm dependencies use existing frozen workspace/publication locks; provider
CLIs have their separate lock. Bun and FoxGuard use existing checksum-pinned
provisioning. Playwright browser revision follows the locked package. All package
and browser installation happens while building the image.

At the end of the build, UID 1000 probes every required tool. Failure, missing
output, incorrect pinned runtime/provider versions, native-parser failure or
Chromium failure reject the image. `/usr/local/share/0/workbench-tool-inventory.json`
records schema version, profile, `linux/arm64`, source commit, requested immutable
base reference, Debian snapshot (or null for Kali), CLI version, OS identity,
tool locations and version outputs, complete dpkg versions, Python import
results, native parser and local browser startup. The receipt is root-owned and
read-only. It proves image-build startup, not SmolVM launch, network access,
authenticated model access or vulnerability verification.

The build script hashes the exported archive. That immutable archive digest is
the runtime identity approved during setup. Matching source inputs is a
repeatable build recipe; **bit-for-bit reproducibility has not been qualified**.
The inventory records a builder's base declaration; OCI build provenance must
be captured by a trusted release builder before publication. Do not treat an
unsigned inventory as an authority to run arbitrary images.

## Explicit build and setup

A plan is the default and does not contact Docker, download images, or start VMs:

```sh
node scripts/build-workbench-image.mjs --profile core-web \
  --archive /absolute/output/0-workbench-core-web.tar
```

After committing the source and arranging sufficient space, `--build` performs
the ARM64 build and a bounded export. It refuses a dirty source tree, insufficient
space, wrong output platform or an existing archive. Build and export have
45-minute/15-minute deadlines, and export stops at the profile cap. Export
creates a new private file and never overwrites an existing archive. It does not
publish, approve or launch it.

```sh
node scripts/build-workbench-image.mjs --profile source --build \
  --archive /absolute/output/0-workbench-source.tar
```

Kali requires an immutable prebuilt base that already includes browser runtime
libraries and the selected Python/tool dependencies. The older
`packages/core/docker/Dockerfile.kali` is an explicit provisioning recipe; its
rolling apt/pip inputs are not reproducible and its output is not automatically
qualified for the workbench. Provision on a roomy build host, record all package
versions, publish immutable OCI bytes, and then use their registry digest:

```sh
node scripts/build-workbench-image.mjs --profile kali \
  --kali-image 'registry.example/approved-kali@sha256:<64-hex-digest>' \
  --archive /absolute/output/0-workbench-kali.tar
```

The placeholder must be replaced with a real digest. A tag, `latest`, local
mutable name or core/source profile with a Kali override is rejected. The Kali
stage does not install apt/pip packages; its startup inventory rejects missing
requirements and verifies `/etc/os-release` identifies Kali. [Kali's official
image documentation](https://www.kali.org/docs/containers/official-kalilinux-docker-images/)
and [branch documentation](https://www.kali.org/docs/general-use/kali-branches/)
explain that rolling images follow changing repositories and that
`kali-last-snapshot` is refreshed at releases; neither mutable label is an
immutable runtime identity.

## Workspace lifecycle and capabilities

The existing setup boundary copies an approved archive into the private state
root, names it by SHA256 and verifies it before launch. Workspace sessions use
that approved archive and retain their mounted workspace/state. A model tool
cannot choose a registry image or cause installation. Existing workspace root,
UID/GID mapping and `/run/0-workbench` admission mount remain unchanged.

The intended console flow is: choose profile during explicit setup, show missing
prerequisites and inventory, approve immutable bytes, then use that workspace
for Bash, files, browser and tools. A stopped workspace must show stopped tool
rows and preserve files for resume; a missing tool should name the missing
profile/tool, not silently execute on the host.

Provider/network capabilities are broker-owned. Provider credentials are not
baked into the image or build receipt. Default tool network egress must not
expose host environment secrets or filesystem credentials. Raw provider keys,
subscription logins, write operations and identity/network tools need their
existing independent authorization; installing a binary does not grant those
capabilities. Runtime and broker implementations own these controls.

## Qualification status

Source tests qualify profile selection, immutable Kali reference validation,
resource plans and build/export refusal. Metadata verification confirms the
official ARM64 Node manifest and dated Debian repository/tool availability.
No image layers, OS packages or browser assets were downloaded in this session.
No new profile image was built: the development disk has less than the 30 GiB
build floor and Docker is unavailable. A follow-up qualified the existing
approved Kali archive with a live brokered ChatGPT account, current mounted CLI,
non-root guest file tools, native parser, Chromium and bounded local scanner
functions. It still lacks required `ssh`, so the complete toolbox is **not**
checked off. See `docs/design/cli-runtime-qualification-20260930.md` and the
sanitized receipts in `docs/qualification/` for measured results. The Kali build
receipt now checks every core tool, including SSH, and rejects initialization
errors even when a tool returns an accepted help exit code. Existing unqualified full-toolbox archives must not be
relabeled as the new profiles without their receipt and a real SmolVM startup
qualification. The final release needs build receipt plus non-root guest tool,
browser, workspace persistence and bounded resource tests before claiming
workspace readiness.
