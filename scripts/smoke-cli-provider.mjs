import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { delimiter, join, resolve } from "node:path";

const [tempArg, scenario, ...invocation] = process.argv.slice(2);
assert.ok(tempArg && invocation.length, "usage: smoke-cli-provider.mjs <temp-dir> <review|scan|review-auth-error|scan-auth-error|cline-review|cline-review-auth-error|cline-review-saved> <CLI argv...>");
assert.ok(["review", "scan", "review-auth-error", "scan-auth-error", "cline-review", "cline-review-auth-error", "cline-review-saved"].includes(scenario), "unknown smoke scenario");
const temp = resolve(tempArg);
const cline = scenario.startsWith("cline-");
const savedConnection = scenario === "cline-review-saved";
const review = scenario.includes("review");
const rejectAuth = scenario.endsWith("auth-error");
const key = cline ? "0-cli-smoke-local-cline-provider" : "0-cli-smoke-local-provider";
const model = cline ? "cline-pass/glm-5.3" : "claude-sonnet-4-6";
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
  // This gate tests the installed CLI and API agent, not npm availability.
  // Provision the static prepass just like the loopback model provider, so a
  // missing local scanner cannot download a package and consume the deadline.
  const bin = join(home, "bin");
  const scannerReceipt = join(home, "scanner.json");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "foxguard"), `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(${JSON.stringify(target)}));
assert.deepEqual(process.argv.slice(2), ["--format", "json", "."]);
const files = ${JSON.stringify(files)};
for (const file of files) assert.match(fs.readFileSync(file, "utf8"), /console\\.log/);
fs.writeFileSync(${JSON.stringify(scannerReceipt)}, JSON.stringify({ files, args: process.argv.slice(2) }));
console.log(JSON.stringify({ schema_version: "1.0.0", findings: [], target: { files_scanned: files.length } }));
`, { mode: 0o700 });
  const counters = { modelRequests: 0, sourceReceipts: 0, doneResponses: 0, authErrors: 0, targetRequests: 0, unexpectedRequests: 0 };
  let fixtureError;
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== (cline ? "/api/v1/chat/completions" : "/v1/messages") || request.method !== "POST") {
        if (request.url?.startsWith("/target")) counters.targetRequests++;
        else counters.unexpectedRequests++;
        throw new Error(`unexpected fixture traffic: ${request.method} ${request.url}`);
      }
      const body = await readJson(request);
      counters.modelRequests++;
      assert.ok(counters.modelRequests <= 2, "agent did not finish within two provider turns");
      if (cline) {
        assert.equal(request.headers.authorization, `Bearer ${key}`);
        assert.equal(request.headers["x-api-key"], undefined, "Cline used Anthropic auth");
        assert.equal(body.stream, false, "Cline must explicitly select non-streaming Chat");
      } else {
        assert.equal(request.headers["x-api-key"], key);
        assert.equal(request.headers["anthropic-version"], "2023-06-01");
      }
      assert.equal(body.model, model);
      assert.ok(Array.isArray(body.messages) && body.messages.length > 0, "missing provider messages");
      assert.notEqual(body.stream, true, "fixture expects the CLI's non-streaming wire");
      const names = (body.tools ?? []).map((tool) => cline ? tool.function?.name : tool.name);
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
          const receipts = cline
            ? body.messages.filter((message) => message.role === "tool" && message.tool_call_id?.startsWith("toolu_smoke_read_"))
            : body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
              .filter((block) => block.type === "tool_result" && block.tool_use_id?.startsWith("toolu_smoke_read_"));
          assert.equal(receipts.length, files.length, "review did not return all source reads");
          for (let index = 0; index < files.length; index++) {
            const receipt = receipts.find((block) => (cline ? block.tool_call_id : block.tool_use_id) === `toolu_smoke_read_${index}`);
            assert.ok(receipt && !receipt.is_error, "review source read failed");
            assert.match(JSON.stringify(receipt.content), /console\.log/, "source read did not return fixture code");
          }
          counters.sourceReceipts = receipts.length;
        }
        counters.doneResponses++;
        content = [{ type: "tool_use", id: `toolu_smoke_done_${counters.modelRequests}`, name: "done", input: { summary: "Local bootstrap fixture completed; no findings and no target requests." } }];
      }
      if (cline) {
        sendJson(response, 200, { success: true, data: {
          id: `chatcmpl_0_cli_smoke_${counters.modelRequests}`, object: "chat.completion", model,
          choices: [{ index: 0, finish_reason: "tool_calls", message: {
            role: "assistant", content: null,
            tool_calls: content.map((tool) => ({ id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } })),
          } }], usage: { prompt_tokens: 32, completion_tokens: 16, prompt_tokens_details: { cached_tokens: 8 } },
        } });
        return;
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
    if (savedConnection) {
      // Match homeStateDir(home) and the public CLI's account/config files;
      // only this throwaway HOME receives the synthetic loopback credentials.
      const state = join(home, ".0");
      await mkdir(state, { recursive: true, mode: 0o700 });
      await writeFile(join(state, "credentials.json"), JSON.stringify({ version: 2, providers: {
        cline: { activeAccountId: "smoke", accounts: { smoke: { kind: "api_key", secret: key } } },
      } }), { mode: 0o600 });
      await writeFile(join(state, "web-connections.json"), JSON.stringify({ cline: { baseUrl: `${origin}/api/v1` } }), { mode: 0o600 });
    }
    const scope = join(home, "scope.json");
    await writeFile(scope, JSON.stringify({ in_scope: ["127.0.0.1"] }), { mode: 0o600 });
    const args = review
      ? ["review", target, "--depth", "quick"]
      : ["scan", "--target", `${origin}/target`, "--mode", "web", "--depth", "quick", "--scope", scope];
    args.push("--runtime", "api", "--timeout", "10000", "--format", "json", "--db-path", join(home, "smoke.db"));
    // Deliberately do not spread process.env: keys, OAuth tokens, provider pins,
    // fallbacks, proxies, NODE_OPTIONS and configuration overrides must not leak.
    const env = {
      PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
      TMPDIR: home, CI: "1", NO_COLOR: "1", TERM: "dumb",
      ZERO_NO_TELEMETRY: "1", DO_NOT_TRACK: "1",
      ...(cline ? savedConnection ? {} : { CLINE_API_KEY: key, CLINE_BASE_URL: `${origin}/api/v1` } : { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: origin }),
      ZERO_FORCE_PROVIDER: cline ? "cline" : "anthropic", ZERO_SELECTED_PROVIDER: cline ? "cline" : "anthropic", ZERO_MODEL: model,
      ZERO_CHATGPT_AUTH_FILE: join(home, "no-auth.json"), ZERO_CODEX_AUTH_JSON_PATH: join(home, "no-auth.json"),
      CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"),
      // Existing offline switches prevent deterministic recon outside the agent.
      // The model only asks for source reads and done, never any network tool.
      ZERO_FEATURE_WEB_RECON: "0", ZERO_FEATURE_WP_FINGERPRINT: "0",
    };
    if (savedConnection) {
      assert.equal(env.CLINE_API_KEY, undefined, "saved connection fixture must not export a key");
      assert.equal(env.CLINE_BASE_URL, undefined, "saved connection fixture must not export an endpoint");
    }
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
    if (review) {
      const receipt = JSON.parse(await readFile(scannerReceipt, "utf8"));
      assert.deepEqual(receipt.files, files, "static prepass did not inspect the fixture sources");
      assert.deepEqual(receipt.args, ["--format", "json", "."]);
    }
    assert.equal(interruption, undefined, interruption);
    assert.equal(signal, null, `CLI terminated by ${signal}`);
    assert.equal(fixtureError, undefined, String(fixtureError));
    assert.equal(stdout.includes(key) || stderr.includes(key), false, "fixture credential appeared in CLI output");
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
      if (!review) {
        assert.equal(report.exitReason, "failed");
        assert.ok(typeof report.error === "string" && report.error.length > 0);
        assert.ok(report.summary.totalAttacks > 0, "failed scan lost initialized attack evidence");
        assert.ok(report.benchmarkMeta.attackTurns > 0, "failed scan lost initialized turn evidence");
      }
    } else {
      assert.equal(counters.modelRequests, 2, "bootstrap bypassed a real provider turn");
      assert.equal(counters.sourceReceipts, review ? 3 : 0);
      if (cline) {
        assert.equal(report.usage?.inputTokens, 64, "Cline envelope input usage was lost across provider turns");
        assert.equal(report.usage?.outputTokens, 32, "Cline envelope output usage was lost across provider turns");
        assert.equal(report.usage?.cachedInputTokens, 16, "Cline cached token usage was lost across provider turns");
      }
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
