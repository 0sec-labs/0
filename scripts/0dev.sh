#!/usr/bin/env bash
set -euo pipefail

DEV_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_ENTRY="$DEV_ROOT/packages/cli/dist/index.js"

if [ ! -f "$DEV_ENTRY" ]; then
  echo "0dev: no build found at $DEV_ENTRY" >&2
  echo "0dev: build it with: pnpm --dir $DEV_ROOT --filter 0sec-cli... build" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "0dev: bun is required; install from https://bun.sh" >&2
  exit 1
fi

# An explicit empty token also prevents Bun's .env loader from restoring a
# production token. Keep HOME and all non-Cloud provider settings unchanged.
exec env 0SEC_DEV_SOURCE_ROOT="$DEV_ROOT" \
  0SEC_CLOUD_HOST=https://dev.0sec.ai 0SEC_CLOUD_TOKEN= \
  bun "$DEV_ENTRY" "$@"
