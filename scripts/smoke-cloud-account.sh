#!/usr/bin/env bash
# Exercise the authenticated Cloud-facing CLI surface without starting work.
#
# Usage:
#   bash scripts/smoke-cloud-account.sh [CLI command] [repository URL]
#
# The default CLI command targets the source-built CLI. `connect` is always
# invoked in readiness-only mode; it must not create a scan or schedule.
set -euo pipefail

CLI="${1:-node packages/cli/dist/index.js}"
REPO="${2:-}"
if [ -z "$REPO" ]; then REPO="$(printenv ZERO_SMOKE_REPO 2>/dev/null || true)"; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\033[36m[cloud-smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[cloud-smoke] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

if ! printenv ZERO_CLOUD_TOKEN >/dev/null 2>&1 && ! printenv ZERO_CLOUD_HOST >/dev/null 2>&1 \
  && [ ! -f "${HOME}/.0/cloud.env" ]; then
  fail "no Cloud credentials found; run 0 auth login first"
fi

say "auth status"
$CLI auth status >"$TMP/auth.out" 2>&1 || fail "auth status failed:\n$(<"$TMP/auth.out")"
case "$(<"$TMP/auth.out")" in
  "OK (host="*) ;;
  *) fail "auth status did not confirm the host" ;;
esac

say "models"
$CLI models >"$TMP/models.out" 2>&1 || fail "models failed:\n$(<"$TMP/models.out")"
case "$(<"$TMP/models.out")" in
  *"0cloud models:"*) ;;
  *) fail "models did not return the Cloud model catalog" ;;
esac

say "balance"
$CLI balance >"$TMP/balance.out" 2>&1 || fail "balance failed:\n$(cat "$TMP/balance.out")"

if [ -n "$REPO" ]; then
  say "connect readiness (no scan or schedule)"
  set +e
  $CLI connect "$REPO" --format json --setup-only >"$TMP/connect.json" 2>"$TMP/connect.err"
  status=$?
  set -e
  node --input-type=module - "$TMP/connect.json" "$status" <<'NODE'
import { readFileSync } from "node:fs";
const [file, statusText] = process.argv.slice(2);
const status = Number(statusText);
const raw = readFileSync(file, "utf8").trim();
const result = JSON.parse(raw);
const allowed = new Set(["ready", "no-open", "action-required"]);
if (!allowed.has(result.state)) throw new Error(`unexpected connect state: ${result.state}`);
if (result.scan_id || result.schedule) throw new Error("readiness-only connect created work");
if (result.state === "action-required" && status === 0) throw new Error("action-required connect exited successfully");
if (result.state !== "action-required" && status !== 0) throw new Error(`connect exited ${status} for ${result.state}`);
console.log(JSON.stringify({ state: result.state, reason: result.reason ?? null }));
NODE
fi

say "authenticated Cloud CLI smoke passed"
