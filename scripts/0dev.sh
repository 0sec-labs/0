#!/usr/bin/env bash
set -euo pipefail

DEV_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_ENTRY="$DEV_ROOT/packages/cli/dist/index.js"

# Always rebuild the checkout and its workspace dependencies. Never fall back to
# an installed release or stale dist output when the source build fails.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "0dev: pnpm is required to build the development CLI" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "0dev: bun is required; install from https://bun.sh" >&2
  exit 1
fi
pnpm --dir "$DEV_ROOT" --filter @0/cli... build >&2
if [ ! -f "$DEV_ENTRY" ]; then
  echo "0dev: build did not produce $DEV_ENTRY" >&2
  exit 1
fi

# The dev account's automatic hosted route is the default. Operators can opt
# into a BYOK provider by setting ZERO_SELECTED_PROVIDER and ZERO_MODEL.
DEV_PROVIDER="${ZERO_SELECTED_PROVIDER:-hosted}"
DEV_MODEL="${ZERO_MODEL:-}"
if [ "$DEV_PROVIDER" = "hosted" ]; then
  DEV_MODEL=""
fi
exec env ZERO_DEV_SOURCE_ROOT="$DEV_ROOT" \
  ZERO_CLOUD_HOST=https://dev.cloud.0.security ZERO_CLOUD_TOKEN= \
  ZERO_SELECTED_PROVIDER="$DEV_PROVIDER" ZERO_MODEL="$DEV_MODEL" \
  bun "$DEV_ENTRY" "$@"
