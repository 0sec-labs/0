#!/usr/bin/env sh
# Provision the pinned FoxGuard binary for this host architecture.
#
# Downloads the verified release asset from 0sec-labs/foxguard to a configurable
# install directory (default: /usr/local/bin). The pinned version is the same
# FOXGUARD_PINNED_TAG used by the 0sec runtime (v0.14.0).
#
# Usage:
#   bash scripts/provision-foxguard.sh                    # install to /usr/local/bin
#   INSTALL_DIR=/opt/bin bash scripts/provision-foxguard.sh
set -eu

FOXGUARD_REPO="0sec-labs/foxguard"
FOXGUARD_TAG="${FOXGUARD_TAG:-v0.14.0}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# ── v0.14.0 checksums (cross-checked against the release's checksums.txt) ──
# Update the pin and its checksums together when upgrading.
FOXGUARD_SHA256_LINUX_X64="ef56a4d5cfc4cc4462e435bf31ca0f90694f47df1384772361a67828427db3d9"
FOXGUARD_SHA256_LINUX_ARM64="7d5c7263d71089eb06113a634aa3394ab8b54782b16e67a349693fedbb598120"
FOXGUARD_SHA256_MACOS_ARM64="aa47b956f31bfbc87e0f43cd48e01f3bc73229192ffff0113ff094e5b3fd7d12"
FOXGUARD_SHA256_MACOS_X64="628b6dcecbba8abd7312be1c94ac2346a363a680429b979ec5f63cf8ac7bca4b"
FOXGUARD_SHA256_WIN_X64="6ff15185c968da849845afa321f23f14de142d45efd568a9513d2600eec281c2"

fail() {
  printf '%s\n' "foxguard provisioner: $*" >&2
  exit 1
}

[ "$FOXGUARD_TAG" = "v0.14.0" ] || fail "update the pinned checksums before selecting another release"

# Resolve platform → asset name + expected sha256
case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64)
        ASSET="foxguard-macos-aarch64"
        EXPECTED_SHA256="$FOXGUARD_SHA256_MACOS_ARM64"
        ;;
      x86_64)
        ASSET="foxguard-macos-x86_64"
        EXPECTED_SHA256="$FOXGUARD_SHA256_MACOS_X64"
        ;;
      *) fail "unsupported macOS architecture: $(uname -m)" ;;
    esac
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64)
        ASSET="foxguard-linux-x86_64"
        EXPECTED_SHA256="$FOXGUARD_SHA256_LINUX_X64"
        ;;
      aarch64|arm64)
        ASSET="foxguard-linux-aarch64"
        EXPECTED_SHA256="$FOXGUARD_SHA256_LINUX_ARM64"
        ;;
      *) fail "unsupported Linux architecture: $(uname -m)" ;;
    esac
    ;;
  MINGW*|MSYS*)
    case "$(uname -m)" in
      x86_64)
        ASSET="foxguard-windows-x86_64.exe"
        EXPECTED_SHA256="$FOXGUARD_SHA256_WIN_X64"
        ;;
      *) fail "unsupported Windows architecture: $(uname -m)" ;;
    esac
    ;;
  *)
    fail "unsupported operating system: $(uname -s)"
    ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

DOWNLOAD_URL="https://github.com/${FOXGUARD_REPO}/releases/download/${FOXGUARD_TAG}/${ASSET}"
INSTALL_PATH="${INSTALL_DIR}/foxguard"

# Skip if already installed and matching
if [ -f "$INSTALL_PATH" ] && [ ! -L "$INSTALL_PATH" ]; then
  actual="$(sha256_file "$INSTALL_PATH")"
  if [ "$actual" = "$EXPECTED_SHA256" ]; then
    chmod 755 "$INSTALL_PATH"
    printf '%s\n' "foxguard already verified at ${INSTALL_PATH}" >&2
    exit 0
  fi
  printf '%s\n' "foxguard at ${INSTALL_PATH} has mismatched checksum; re-downloading..." >&2
fi

mkdir -p "$INSTALL_DIR"
tmpdir="$(mktemp -d "${INSTALL_DIR}/.foxguard-install.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

downloaded="${tmpdir}/${ASSET}"
printf '%s\n' "Downloading ${ASSET} from ${FOXGUARD_TAG}..." >&2
curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
  "$DOWNLOAD_URL" -o "$downloaded"

actual="$(sha256_file "$downloaded")"
if [ "$actual" != "$EXPECTED_SHA256" ]; then
  fail "checksum mismatch for ${ASSET} (expected ${EXPECTED_SHA256}, got ${actual})"
fi

chmod 755 "$downloaded"
mv -f "$downloaded" "$INSTALL_PATH"

printf '%s\n' "Installed foxguard ${FOXGUARD_TAG} (${ASSET}) to ${INSTALL_PATH}" >&2