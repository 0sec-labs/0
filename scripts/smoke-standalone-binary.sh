#!/usr/bin/env bash
#
# smoke-standalone-binary.sh <binary> — the post-compile smoke of a standalone
# `0` executable. Single source for .github/workflows/release.yml (every native
# runner) and `scripts/ci-local.sh --only standalone-smoke` (one platform, in
# minutes, long before a tag exists).
set -euo pipefail
BIN="$(cd "$(dirname "${1:?usage: smoke-standalone-binary.sh <binary>}")" && pwd)/$(basename "$1")"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Move the build tree's node_modules away before launch. A compiled executable
# must not depend on a native addon that happens to exist in the checkout used
# to produce it.
smoke_dir="$(mktemp -d)"
dashboard_pid=""
restore() {
  [ -n "$dashboard_pid" ] && { kill "$dashboard_pid" >/dev/null 2>&1 || true; wait "$dashboard_pid" >/dev/null 2>&1 || true; }
  [ -d "$ROOT/node_modules.release-build" ] && mv "$ROOT/node_modules.release-build" "$ROOT/node_modules"
  rm -rf "$smoke_dir"
}
mv node_modules node_modules.release-build
trap restore EXIT
cp "$BIN" "$smoke_dir/0"
# A release binary can be launched from inside any source checkout. Its
# embedded UI must win over an unrelated stale workspace build.
mkdir -p "$smoke_dir/packages/web/dist"
printf '<html><body>stale checkout dashboard</body></html>' > "$smoke_dir/packages/web/dist/index.html"
(
  cd "$smoke_dir"
  ./0 --version
  ./0 --help | grep -q "Security agents for your repositories"
  # Run the dashboard from the same empty directory. This must use the
  # manifest embedded by bun-compile, not workspace assets.
  ./0 --db-path dashboard.db --port 48123 --no-open --ready-json > dashboard.log 2>&1 &
  echo $! > dashboard.pid
)
dashboard_pid="$(cat "$smoke_dir/dashboard.pid")"
(
  cd "$smoke_dir"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync("dashboard.log", "utf8").includes("ZERO_DASHBOARD_READY")) process.exit(0);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Dashboard did not become ready:\n${readFileSync("dashboard.log", "utf8")}`);
  '
  node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:48123/findings");
    const html = await response.text();
    if (!response.ok || !html.includes("/assets/")) {
      throw new Error(`Embedded dashboard did not serve its HTML (${response.status}).`);
    }
  '
)
kill "$dashboard_pid" >/dev/null 2>&1 || true; wait "$dashboard_pid" >/dev/null 2>&1 || true; dashboard_pid=""
# node_modules must be back before the remaining smokes (they run repo scripts).
mv node_modules.release-build node_modules
trap 'rm -rf "$smoke_dir"' EXIT

bun scripts/check-host-console-worker-bun.ts "$BIN"
node scripts/smoke-plugin-runtime.mjs "$BIN"
node scripts/smoke-web-setup.mjs "$BIN"
echo "standalone smoke passed: $BIN"
