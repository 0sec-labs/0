#!/usr/bin/env bash
set -euo pipefail

DEV_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_ENTRY="$DEV_ROOT/packages/cli/dist/index.js"

DEV_UI_WATCH=0
DEV_ARGS=()
PARSE_DEV_OPTIONS=1
for argument in "$@"; do
  if [ "$PARSE_DEV_OPTIONS" -eq 1 ] && [ "$argument" = "--watch" ]; then
    DEV_UI_WATCH=1
  else
    DEV_ARGS+=("$argument")
    PARSE_DEV_OPTIONS=0
  fi
done

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

# Pass through the caller's provider, model, and credentials unchanged. The
# runtime chooses a BYOK or subscription provider as it does for the normal CLI.
# --watch is a safe frontend remount on the existing renderer, not bun --hot or
# component FastRefresh. Core/shared dependencies, startup and the reload ABI
# require this full coherent build again. Engine updates remain a separate option.
# macOS's Bash 3 treats an empty array as unset under nounset.
exec env ZERO_DEV_SOURCE_ROOT="$DEV_ROOT" ZERO_DEV_UI_WATCH="$DEV_UI_WATCH" bun "$DEV_ENTRY" ${DEV_ARGS[@]+"${DEV_ARGS[@]}"}
