#!/usr/bin/env bash
#
# smoke-cli.sh — runtime-agnostic install-smoke for @0/cli.
#
# Used by .github/workflows/ci.yml to guard against regressions in the
# subcommands that are most likely to silently break: the DB layer (history),
# the MCP stdio server, and the source-review pipeline.
#
# Call this with a single argument: the full command string that invokes
# @0/cli. Examples:
#   scripts/smoke-cli.sh "node /tmp/smoke/node_modules/@0/cli/0.js"
#   scripts/smoke-cli.sh "bun run /tmp/smoke/node_modules/@0/cli/0.js"
#
# The script exits non-zero on the first failing subtest and prints which
# subcommand tripped.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 '<command to invoke @0/cli>'" >&2
  exit 2
fi

CLI="$1"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bare-home"
# No ambient API keys, OAuth stores, provider overrides, proxies or runtime
# injection flags may influence any smoke subcommand.
CLI_ENV=(env -i
  PATH="${PATH:-/usr/bin:/bin}"
  HOME="$TMP/bare-home" USERPROFILE="$TMP/bare-home"
  XDG_CONFIG_HOME="$TMP/bare-home/config"
  XDG_DATA_HOME="$TMP/bare-home/data"
  XDG_CACHE_HOME="$TMP/bare-home/cache"
  CODEX_HOME="$TMP/bare-home/codex"
  CLAUDE_CONFIG_DIR="$TMP/bare-home/claude"
  ZERO_CODEX_AUTH_JSON_PATH="$TMP/bare-home/no-auth.json"
  ZERO_NO_TELEMETRY=1 DO_NOT_TRACK=1 CI=1 NO_COLOR=1 TERM=dumb)

# Pick a portable "run with timeout" helper. GH Actions ubuntu runners have
# coreutils `timeout`; macOS devs running this locally usually don't (unless
# they brew installed it as `gtimeout`). Fall back to perl's SIGALRM which
# is present on every POSIX system we target.
if command -v timeout >/dev/null 2>&1; then
  timeout_cmd() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_cmd() { gtimeout "$@"; }
else
  timeout_cmd() {
    local secs="$1"; shift
    perl -e 'my $s=shift;$SIG{ALRM}=sub{kill "TERM",-$$;exit 124};alarm $s;exec @ARGV' "$secs" "$@"
  }
fi

say() { printf '\033[36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[smoke] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }
run_cli() { "${CLI_ENV[@]}" $CLI "$@"; }
run_ai_smoke() {
  # The fixture owns an ephemeral loopback port, child deadline and teardown.
  # CLI argv still uses the script's documented command-string splitting.
  "${CLI_ENV[@]}" node "$SCRIPT_DIR/smoke-cli-provider.mjs" "$TMP" "$1" $CLI
}


# ── 1. --help ──────────────────────────────────────────────────────────────
# Proves the binary loads, commander is wired, and all subcommands registered.
say "--help"
run_cli --help > "$TMP/help.out" 2>&1 || fail "--help exited non-zero"
grep -q "Security agents for your repositories" "$TMP/help.out" || fail "--help did not contain tagline"
grep -q "threads" "$TMP/help.out" || fail "--help did not list threads subcommand"
grep -q "findings" "$TMP/help.out" || fail "--help did not list findings subcommand"
grep -q "config" "$TMP/help.out" || fail "--help did not list config subcommand"
run_cli config --help 2>&1 | grep -q "doctor" || fail "config --help did not list doctor subcommand"
# mcp-server lives under the hidden `lab` group; the old top-level name still works (silently when piped).
run_cli lab --help 2>&1 | grep -q "mcp-server" || fail "lab --help did not list mcp-server subcommand"
run_cli mcp-server --help >/dev/null 2>&1 || fail "legacy mcp-server --help exited non-zero"

# ── 2. doctor ──────────────────────────────────────────────────────────────
# Proves runtime detection boots and doesn't crash on a bare environment.
say "config doctor"
run_cli config doctor > "$TMP/doctor.out" 2>&1 || fail "config doctor exited non-zero"
grep -q "Node.js" "$TMP/doctor.out" || fail "doctor did not produce the expected banner"

# ── 3. findings (DB smoke) ──────────────────────────────────────────────────
# Proves the entire SQLite stack boots end-to-end: osecDB ctor, WAL
# auto-migration, schema tables + indexes, drizzle session wiring, and
# findings list query. This is the regression guard for the 0.7.0 → 0.7.1
# native-bindings → WASM swap and the 0.7.4 WAL header migration.
say "findings (DB init)"
run_cli findings list --db-path "$TMP/smoke.db" > "$TMP/history.out" 2>&1 || true
if grep -qiE "wasm|CompileError|database is locked|SQLITE" "$TMP/history.out"; then
  # Surface the REAL underlying error instead of swallowing it (#610). The DB
  # layer is the most opaque failure mode: a corrupt node-sqlite3-wasm.wasm
  # (e.g. from a poisoned runner cache) throws a WebAssembly CompileError here,
  # and we want that exception in the log — not just "DB layer broken".
  echo "--- history stdout+stderr ---" >&2
  cat "$TMP/history.out" >&2 || true
  fail "findings list exited non-zero (DB layer broken)"
fi
# An empty history run is fine; we're testing that it *runs*, not that it
# finds anything.

# ── 4. mcp-server stdio handshake ──────────────────────────────────────────
# Proves the MCP stdio transport boots and responds to an initialize request
# with a valid JSON-RPC 2.0 reply. Bounded by `timeout` in case the server
# hangs (we don't want this to stall CI forever).
say "mcp-server initialize"
INIT_MSG='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"0-ci-smoke","version":"0.0.0"}}}'
# The mcp-server boots the full CLI + stdio transport + DB before it can
# answer `initialize`; under CI load that can exceed a fixed 10s window, which
# made this subtest the #1 flake source (and, because the image publish gates
# on CI=success, it randomly blocked publishes). Retry the handshake up to 3
# times with a generous per-attempt window before declaring it broken.
MCP_SMOKE_TIMEOUT_SECONDS="30"
: > "$TMP/mcp.out"
for attempt in 1 2 3; do
  # A timed-out server can still be unwinding its SQLite/WAL handles when the
  # next retry begins. Give every attempt isolated state so a slow teardown
  # cannot turn the next healthy boot into a spurious "database is locked".
  printf '%s\n' "$INIT_MSG" \
    | timeout_cmd "$MCP_SMOKE_TIMEOUT_SECONDS" "${CLI_ENV[@]}" $CLI lab mcp-server \
        --target https://example.invalid \
        --scan-id "ci-smoke-$attempt" \
        --db-path "$TMP/mcp-$attempt.db" 2> "$TMP/mcp.err" \
    | head -1 > "$TMP/mcp.out" || true
  [ -s "$TMP/mcp.out" ] && break
  [ "$attempt" -lt 3 ] && say "mcp-server initialize attempt $attempt produced no response; retrying"
done
# Accept exit 0 (clean), 141 (SIGPIPE from head), or 143 (SIGTERM from timeout
# after response sent). Non-accepted: the command producing no output at all.
if ! [ -s "$TMP/mcp.out" ]; then
  echo "--- mcp-server stderr ---" >&2
  cat "$TMP/mcp.err" >&2 || true
  fail "mcp-server produced no response to initialize (3 attempts)"
fi
grep -q '"jsonrpc":"2.0"' "$TMP/mcp.out" || fail "mcp-server response not JSON-RPC 2.0"
grep -q '"result"' "$TMP/mcp.out" || fail "mcp-server initialize returned no result"

say "all 4 subcommand smoke tests passed"
