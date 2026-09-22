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
  pnpm --dir "$DEV_ROOT" --filter @0/cli... build
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

# Default: run the checked-out source through Bun so `0dev` actually uses the
# current checkout. The packaged binary remains the fallback when Bun is absent.
if command -v bun >/dev/null 2>&1; then
  exec env ZERO_DEV_SOURCE_ROOT="$DEV_ROOT" \
    ZERO_CLOUD_HOST=https://dev.cloud.0.security ZERO_CLOUD_TOKEN= \
    bun "$DEV_ROOT/packages/cli/src/index.ts" "$@"
fi

# Fallback: use the installed packaged 0 binary when Bun is unavailable.
# The fallback is release code and may not contain unreleased source fixes.