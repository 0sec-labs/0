#!/usr/bin/env bash
# Inputs are environment values, never interpolated shell source.
set -euo pipefail
fail() { echo "::error::$1" >&2; exit 1; }
MODE="${INPUT_MODE:-review}"
PATH_INPUT="${INPUT_PATH:-.}"
PACKAGE_INPUT="${INPUT_PACKAGE:-}"
TARGET_INPUT="${INPUT_TARGET:-}"
SCOPE="${INPUT_SCOPE:-}"
SCAN_MODE="${INPUT_SCAN_MODE:-probe}"
DEPTH="${INPUT_DEPTH:-quick}"
RUNTIME="${INPUT_RUNTIME:-api}"
TIMEOUT="${INPUT_TIMEOUT:-300000}"
COST_CEILING="${INPUT_COST_CEILING:-5}"
PRIMARY_FORMAT="${INPUT_FORMAT:-json}"
SEVERITY_THRESHOLD="${INPUT_SEVERITY_THRESHOLD:-high}"
COUNT_THRESHOLD="${INPUT_THRESHOLD:-0}"
REPORT_DIR="${INPUT_REPORT_DIR:-0-report}"
CLI="${INPUT_CLI_PATH:-0}"
DIFF_BASE="${INPUT_DIFF_BASE:-}"
CHANGED_ONLY="${INPUT_CHANGED_ONLY:-}"
STATIC_ONLY="${INPUT_STATIC_ONLY:-false}"
ACTION_ROOT="${ZERO_ACTION_ROOT:-${GITHUB_ACTION_PATH:-}}"
[[ -n "$ACTION_ROOT" && -n "${GITHUB_OUTPUT:-}" ]] || fail 'Action root and GITHUB_OUTPUT are required.'
case "$MODE" in review|audit|scan) ;; *) fail 'Invalid mode.' ;; esac
case "$DEPTH" in quick|default|deep) ;; *) fail 'Invalid depth.' ;; esac
case "$RUNTIME" in api|claude|codex|gemini|auto) ;; *) fail 'Invalid runtime.' ;; esac
case "$SCAN_MODE" in probe|deep|mcp|web) ;; *) fail 'Invalid scan-mode.' ;; esac
case "$PRIMARY_FORMAT" in json|sarif) ;; *) fail 'Invalid format.' ;; esac
case "$SEVERITY_THRESHOLD" in critical|high|medium|low|info|none) ;; *) fail 'Invalid severity-threshold.' ;; esac
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || fail 'Timeout must be a positive integer.'
[[ "$COUNT_THRESHOLD" =~ ^[0-9]+$ ]] || fail 'Threshold must be a non-negative integer.'
[[ "$COST_CEILING" =~ ^([0-9]+)(\.[0-9]+)?$ ]] || fail 'Cost ceiling must be a positive USD amount.'
node -e 'if (!(Number(process.argv[1]) > 0) || !Number.isFinite(Number(process.argv[1]))) process.exit(1)' "$COST_CEILING" || fail 'Cost ceiling must be positive and finite.'
for value in "$REPORT_DIR" "$PATH_INPUT" "$PACKAGE_INPUT" "$TARGET_INPUT" "$SCOPE" "$DIFF_BASE"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail 'Inputs cannot contain line breaks.'
done
[[ "$DIFF_BASE" != -* ]] || fail 'diff-base must not start with a dash.'
case "$CHANGED_ONLY" in
  true|false) ;;
  '') if [[ -n "$DIFF_BASE" ]]; then CHANGED_ONLY=true; else CHANGED_ONLY=false; fi ;;
  *) fail 'Invalid changed-only; use true or false.' ;;
