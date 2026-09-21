#!/usr/bin/env bash
set -euo pipefail

DEV_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
O_SEC_BIN="${O_SEC_BIN:-$HOME/.local/bin/0}"

# --build flag: force source build + bun invocation (useful when iterating on
# core/cli TypeScript).
if [ "${1:-}" = "--build" ]; then
  shift
  DEV_ENTRY="$DEV_ROOT/packages/cli/dist/index.js"
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "0dev: pnpm is required to build the development CLI" >&2
    exit 1
  fi
  pnpm --dir "$DEV_ROOT" --filter 0... build
  if [ ! -f "$DEV_ENTRY" ]; then
    echo "0dev: build did not produce $DEV_ENTRY" >&2
    exit 1
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "0dev: bun is required; install from https://bun.sh" >&2
    exit 1
  fi
  exec env ZERO_DEV_SOURCE_ROOT="$DEV_ROOT" \
    ZERO_CLOUD_HOST=https://dev.cloud.0.security ZERO_CLOUD_TOKEN= \
    bun "$DEV_ENTRY" "$@"
fi

# Default: use the installed packaged 0 binary (coherent release build).
# The empty ZERO_CLOUD_TOKEN override prevents any env-level production token
# from leaking in; the binary uses its saved DEV credentials.
if [ ! -x "$O_SEC_BIN" ]; then
  echo "0dev: packaged 0 binary not found at $O_SEC_BIN" >&2
  echo "0dev:   install the latest release from https://github.com/0sec-labs/0" >&2
  echo "0dev:   or use --build to run from source" >&2
  exit 1
fi

exec env \
  ZERO_CLOUD_HOST=https://dev.cloud.0.security ZERO_CLOUD_TOKEN= \
  "$O_SEC_BIN" "$@"