#!/usr/bin/env bash
#
# ci-changed.sh [base-ref] — decide which verify groups a change can affect.
# Prints KEY=true|false lines (GITHUB_OUTPUT format):
#   code     dashboard/browser/smoke/unit groups
#   engine   engine suite
#   docs     docs site build (and, on main, deploy)
#   docker   Docker image + server-mode smoke
#   deps     dependency manifests changed (advisory audit)
#
# Safe by construction: on tags, for new branches (no base), when the
# diff cannot be computed, or when the workflow itself changed, everything runs.
# A skipped group still reports success so the aggregate `verify` job stays the
# single required check.
set -uo pipefail
BASE="${1:-}"
KEYS="code engine docs docker deps"
all() { for k in $KEYS; do printf '%s=true\n' "$k"; done; exit 0; }
case "${GITHUB_REF:-}" in refs/tags/*) all ;; esac
# On main the caller passes the last green Main sha as the base.
[ -n "$BASE" ] && ! [[ "$BASE" =~ ^0+$ ]] || BASE="$(git merge-base HEAD origin/main 2>/dev/null || true)"
[ -n "$BASE" ] || all
files="$(git diff --name-only "$BASE" HEAD 2>/dev/null)" || all
[ -n "$files" ] || all
for k in $KEYS; do eval "$k=false"; done
while IFS= read -r f; do
  case "$f" in
    .github/workflows/main.yml|scripts/ci-changed.sh) all ;;
  esac
  case "$f" in
    docs/*|*.md|company-brain/*|LICENSE*) ;;                       # docs only: no test group
    packages/web/*) code=true ;;                                   # dashboard: engine suite cannot see it
    *) code=true; engine=true ;;                                   # engine, cli, root, scripts, workflows: everything
  esac
  case "$f" in
    docs/*|README.md|packages/cli/*|packages/engine/*|scripts/check-docs-site.mjs|scripts/sync-cli-docs.mjs|scripts/check-docs-commands*|package.json|pnpm-lock.yaml) docs=true ;;
  esac
  case "$f" in
    deploy/docker/*|scripts/docker/*|scripts/smoke-server-mode.mjs|deploy/compose/*|packages/cli/src/web/server-mode*|packages/cli/src/web/dashboard-http.ts|packages/cli/src/commands/dashboard.ts) docker=true ;;
  esac
  case "$f" in
  esac
  case "$f" in
  esac
  case "$f" in
  esac
  case "$f" in
    package.json|packages/*/package.json|pnpm-lock.yaml|pnpm-workspace.yaml) deps=true ;;
  esac
done <<< "$files"
for k in $KEYS; do printf '%s=%s\n' "$k" "${!k}"; done
