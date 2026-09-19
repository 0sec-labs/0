---
title: Kernel VM Verification
description: Build and configure the QEMU guest used by 0 ingest --verify.
---

`0 ingest --verify` runs C reproducers inside a local QEMU guest and compares
the guest `dmesg` against the imported kernel crash report. Without the VM,
kernel verification is static-only.

For choosing between `ingest --verify`, `research linux`,
`research linux-matrix`, dynamic-witness hunting, and weaponization, see
[Research Workflows](/research-workflows/). Importing an external boot matrix
does not execute the boots; a source checkout alone does not provision the guest.

## What the repo provides

A maintained build recipe at `packages/core/src/triage/kernel-vm/` builds:

- `bzImage` — Linux 6.8.12 for x86_64. The recipe requests KASAN, UBSAN,
  KCSAN, lock debugging, RCU stall detection, and virtio/9p/ext4/NFS/Bluetooth/WiFi/SCTP
  support; inspect the generated config rather than assuming every requested
  option survives `olddefconfig`. Tree builds use separate `kasan` and `kcsan` profiles.
- `rootfs.img` — 512 MB Debian Bookworm ext4 with `gcc`, `binutils`, `make`,
  `procps`, `kmod`, `strace`, `gdb`, OpenSSH, and `/sbin/0sec-init`.
- `kernel.config` — the exact config used for the build.
- `osec_vm_key[.pub]` — root SSH keypair for manual debugging only (the verifier
  uses a QEMU 9p share, not SSH).

Prebuilt artifacts are not committed. Build locally; the earlier kernel-validator
GitHub Actions workflows are not present in this checkout.

## Requirements

- Docker (reproducible guest build)
- QEMU (`qemu-system-x86_64`)
- ~20 GB free disk for the build cache
- Enough guest memory (default 2048 MB)
- Optional KVM acceleration on Linux; macOS/CI run without it, but may need
  higher boot/reproducer timeouts.

## Build recipe

From the repo root:

```bash
# Docker builds the guest; the published 0 CLI and QEMU are needed to run it.
cd packages/core/src/triage/kernel-vm
env 0SEC_KERNEL_VM_MAKE_JOBS=4 \
  ./build.sh "$HOME/.0sec/kernel-vm/linux-6.8.12-kasan"
```

Output:

```text
$HOME/.0sec/kernel-vm/linux-6.8.12-kasan/
  bzImage
  rootfs.img
  kernel.config
  osec_vm_key
  osec_vm_key.pub
```

Treat the output directory as a local cache; regenerate it when the Dockerfile,
kernel version, or guest package list changes.

<span id="configure-0sec"></span>
## Configure 0

Required values must be passed with `env`: `0SEC_*` names begin with a digit and
cannot be exported by POSIX shells.

```bash
env \
  0SEC_KERNEL_QEMU=1 \
  0SEC_KERNEL_QEMU_KERNEL="$HOME/.0sec/kernel-vm/linux-6.8.12-kasan/bzImage" \
  0SEC_KERNEL_QEMU_DISK="$HOME/.0sec/kernel-vm/linux-6.8.12-kasan/rootfs.img" \
  0SEC_KERNEL_QEMU_CONFIG="$HOME/.0sec/kernel-vm/linux-6.8.12-kasan/kernel.config" \
  0SEC_KERNEL_QEMU_EXPECTED_RELEASE=6.8.12 \
  0 ingest --verify ./crashes
```

Recommended local defaults can be added to the same command:

```bash
env \
  0SEC_KERNEL_QEMU=1 \
  0SEC_KERNEL_QEMU_KERNEL="$HOME/.0sec/kernel-vm/linux-6.8.12-kasan/bzImage" \
  0SEC_KERNEL_QEMU_DISK="$HOME/.0sec/kernel-vm/linux-6.8.12-kasan/rootfs.img" \
  0SEC_KERNEL_QEMU_CONFIG="$HOME/.0sec/kernel-vm/linux-6.8.12-kasan/kernel.config" \
  0SEC_KERNEL_QEMU_EXPECTED_RELEASE=6.8.12 \
  0SEC_KERNEL_QEMU_MEMORY_MB=2048 \
  0SEC_KERNEL_QEMU_SMP=2 \
  0SEC_KERNEL_QEMU_BOOT_TIMEOUT_SEC=180 \
  0SEC_KERNEL_QEMU_TIMEOUT_SEC=60 \
  0SEC_KERNEL_QEMU_ARTIFACT_DIR="$HOME/.0sec/kernel-vm/runs" \
  0 ingest --verify ./crashes
```

On Linux hosts with KVM, add `0SEC_KERNEL_QEMU_ACCEL=kvm` to that `env` invocation.

Leave `0SEC_KERNEL_QEMU_APPEND` unset unless using a custom guest. Default:

```text
console=ttyS0 root=/dev/vda rw nokaslr panic=-1 init=/sbin/0sec-init
```

The release above applies only to the unmodified 6.8.12 recipe. For custom
images, supply the exact built release, including any local-version suffix.
Direct VM execution requires the expected release and a real config for receipt
binding; a filename is not provenance.

## Run verification

Place crash reports and reproducers in one directory; file stems are matched:

```text
crashes/
  bug-001.log
  bug-001.c
  bug-002.report
  bug-002.syz
```

```bash
0 ingest ./crashes --verify --output json
```

Run this with the same `env` settings as above; they apply only to that one
command and are not saved by the first invocation.

For a standalone reproducer, use a source tree and the current profile flag:

```bash
0 ingest --reproducer ./poc.c --kernel-tree /path/to/linux \
  --kernel-config kasan --output json
```

