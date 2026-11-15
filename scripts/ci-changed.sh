#!/usr/bin/env bash
#
# ci-changed.sh [base-ref] — decide which verify groups a change can affect.
# Prints KEY=true|false lines (GITHUB_OUTPUT format): code, engine.
#
# Safe by construction: on main, on tags, for new branches (no base), when the
# diff cannot be computed, or when a shared/root file changed, everything runs.
# Only a branch whose diff is entirely inside docs/web/cli/engine-only paths
# skips the groups it cannot affect. A skipped group still reports success so
# the aggregate `verify` job stays the single required check.
set -uo pipefail
BASE="${1:-}"
all() { printf 'code=true\nengine=true\n'; exit 0; }
case "${GITHUB_REF:-}" in refs/heads/main|refs/tags/*) all ;; esac
[ -n "$BASE" ] && ! [[ "$BASE" =~ ^0+$ ]] || BASE="$(git merge-base HEAD origin/main 2>/dev/null || true)"
[ -n "$BASE" ] || all
files="$(git diff --name-only "$BASE" HEAD 2>/dev/null)" || all
[ -n "$files" ] || all
code=false engine=false
while IFS= read -r f; do
  case "$f" in
    docs/*|*.md|company-brain/*|LICENSE*) ;;                       # docs only
    packages/web/*) code=true ;;                                   # dashboard: engine suite cannot see it
    *) code=true; engine=true ;;                                   # engine, cli, root, scripts, workflows: everything
  esac
done <<< "$files"
printf 'code=%s\nengine=%s\n' "$code" "$engine"