esac
[[ "$CHANGED_ONLY" == false || -n "$DIFF_BASE" ]] || fail 'changed-only requires diff-base.'
case "$STATIC_ONLY" in true|false) ;; *) fail 'Invalid static-only; use true or false.' ;; esac
[[ "$STATIC_ONLY" == false || "$MODE" != scan ]] || fail 'static-only is only supported by review and audit.'
[[ "$REPORT_DIR" != -* ]] || fail 'Report directory must not start with a dash.'
# Positional target values cannot be interpreted as CLI switches.
[[ "$PATH_INPUT" != -* && "$PACKAGE_INPUT" != -* ]] || fail 'Target must not start with a dash.'
command -v "$CLI" >/dev/null 2>&1 || fail '0 CLI executable was not found.'
mkdir -p -- "$REPORT_DIR"
JSON_REPORT="$REPORT_DIR/report.json"
SARIF_REPORT="$REPORT_DIR/report.sarif"
STDERR_LOG="$REPORT_DIR/0.stderr.log"
# Do not retain a previous invocation's SARIF after an unsuccessful invocation.
rm -f -- "$SARIF_REPORT"
# Use the compatibility spellings accepted by published releases and the new command tree.
# The action can update before npm latest ships the consolidated scan modules.
COMMON_ARGS=(--depth "$DEPTH" --format json --runtime "$RUNTIME" --timeout "$TIMEOUT" --cost-ceiling "$COST_CEILING")
case "$MODE" in
  review)
    [[ -e "$PATH_INPUT" ]] || fail 'Review path does not exist.'
    TARGET_LABEL="$PATH_INPUT"
    COMMAND=("$CLI" review "$PATH_INPUT" "${COMMON_ARGS[@]}")
    if [[ -n "$DIFF_BASE" ]]; then
      git -C "$PATH_INPUT" cat-file -e "${DIFF_BASE}^{commit}" 2>/dev/null ||
        fail "diff-base '$DIFF_BASE' is not a fetched commit. Use actions/checkout with fetch-depth: 0 (or fetch the base explicitly) before this action."
      # Same range the CLI reviews: merge-base of the base and HEAD, to HEAD.
      if git -C "$PATH_INPUT" diff --quiet "${DIFF_BASE}...HEAD" -- 2>/dev/null; then
        {
          echo 'skipped=true'
          echo 'total-findings=0'
          echo 'qualifying-findings=0'
          echo 'should-fail=false'
          echo 'execution-successful=true'
          echo 'gate-message=Skipped: no changes relative to diff-base.'
        } >> "$GITHUB_OUTPUT"
        if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
          echo "## 0 review skipped"$'\n\n'"No changes between \`$DIFF_BASE\` and HEAD; nothing to review." >> "$GITHUB_STEP_SUMMARY"
        fi
        echo "No diff relative to $DIFF_BASE; skipping review."
        exit 0
      fi
      COMMAND+=(--diff-base "$DIFF_BASE")
      if [[ "$CHANGED_ONLY" == true ]]; then COMMAND+=(--changed-only); fi
    fi
    ;;
  audit)
    [[ -n "$PACKAGE_INPUT" ]] || fail 'Package is required for audit.'
    [[ -z "$DIFF_BASE" && "$CHANGED_ONLY" == false ]] || fail 'diff-base and changed-only are only supported by review.'
    TARGET_LABEL="$PACKAGE_INPUT"
    COMMAND=("$CLI" audit "$PACKAGE_INPUT" "${COMMON_ARGS[@]}")
    ;;
  scan)
    [[ -n "$TARGET_INPUT" && -f "$SCOPE" ]] || fail 'Scan requires a target and an explicit scope file.'
    [[ -z "$DIFF_BASE" && "$CHANGED_ONLY" == false ]] || fail 'diff-base and changed-only are only supported by review.'
    TARGET_LABEL="$TARGET_INPUT"
    COMMAND=("$CLI" scan --target "$TARGET_INPUT" --scope "$SCOPE" --mode "$SCAN_MODE" "${COMMON_ARGS[@]}")
    ;;
esac
if [[ "$STATIC_ONLY" == true ]]; then COMMAND+=(--static-only); fi
set +e
"${COMMAND[@]}" >"$JSON_REPORT" 2>"$STDERR_LOG"
CLI_EXIT=$?
set -e
# Retain invocation/revision metadata even when execution fails. No credentials.
export ZERO_CI_MODE="$MODE" ZERO_CI_TARGET="$TARGET_LABEL" ZERO_CI_EXIT="$CLI_EXIT" ZERO_CI_RUNTIME="$RUNTIME" ZERO_CI_BUDGET="$COST_CEILING" ZERO_CI_DEPTH="$DEPTH" ZERO_CI_DIFF_BASE="$DIFF_BASE" ZERO_CI_CHANGED_ONLY="$CHANGED_ONLY" ZERO_CI_CLI="$CLI"
node --input-type=module - "$REPORT_DIR/run.json" <<'JS'
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const e = process.env;
const head = e.ZERO_CI_MODE === 'review' ? spawnSync('git', ['-C', e.ZERO_CI_TARGET, 'rev-parse', 'HEAD'], {encoding:'utf8'}) : null;
const reviewedRevision = head?.status === 0 ? head.stdout.trim() : null;
const version = spawnSync(e.ZERO_CI_CLI, ['--version'], {encoding:'utf8',timeout:10000});
const cliVersion = version.status === 0 ? version.stdout.trim().slice(0,256) : null;
fs.writeFileSync(process.argv[2], JSON.stringify({schemaVersion:1, repository:e.GITHUB_REPOSITORY || null, githubEventRevision:e.GITHUB_SHA || null, reviewedRevision, cliVersion, ref:e.GITHUB_REF || null, runId:e.GITHUB_RUN_ID || null, runAttempt:e.GITHUB_RUN_ATTEMPT || null, mode:e.ZERO_CI_MODE, target:e.ZERO_CI_TARGET, runtime:e.ZERO_CI_RUNTIME, depth:e.ZERO_CI_DEPTH, costCeilingUsd:Number(e.ZERO_CI_BUDGET), diffBase:e.ZERO_CI_DIFF_BASE || null, changedOnly:e.ZERO_CI_CHANGED_ONLY === 'true', cliExitCode:Number(e.ZERO_CI_EXIT)}, null, 2));
JS
if [[ ! -s "$JSON_REPORT" ]]; then
  echo "::error::0 did not produce a JSON report. Inspect the retained stderr artifact privately."
  if [[ "$CLI_EXIT" -ne 0 ]]; then exit "$CLI_EXIT"; fi
  exit 1
fi
set +e
ZERO_ACTION_CLI_EXIT="$CLI_EXIT" ZERO_ACTION_ENFORCE_GATE=1 node "${ACTION_ROOT}/scripts/render-github-action-output.mjs" \
  "$JSON_REPORT" "$SARIF_REPORT" "$PRIMARY_FORMAT" "$MODE" "$TARGET_LABEL" "$SEVERITY_THRESHOLD" "$COUNT_THRESHOLD"
RENDER_EXIT=$?
set -e
# A valid partial report never turns an execution failure into a passing gate.
if [[ "$CLI_EXIT" -ne 0 ]]; then
  echo "::error::0 execution failed with exit code $CLI_EXIT; any retained findings are partial."
  exit "$CLI_EXIT"
fi
exit "$RENDER_EXIT"
