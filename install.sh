#!/usr/bin/env sh
# Install the latest verified standalone 0 binary for this host.
set -eu

REPO="0sec-labs/0"
RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
INSTALL_DIR="${INSTALL_DIR:-${HOME}/.0/bin}"

fail() {
  printf '%s\n' "0 installer: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64) ASSET="0-darwin-arm64" ;;
      *) fail "unsupported macOS architecture; download a matching release asset manually" ;;
    esac
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) ASSET="0-linux-x64" ;;
      aarch64|arm64) ASSET="0-linux-arm64" ;;
      *) fail "unsupported Linux architecture; download a matching release asset manually" ;;
    esac
    ;;
  *)
    fail "unsupported operating system; download the matching GitHub Release asset manually"
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

mkdir -p "$INSTALL_DIR"
manifest="$(mktemp "${TMPDIR:-/tmp}/0-checksums.XXXXXX")"
binary="$(mktemp "${INSTALL_DIR}/.${ASSET}.XXXXXX")"
fg_binary=""
cleanup() {
  rm -f "$manifest" "$binary" "$fg_binary"
}
trap cleanup EXIT HUP INT TERM

printf '%s\n' "Downloading ${ASSET}…" >&2
curl --fail --location --silent --show-error --retry 3 --retry-delay 1 \
  "${RELEASE_BASE_URL}/checksums.txt" -o "$manifest"
curl --fail --location --silent --show-error --retry 3 --retry-delay 1 \
  "${RELEASE_BASE_URL}/${ASSET}" -o "$binary"

expected="$(awk -v asset="$ASSET" '$2 == asset || $2 == ("*" asset) { print $1; exit }' "$manifest")"
[ -n "$expected" ] || fail "checksums.txt has no entry for ${ASSET}"
actual="$(sha256_file "$binary")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for ${ASSET}; refusing to install"

chmod 755 "$binary"
mv -f "$binary" "${INSTALL_DIR}/0"
binary=""
printf '%s\n' "Installed verified 0 to ${INSTALL_DIR}/0" >&2

# Provision the default static analyzer too, so standalone source reviews do
# not require Node/npm. INSTALL_FOXGUARD=0 opts out for pre-provisioned hosts.
if [ "${INSTALL_FOXGUARD:-1}" != "0" ]; then
  FOXGUARD_TAG="${FOXGUARD_TAG:-v0.14.0}"
  [ "$FOXGUARD_TAG" = "v0.14.0" ] || fail "update the pinned FoxGuard checksums before selecting another release"
  FOXGUARD_REPO="0sec-labs/foxguard"

  case "$(uname -s)" in
    Darwin)
      case "$(uname -m)" in
        arm64) FG_ASSET="foxguard-macos-aarch64"; FG_SHA256="aa47b956f31bfbc87e0f43cd48e01f3bc73229192ffff0113ff094e5b3fd7d12" ;;
        *) fail "unsupported macOS architecture for FoxGuard companion" ;;
      esac ;;
    Linux)
      case "$(uname -m)" in
        x86_64|amd64) FG_ASSET="foxguard-linux-x86_64"; FG_SHA256="ef56a4d5cfc4cc4462e435bf31ca0f90694f47df1384772361a67828427db3d9" ;;
        aarch64|arm64) FG_ASSET="foxguard-linux-aarch64"; FG_SHA256="7d5c7263d71089eb06113a634aa3394ab8b54782b16e67a349693fedbb598120" ;;
        *) fail "unsupported Linux architecture for FoxGuard companion" ;;
      esac ;;
    *) fail "unsupported operating system for FoxGuard companion" ;;
  esac

  fg_binary="$(mktemp "${INSTALL_DIR}/.${FG_ASSET}.XXXXXX")"

  printf '%s\n' "Downloading FoxGuard ${FOXGUARD_TAG} companion (${FG_ASSET})…" >&2
  curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
    "https://github.com/${FOXGUARD_REPO}/releases/download/${FOXGUARD_TAG}/${FG_ASSET}" -o "$fg_binary"

  actual="$(sha256_file "$fg_binary")"
  [ "$FG_SHA256" = "$actual" ] || fail "FoxGuard checksum mismatch for ${FG_ASSET}; refusing to install"

  chmod 755 "$fg_binary"
  mv -f "$fg_binary" "${INSTALL_DIR}/foxguard"
  printf '%s\n' "Installed verified FoxGuard to ${INSTALL_DIR}/foxguard" >&2
fi

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) printf '%s\n' "Add ${INSTALL_DIR} to PATH to run: 0 --help (or 0 --help)" >&2 ;;
esac
