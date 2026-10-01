#!/usr/bin/env bash
set -eu
receipt="${RUNNER_TEMP:-/tmp}/zero-provider-diag"
mkdir -p "$receipt"
node --version > "$receipt/runtime.txt"
git rev-parse HEAD >> "$receipt/runtime.txt"
uname -a >> "$receipt/runtime.txt"
cat > "$receipt/preload.mjs" <<'JS'
import { readdirSync, readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const started = performance.now();
function log(event, data = {}) {
  console.error("ZERO_DIAG " + JSON.stringify({ ms: Math.round(performance.now() - started), event, ...data }));
}
function errorInfo(error) {
  return { name: error?.name ?? typeof error, message: String(error?.message ?? error ?? "").slice(0, 240) };
}
function address(input) {
  try { const url = new URL(typeof input === "string" ? input : input.url); return url.origin + url.pathname; }
  catch { return "<non-url>"; }
}
log("preload", { node: process.version, platform: process.platform });
for (const method of ['execSync','execFileSync','spawnSync']) {
  const original = childProcess[method];
  childProcess[method] = function (...args) {
    const at = performance.now();
    log('child.start', {method, command:String(args[0]).slice(0,120),caller:new Error().stack?.split('\n').slice(2,7)});
    try { return Reflect.apply(original,this,args); }
    finally { log('child.end',{method,msTaken:Math.round(performance.now()-at)}); }
  };
}
syncBuiltinESMExports();
const originalWrite = process.stderr.write;
process.stderr.write = function(chunk,...args) {
  const value = String(chunk);
  if (value.startsWith('[0]') || value.startsWith('[0:hb]')) originalWrite.call(this,'ZERO_DIAG '+JSON.stringify({event:'engine.log',ms:Math.round(performance.now()-started),line:value.trim()})+'\n');
  return originalWrite.call(this,chunk,...args);
};
const originalAbort = AbortController.prototype.abort;
AbortController.prototype.abort = function (...args) {
  log("abort", { alreadyAborted: this.signal.aborted, reason: errorInfo(args[0]), caller: new Error().stack?.split("\n").slice(2, 8) });
  return Reflect.apply(originalAbort, this, args);
};
const originalFetch = globalThis.fetch;
let sequence = 0;
globalThis.fetch = async function (input, init) {
  const id = ++sequence;
  const signal = init?.signal ?? input?.signal;
  log("fetch.start", { id, url: address(input), method: init?.method ?? input?.method ?? "GET", aborted: signal?.aborted ?? false });
  const onAbort = () => log("fetch.abort", { id, reason: errorInfo(signal.reason) });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Reflect.apply(originalFetch, this, [input, init]);
    log("fetch.end", { id, status: result.status });
    return result;
  } catch (error) { log("fetch.error", { id, ...errorInfo(error) }); throw error; }
  finally { signal?.removeEventListener("abort", onAbort); }
};
export async function installNative() {
  const chunks = join(dirname(process.argv[1]), "chunks");
  const matches = readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name))
    .filter(file => /var LlmApiRuntime = class/.test(readFileSync(file, "utf8")));
  if (matches.length !== 1) throw new Error(`Expected one LlmApiRuntime chunk; found ${matches.length}`);
  log("runtime.import.start");
  const { LlmApiRuntime } = await import(pathToFileURL(matches[0]).href);
  if (typeof LlmApiRuntime?.prototype.executeNative !== "function") throw new Error("Bundled LlmApiRuntime.executeNative export missing");
  const original = LlmApiRuntime.prototype.executeNative;
  LlmApiRuntime.prototype.executeNative = async function (...args) {
    log("native.start", { model: this.resolvedModel(), provider: this.resolvedProvider(), messages: args[1]?.length, tools: args[2]?.length, aborted: args[4]?.aborted ?? false });
    try {
      const result = await Reflect.apply(original, this, args);
      log("native.end", { stopReason: result.stopReason, error: result.error ? errorInfo(result.error) : undefined });
      return result;
    } catch (error) { log("native.error", errorInfo(error)); throw error; }
  };
  log("runtime.import.end");
}
JS
cat > "$receipt/native.mjs" <<'JS'
import { installNative } from "./preload.mjs";
await installNative();
JS
failed=0
for arm in baseline globals native; do
  caseDir="$receipt/$arm"
  mkdir -p "$caseDir/tinyrepo"
  for file in index helper value; do
    printf "console.log('fixture');\n" > "$caseDir/tinyrepo/$file.js"
  done
  args=(node --cpu-prof --cpu-prof-dir "$receipt" --cpu-prof-name "$arm.cpuprofile")
  if [ "$arm" = globals ]; then args+=(--import "$receipt/preload.mjs");
  elif [ "$arm" = native ]; then args+=(--import "$receipt/native.mjs"); fi
  args+=("$PWD/dist/0.js")
  if node scripts/smoke-cli-provider.mjs "$caseDir" review "${args[@]}" > "$receipt/$arm.log" 2>&1; then
    printf '%s PASS\n' "$arm" >> "$receipt/results.txt"
  else
    status=$?
    printf '%s FAIL exit=%s\n' "$arm" "$status" >> "$receipt/results.txt"
    failed=1
  fi
  cat "$receipt/$arm.log"
done
cat "$receipt/results.txt"
exit "$failed"
