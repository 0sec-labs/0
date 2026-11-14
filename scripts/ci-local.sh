#!/usr/bin/env bash
#
# ci-local.sh — replay the `verify` job of .github/workflows/main.yml locally.
#
# The steps are READ FROM THE WORKFLOW (no copy to drift), executed in order
# from the repo root under a scrubbed environment: `env -i` with PATH, a
# throw-away HOME, the job/step `env:` blocks, and the package-manager/browser
# caches pointed at your real ones so re-runs stay fast. Run it before pushing
# to main; the push is safe only when it exits 0.
#
# Not replayed: `uses:` steps (checkout/setup-*), "Bootstrap runner" (CI disk
# and corepack shim preflight) and "Provision FoxGuard binary" (uses a foxguard
# already on PATH; falls back to the provision script only if none is found).
# `playwright install --with-deps` is run without --with-deps (needs root).
# Network is used only by what the steps themselves need (pnpm install,
# playwright browser download, `npm install` in dist/).
#
# Usage: scripts/ci-local.sh [--list] [--from "<step name>"] [--only "<step name>"]
#                            [--skip-build] [--skip-install] [--keep-going]
#   --from NAME     start at the first step whose name contains NAME
#   --only NAME     run just the matching step(s)
#   --skip-build    skip "Build CLI" (reuse existing dist/ and package outputs)
#   --skip-install  skip "Install dependencies"
#   --keep-going    run every step and report all failures at the end
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORKFLOW=".github/workflows/main.yml"
FROM="" ONLY="" LIST=0 SKIP_BUILD=0 SKIP_INSTALL=0 KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:?--from needs a step name}"; shift 2 ;;
    --only) ONLY="${2:?--only needs a step name}"; shift 2 ;;
    --list) LIST=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --keep-going) KEEP=1; shift ;;
    -h|--help) sed -n 2,30p "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

YAML_DIR="$(ls -d "$ROOT"/node_modules/.pnpm/yaml@*/node_modules/yaml 2>/dev/null | head -1 || true)"
[ -n "$YAML_DIR" ] || { echo "run 'pnpm install' once first (yaml parser not found)" >&2; exit 2; }

STEPS="$(node -e '
const { parse } = require(process.argv[1]);
const doc = parse(require("fs").readFileSync(process.argv[2], "utf8"));
const job = doc.jobs.verify;
const out = (job.steps || []).filter((s) => s.run).map((s) => ({ name: s.name, run: s.run, env: { ...(job.env || {}), ...(s.env || {}) } }));
process.stdout.write(JSON.stringify(out));
' "$YAML_DIR" "$WORKFLOW")" || { echo "failed to parse $WORKFLOW" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REAL_HOME="$HOME"
mkdir -p "$TMP/home" "$TMP/runner-temp"

# Prefer the foxguard on PATH; otherwise provision one into a temp dir.
FOXDIR=""
if ! command -v foxguard >/dev/null 2>&1; then
  FOXDIR="$TMP/runner-temp/0-tools/bin"
  INSTALL_DIR="$FOXDIR" bash "$ROOT/scripts/provision-foxguard.sh" || echo "warning: foxguard provisioning failed" >&2
fi

# Pin pnpm to the repo's packageManager version for every step (also inside
# tests that spawn `pnpm` in temp dirs, where corepack would otherwise try to
# resolve "latest" with a scrubbed HOME and fail offline).
PNPM_VERSION="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
mkdir -p "$TMP/shim"
printf '#!/bin/sh\nexec corepack pnpm@%s "$@"\n' "$PNPM_VERSION" > "$TMP/shim/pnpm"
chmod +x "$TMP/shim/pnpm"

COUNT="$(node -e 'console.log(JSON.parse(process.argv[1]).length)' "$STEPS")"
started=0 failed=()
for i in $(seq 0 $((COUNT - 1))); do
  name="$(node -e 'console.log(JSON.parse(process.argv[1])[+process.argv[2]].name)' "$STEPS" "$i")"
  [ "$LIST" = 1 ] && { echo "$name"; continue; }
  case "$name" in "Bootstrap runner"|"Provision FoxGuard binary") continue ;; esac
  [ -n "$FROM" ] && [ "$started" = 0 ] && [[ "$name" != *"$FROM"* ]] && continue
  started=1
  [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]] && continue
  [ "$SKIP_BUILD" = 1 ] && [ "$name" = "Build CLI" ] && { echo "[ci-local] skip: $name"; continue; }
  [ "$SKIP_INSTALL" = 1 ] && [ "$name" = "Install dependencies" ] && { echo "[ci-local] skip: $name"; continue; }

  node -e '
const s = JSON.parse(process.argv[1])[+process.argv[2]];
const fs = require("fs");
fs.writeFileSync(process.argv[3], s.run.replace(/ --with-deps/g, ""));
fs.writeFileSync(process.argv[4], Object.entries(s.env).map(([k, v]) => `${k}=${String(v)}`).join("\0") + "\0");
' "$STEPS" "$i" "$TMP/step.sh" "$TMP/step.env"
  extra=()
  while IFS= read -r -d '' kv; do [ -n "$kv" ] && extra+=("$kv"); done < "$TMP/step.env"

  printf '\n\033[36m[ci-local] ==> %s\033[0m\n' "$name"
  # PATH is kept (node/pnpm/bun/foxguard); everything else is scrubbed. Caches
  # point at the real home so a throw-away HOME does not force re-downloads.
  if env -i \
      PATH="$TMP/shim:${FOXDIR:+$FOXDIR:}$PATH" HOME="$TMP/home" TMPDIR="${TMPDIR:-/tmp}" CI=true GITHUB_ACTIONS=true \
      RUNNER_TEMP="$TMP/runner-temp" GITHUB_WORKSPACE="$ROOT" \
      COREPACK_HOME="${COREPACK_HOME:-$REAL_HOME/.cache/node/corepack}" npm_config_cache="$REAL_HOME/.npm" PNPM_HOME="${PNPM_HOME:-$REAL_HOME/.local/share/pnpm}" \
      npm_config_store_dir="$(pnpm store path 2>/dev/null || echo "$REAL_HOME/.pnpm-store")" \
      PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$REAL_HOME/Library/Caches/ms-playwright}" \
      ${extra[@]+"${extra[@]}"} \
      bash -eo pipefail "$TMP/step.sh"; then
    printf '\033[32m[ci-local] ok: %s\033[0m\n' "$name"
  else
    printf '\033[31m[ci-local] FAILED: %s\033[0m\n' "$name" >&2
    failed+=("$name")
    [ "$KEEP" = 1 ] || break
  fi
done

[ "$LIST" = 1 ] && exit 0
if [ "${#failed[@]}" -gt 0 ]; then
  printf '\n[ci-local] RED — failed steps:\n'; printf '  - %s\n' "${failed[@]}"; exit 1
fi
printf '\n[ci-local] GREEN\n'
