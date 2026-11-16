#!/usr/bin/env node
// Black-box check of `0 --server-mode` over HTTP. Works against a container or a native process.
//   node scripts/smoke-server-mode.mjs --port 48123 --host-name localhost --token <access token>
// Exits non-zero on the first violated expectation. Prints no secret.
import { request } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string" }, "host-name": { type: "string", default: "localhost" }, token: { type: "string" }, "wait-seconds": { type: "string", default: "90" } } });
const port = Number(values.port);
const hostName = values["host-name"];
const token = values.token ?? process.env.ZERO_ACCESS_TOKEN;
if (!port || !token) { console.error("usage: --port <n> --token <access token> [--host-name <allowed host>]"); process.exit(2); }

function http(path, { method = "GET", headers = {}, body, host = `${hostName}:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host, ...headers } }, res => {
      const chunks = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.setTimeout(10_000, () => req.destroy(new Error("timeout"))); req.end(body);
  });
}
let failures = 0;
function expect(name, ok, detail = "") { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures++; }

// Wait for readiness (the image has a start period of up to 60 s).
const deadline = Date.now() + Number(values["wait-seconds"]) * 1000;
let ready;
for (;;) {
  try { ready = await http("/readyz"); if (ready.status === 200) break; } catch { /* not listening yet */ }
  if (Date.now() > deadline) { console.error("server did not become ready"); process.exit(1); }
  await new Promise(r => setTimeout(r, 1000));
}
const health = await http("/healthz");
expect("/healthz 200 {status:ok}", health.status === 200 && JSON.parse(health.text).status === "ok", health.text);
expect("/readyz 200 {status:ready}", ready.status === 200 && JSON.parse(ready.text).status === "ready", ready.text);
const probeAnyHost = await http("/healthz", { host: "10.9.8.7:1234" });
expect("/healthz answers any Host (orchestrator probes)", probeAnyHost.status === 200);

const anon = await http("/");
expect("anonymous GET / serves the sign-in page", anon.status === 200 && /Sign in/.test(anon.text), String(anon.status));
expect("anonymous GET / has no control token", !/0-control-token/.test(anon.text) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(anon.text));
const anonDeep = await http("/chats");
expect("anonymous GET /chats has no control token", !/0-control-token/.test(anonDeep.text));
expect("anonymous /api is 401", (await http("/api/console/sessions")).status === 401);
expect("anonymous /index.html is not served", (await http("/index.html")).status === 401);
expect("bad Host is 403", (await http("/", { host: "evil.example.com" })).status === 403);
expect("bad Host on /api is 403", (await http("/api/console/sessions", { host: "evil.example.com" })).status === 403);
expect("foreign Origin is 403", (await http("/_access/login", { method: "POST", headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status === 403);

const origin = `http://${hostName}:${port}`;
const wrong = await http("/_access/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: "x".repeat(40) }) });
expect("wrong access token is 401 without a cookie", wrong.status === 401 && !wrong.headers["set-cookie"]);

const login = await http("/_access/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
const cookie = String(login.headers["set-cookie"] ?? "");
expect("login with the access token succeeds", login.status === 200, String(login.status));
expect("session cookie is HttpOnly + SameSite=Strict", /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie));
const session = cookie.split(";")[0];
const authed = await http("/", { headers: { Cookie: session } });
const meta = /name="0-control-token" content="([^"]+)"/.exec(authed.text);
expect("signed-in GET / carries the control token", authed.status === 200 && Boolean(meta));
if (meta) {
  expect("mutating call without Origin is refused (CSRF)", (await http("/api/console/sessions", { method: "POST", headers: { Cookie: session, "x-0-control-token": meta[1], "Content-Type": "application/json" }, body: "{}" })).status === 403);
  expect("signed-in API call with the control token works", (await http("/api/console/sessions", { headers: { Cookie: session, "x-0-control-token": meta[1] } })).status === 200);
  expect("signed-in API call without the control token is refused", (await http("/api/console/sessions", { headers: { Cookie: session } })).status === 403);
}
process.exit(failures ? 1 : 0);