This resolves/builds cached artifacts (default `~/.0sec/kernel-cache`, override
with `--kernel-cache-dir` or `0SEC_KERNEL_BUILD_CACHE`). Built-in profiles are
`kasan`, `kcsan`, and `plain`. Existing `0SEC_KERNEL_QEMU_KERNEL`/`DISK` overrides
take precedence unless `--force-kernel-build` is used, so unset those overrides
when you intend to test the supplied tree. `--syz ./program.syz` requires
`syz-execprog` in the guest; the stock rootfs recipe does not install it.

For each C reproducer 0 writes `repro.c` and `runner.sh` to a temp dir, boots
QEMU with a 9p share (`osecshare`), lets `/sbin/0sec-init` run
`/mnt/0sec/runner.sh`, compiles and runs the reproducer under the timeout, and
copies `compile.log`, `run.log`, `dmesg.log`, markers, and the serial log back
to the artifact directory (when configured).

### Privilege and provenance

The guest runs reproducers as UID 0 by default, so it can prove repeatable crash
behavior but not unprivileged reachability — such evidence is marked privileged.
Zero-cap certification uses a trusted launcher that drops all IDs, groups, and
capabilities, sets `no_new_privs`, and binds a hashed receipt to a nonce and the
reproducer digest; missing or inconsistent evidence falls back to privileged.

Schema-v2 receipts also bind a staged copy of the `bzImage`, its config SHA-256,
and the expected kernel release; QEMU boots the staged image and the host
re-hashes it before and after. The guest supplies its runtime release
(`/proc/sys/kernel/osrelease`) and boot UUID; a release mismatch, malformed or
repeated UUID, or staged-image change invalidates the gate. This catches
ordinary label/artifact mixups but is **not** hardware attestation (no TPM /
SEV-SNP) and does not defend against a malicious host or guest kernel, nor prove
the running kernel config without a runtime measurement like `/proc/config.gz`.

If `0SEC_KERNEL_QEMU_ARTIFACT_DIR` is unset, the temp run directory is deleted
after each attempt.

## Guest contract

A custom guest must satisfy:

| Requirement | Contract |
| --- | --- |
| Architecture | x86_64, bootable by `qemu-system-x86_64` |
| Root device | `root=/dev/vda` (or matching custom append) |
| Init path | `/sbin/0sec-init` (unless `0SEC_KERNEL_QEMU_APPEND` changed) |
| Host share | Mount 9p tag `osecshare` at `/mnt/0sec` |
| Runner | Execute `/mnt/0sec/runner.sh`, leave results in the share |
| Compiler | `/usr/bin/gcc` plus libc headers and `binutils` |
| Logs | `dmesg` readable after the reproducer runs |
| Kernel | Debug-friendly, crash signal visible in `dmesg` |

SSH is not part of the contract; the keypair is only for manual debugging.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `0SEC_KERNEL_QEMU` | Yes | - | `1` to enable VM execution |
| `0SEC_KERNEL_QEMU_KERNEL` | Yes | - | Path to `bzImage` |
| `0SEC_KERNEL_QEMU_DISK` | Yes | - | Path to `rootfs.img` or other bootable disk |
| `0SEC_KERNEL_QEMU_CONFIG` | For direct execution receipts | - | Config used to build the selected kernel |
| `0SEC_KERNEL_QEMU_EXPECTED_RELEASE` | For direct/prebuilt execution | - | Exact expected `uname -r`; never inferred from filename |
| `0SEC_KERNEL_QEMU_BINARY` | No | `qemu-system-x86_64` | QEMU binary |
| `0SEC_KERNEL_QEMU_DISK_FORMAT` | No | inferred | `raw` or `qcow2` |
| `0SEC_KERNEL_QEMU_MEMORY_MB` | No | `2048` | Guest memory (MB) |
| `0SEC_KERNEL_QEMU_SMP` | No | `2` | Guest CPU count |
| `0SEC_KERNEL_QEMU_APPEND` | No | see above | Kernel command line |
| `0SEC_KERNEL_QEMU_ACCEL` | No | - | Accelerator, e.g. `kvm` |
| `0SEC_KERNEL_QEMU_INITRD` | No | - | Optional initrd for custom guests |
| `0SEC_KERNEL_QEMU_BOOT_TIMEOUT_SEC` | No | `120` | Boot + setup time |
| `0SEC_KERNEL_QEMU_TIMEOUT_SEC` | No | `60` | Reproducer time |
| `0SEC_KERNEL_QEMU_SHARE_TAG` | No | `osecshare` | 9p mount tag |
| `0SEC_KERNEL_QEMU_ARTIFACT_DIR` | No | - | Where per-run artifacts are preserved |

## Troubleshooting

If the VM exits early, inspect `serial.log` in the configured artifact directory.
The retained manual smoke script is `scripts/kernel-validator-e2e.sh`; it expects
built `packages/cli/dist/index.js`, downloads a syzbot report/reproducer, and uses
your configured VM artifacts. It is not a current GitHub Actions workflow.

## Batch validation

Maintainers can run `node scripts/kernel-validator-batch.mjs --help` from the
repository root. The script accepts `--corpus`, `--out-dir`, `--cli`, and `--limit`;
its default corpus is `scripts/kernel-validator-batch-corpus.json`.
Supply the VM configuration above and a built CLI for actual execution.
`--dry-run` writes skipped summaries without QEMU and is not reproduction proof.
Outputs include `summary.json`, `summary.md`, per-case results, raw CLI output,
and retained VM artifacts. Inspect `verified`, `crashMatch`, and `reason`:
`reproduced` alone can mean execution occurred without a recognized crash.
