# 0 Kernel VM — KASAN-enabled crash reproducer

Build recipe for the KASAN-enabled Linux kernel + root filesystem used by
automated kernel crash validation.

## Quick start

```bash
# From the repository root
cd packages/core/src/triage/kernel-vm
# Build (15-30 min, requires Docker)
./build.sh ./out

# `ZERO_*` names begin with a digit, so pass them with `env` rather than
# Bash `export`.
env \
  ZERO_KERNEL_QEMU=1 \
  ZERO_KERNEL_QEMU_KERNEL=./out/bzImage \
  ZERO_KERNEL_QEMU_DISK=./out/rootfs.img \
  ZERO_KERNEL_QEMU_CONFIG=./out/kernel.config \
  ZERO_KERNEL_QEMU_EXPECTED_RELEASE=6.8.12 \
  0 ingest --verify /path/to/crash-reports/

# Run a standalone C reproducer through the same VM oracle
0 ingest --reproducer ./poc.c --kernel-tree ~/src/linux --kernel-config kasan --output json

# Raw .syz programs require syz-execprog in the guest image
0 ingest --syz ./program.syz --kernel-tree ~/src/linux --kernel-config kasan --output json
```

The `env` settings apply only to that invocation. Standalone tree builds use
`~/.0/kernel-cache` by default, with `kasan`, `kcsan`, or `plain` profiles.
Prebuilt kernel/disk environment overrides bypass building unless forced;
their expected release must match the actual image, including local suffixes.
The stock rootfs does not include `syz-execprog`, so provision it before using
the raw `.syz` lane. A successful crash reproduction does not establish novelty,
unprivileged reachability, or root escalation.

## What's included

**Kernel** (bzImage):
- Linux 6.8.12; the recipe requests KASAN, UBSAN, KCSAN and lock/RCU debugging
- The exported `kernel.config` is authoritative after `olddefconfig`; requested
  options are not a guarantee of simultaneous sanitizer support. Source-tree
  builds provide separate `kasan` and `kcsan` profiles.
- Subsystem support: NFS/NFSd, bluetooth, WiFi (mac80211), SCTP, 9P, ext4
- nokaslr for reproducible crash addresses
- virtio drivers for QEMU

**Root filesystem** (rootfs.img, 512MB ext4):
- Debian Bookworm minimal
- GCC + binutils + libc-dev for reproducer compilation
- gdb, strace for debugging
- dedicated `/sbin/0sec-init` boot path that mounts the host 9p share and runs `/mnt/0sec/runner.sh`
- OpenSSH + exported `osec_vm_key` for manual debugging only. The verifier
  itself does not use SSH.

The repository does not commit prebuilt images. Build them locally with
`./build.sh`. The historical GitHub Actions validator workflow is no longer
present; manual maintainer scripts remain under `scripts/kernel-validator-*`.

## Guest contract

The 0 verifier boots QEMU with the kernel image, disk image, and a 9p host
share. A compatible guest must:

- boot as x86_64 under `qemu-system-x86_64`
- mount the 9p share tag `osecshare` at `/mnt/0sec`
- execute `/mnt/0sec/runner.sh`
- provide `/usr/bin/gcc`, libc headers, and binutils
- allow `dmesg` collection after the reproducer runs

The default kernel command line is:

```text
console=ttyS0 root=/dev/vda rw nokaslr panic=-1 init=/sbin/0sec-init
```

## Maintainer smoke scripts

From the repository root, `scripts/kernel-validator-e2e.sh` uses a built CLI,
downloads a syzbot crash/reproducer pair, and executes with the VM configuration
above. `node scripts/kernel-validator-batch.mjs --help` describes the batch corpus
runner. Neither provisions the VM images. These are execution scripts, not
current scheduled CI lanes; a dry-run/skipped result is not a verified crash.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZERO_KERNEL_QEMU` | - | Set to `1` to enable |
| `ZERO_KERNEL_QEMU_KERNEL` | - | Path to bzImage |
| `ZERO_KERNEL_QEMU_DISK` | - | Path to rootfs.img |
| `ZERO_KERNEL_QEMU_CONFIG` | - | Build config required for direct execution receipt binding |
| `ZERO_KERNEL_QEMU_EXPECTED_RELEASE` | - | Exact built kernel release required for direct/prebuilt execution |
| `ZERO_KERNEL_QEMU_MEMORY_MB` | `2048` | VM memory |
| `ZERO_KERNEL_QEMU_SMP` | `2` | CPU cores |
| `ZERO_KERNEL_QEMU_TIMEOUT_SEC` | `60` | Reproducer timeout |
| `ZERO_KERNEL_QEMU_BOOT_TIMEOUT_SEC` | `120` | Boot timeout |
| `ZERO_KERNEL_QEMU_ACCEL` | - | QEMU accelerator (e.g. `kvm`) |
| `ZERO_KERNEL_QEMU_SHARE_TAG` | `osecshare` | 9p mount tag used by the guest boot script |
| `ZERO_KERNEL_QEMU_ARTIFACT_DIR` | - | Preserve VM run artifacts (serial log, compile log, dmesg, runner outputs) instead of deleting the temp directory |
| `ZERO_KERNEL_BUILD_CACHE` | `~/.0/kernel-cache` | Cache directory for `--kernel-tree` VM builds |
