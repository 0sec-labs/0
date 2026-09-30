import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const [tempArg, scenario, ...invocation] = process.argv.slice(2);
assert.ok(tempArg && invocation.length, "usage: smoke-cli-provider.mjs <temp-dir> <review|scan|review-auth-error|scan-auth-error> <CLI argv...>");
assert.ok(["review", "scan", "review-auth-error", "scan-auth-error"].includes(scenario), "unknown smoke scenario");
const temp = resolve(tempArg);
const review = scenario.startsWith("review");
const rejectAuth = scenario.endsWith("auth-error");
const key = "0-cli-smoke-local-provider";
const model = "claude-sonnet-4-6";
const files = ["index.js", "helper.js", "value.js"];
// Resolve local entrypoints before changing cwd, so project config and plugins
// cannot come from the operator's checkout. Bare runtime names still use PATH.
const [command, ...prefix] = invocation.map((arg) => existsSync(arg) ? resolve(arg) : arg);

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= 1024 * 1024, "fixture request exceeds 1 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify(body));
}

async function main() {
  const home = join(temp, scenario);
  await mkdir(home, { recursive: true });
  const target = join(temp, "tinyrepo");
  const counters = { modelRequests: 0, sourceReceipts: 0, doneResponses: 0, authErrors: 0, targetRequests: 0, unexpectedRequests: 0 };
  let fixtureError;
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/v1/messages" || request.method !== "POST") {
        if (request.url?.startsWith("/target")) counters.targetRequests++;
        else counters.unexpectedRequests++;
        throw new Error(`unexpected fixture traffic: ${request.method} ${request.url}`);
      }
      const body = await readJson(request);
      counters.modelRequests++;
      assert.ok(counters.modelRequests <= 2, "agent did not finish within two provider turns");
      assert.equal(request.headers["x-api-key"], key);
      assert.equal(request.headers["anthropic-version"], "2023-06-01");
      assert.equal(body.model, model);
      assert.ok(Array.isArray(body.messages) && body.messages.length > 0, "missing Anthropic messages");
      assert.notEqual(body.stream, true, "Anthropic fixture expects the CLI's non-streaming Messages wire");
      const names = (body.tools ?? []).map((tool) => tool.name);
      assert.ok(names.includes("done"), "agent completion tool was not advertised");
      if (!review) {
        // Discovery advertises HTTP tools; shell-first attack must also run.
        assert.equal(names.includes("http_request"), counters.modelRequests === 1, "scan did not run discovery then attack");
      }
      if (rejectAuth) {
        counters.authErrors++;
        sendJson(response, 401, { type: "error", error: { type: "authentication_error", message: "0-cli-smoke deterministic credential rejection" }, request_id: "req_0_cli_smoke_auth" });
        return;
      }
      let content;
      if (review && counters.modelRequests === 1) {
        assert.ok(names.includes("read_file"), "review source reader was not advertised");
        content = files.map((file, index) => ({ type: "tool_use", id: `toolu_smoke_read_${index}`, name: "read_file", input: { path: join(target, file) } }));
      } else {
        if (review) {
          const receipts = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
            .filter((block) => block.type === "tool_result" && block.tool_use_id?.startsWith("toolu_smoke_read_"));
          assert.equal(receipts.length, files.length, "review did not return all source reads");
          for (let index = 0; index < files.length; index++) {
            const receipt = receipts.find((block) => block.tool_use_id === `toolu_smoke_read_${index}`);
            assert.ok(receipt && !receipt.is_error, "review source read failed");
            assert.match(JSON.stringify(receipt.content), /console\.log/, "source read did not return fixture code");
          }
          counters.sourceReceipts = receipts.length;
        }
        counters.doneResponses++;
        content = [{ type: "tool_use", id: `toolu_smoke_done_${counters.modelRequests}`, name: "done", input: { summary: "Local bootstrap fixture completed; no findings and no target requests." } }];
      }
      sendJson(response, 200, {
        id: `msg_0_cli_smoke_${counters.modelRequests}`, type: "message", role: "assistant", model,
        content, stop_reason: "tool_use", stop_sequence: null,
        usage: { input_tokens: 32, output_tokens: 16 },
      });
    } catch (error) {
      fixtureError ??= error;
      sendJson(response, 400, { type: "error", error: { type: "invalid_request_error", message: String(error) } });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    // Port 0 avoids collisions; listen's callback establishes actual readiness.
    const ready = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await ready;
    const address = server.address();
    assert.ok(address && typeof address !== "string", "fixture did not bind a TCP port");
    const origin = `http://127.0.0.1:${address.port}`;
    const scope = join(home, "scope.json");
    await writeFile(scope, JSON.stringify({ in_scope: ["127.0.0.1"] }), { mode: 0o600 });
    const args = review
      ? ["review", target, "--depth", "quick"]
      : ["scan", "--target", `${origin}/target`, "--mode", "web", "--depth", "quick", "--scope", scope];
    args.push("--runtime", "api", "--timeout", "10000", "--format", "json", "--db-path", join(home, "smoke.db"));
    // Deliberately do not spread process.env: keys, OAuth tokens, provider pins,
    // fallbacks, proxies, NODE_OPTIONS and configuration overrides must not leak.
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
      TMPDIR: home, CI: "1", NO_COLOR: "1", TERM: "dumb",
      ZERO_NO_TELEMETRY: "1", DO_NOT_TRACK: "1",
      ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: origin,
      ZERO_FORCE_PROVIDER: "anthropic", ZERO_SELECTED_PROVIDER: "anthropic", ZERO_MODEL: model,
      ZERO_CHATGPT_AUTH_FILE: join(home, "no-auth.json"), ZERO_CODEX_AUTH_JSON_PATH: join(home, "no-auth.json"),
      CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"),
      // Existing offline switches prevent deterministic recon outside the agent.
      // The model only asks for source reads and done, never any network tool.
      ZERO_FEATURE_WEB_RECON: "0", ZERO_FEATURE_WP_FINGERPRINT: "0",
    };
    const child = spawn(command, [...prefix, ...args], { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let interruption;
    const kill = (reason) => {
      interruption ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    };
    const onSignal = () => kill("fixture interrupted");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const timer = setTimeout(() => kill("CLI exceeded 60s wall-clock limit"), 60_000);
    child.stdout.on("data", (chunk) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk; else kill("CLI stdout exceeded 4 MiB"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 4 * 1024 * 1024) stderr += chunk; else kill("CLI stderr exceeded 4 MiB"); });
    let code;
    let signal;
    try {
      [code, signal] = await once(child, "close");
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      // CLI-native detection can spawn descendants; none may outlive this run.
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      process.stderr.write(`[smoke] ${scenario} transport: ${JSON.stringify(counters)}\n`);
    }
    assert.equal(interruption, undefined, interruption);
    assert.equal(signal, null, `CLI terminated by ${signal}`);
    assert.equal(fixtureError, undefined, String(fixtureError));
    assert.equal(counters.targetRequests, 0, "CLI contacted its target during bootstrap smoke");
    assert.equal(counters.unexpectedRequests, 0, "CLI used an unexpected provider route");
    assert.equal(code, rejectAuth ? 2 : 0, `${scenario} CLI exit ${code}; expected ${rejectAuth ? 2 : 0}`);
    // JSON reports are pretty-printed; scan's optional cost summary follows the
    // root closing brace on stdout. Parse the document, not arbitrary log text.
    const reportEnd = stdout.lastIndexOf("\n}");
    assert.ok(stdout.trimStart().startsWith("{") && reportEnd >= 0, "CLI did not emit a JSON report");
    const report = JSON.parse(stdout.slice(0, reportEnd + 2));
    assert.ok(typeof report.target === "string" && Array.isArray(report.findings), "missing report target/findings");
    assert.equal(report.target, review ? target : `${origin}/target`, "report target mismatch");
    if (rejectAuth) {
      assert.ok(counters.authErrors > 0, "CLI did not reach the rejecting local provider");
      assert.match(stdout + stderr, /authentication_error/, "CLI did not surface the actual provider rejection");
      assert.equal(review ? report.researchFailed : report.executionSuccessful === false, true, "auth rejection was reported as a clean verdict");
    } else {
      assert.equal(counters.modelRequests, 2, "bootstrap bypassed a real provider turn");
      assert.equal(counters.sourceReceipts, review ? 3 : 0);
      assert.equal(counters.doneResponses, review ? 1 : 2);
      assert.equal(report.findings.length, 0, "bootstrap fixture unexpectedly generated findings");
      assert.notEqual(report.executionSuccessful, false, "scan reported execution failure");
      assert.notEqual(report.researchFailed, true, "review reported partial AI failure");
    }
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke] provider fixture failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
