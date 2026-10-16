#!/usr/bin/env node
// Tail local GemmaForge NDJSON and expose it as SSE for the dashboard.
// Usage: node scripts/serve-events.mjs <events.ndjson> [--port 8765]
// CORS is permissive because this service runs locally.

import { createReadStream, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help") {
  console.error("usage: serve-events.mjs <events.ndjson> [--port 8765]");
  process.exit(1);
}

const portIdx = argv.indexOf("--port");
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 8765;
const positional = argv.filter((arg, idx) => !arg.startsWith("--") && argv[idx - 1] !== "--port");
const gemmaFile = positional[0] ? resolve(positional[0]) : null;
if (!gemmaFile) {
  console.error("error: provide an events file");
  process.exit(1);
}

/** @type {Map<string, Set<import("node:http").ServerResponse>>} */
const channels = new Map();
channels.set("events", new Set());

function broadcast(channel, line) {
  const clients = channels.get(channel);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${line}\n\n`;
  for (const res of clients) res.write(payload);
}

/**
 * Tail an ND-JSON file. Each non-empty line is passed to `onLine`.
 * Internally keeps a byte offset + carry-over buffer so partial trailing
 * lines aren't dropped or duplicated on the next file-change tick.
 */
function tail(file, onLine) {
  let offset;
  let pending = "";
  try { offset = statSync(file).size; } catch { offset = 0; }

  function pump() {
    let size;
    try { size = statSync(file).size; } catch { return; }
    if (size <= offset) {
      // File truncated (rotation) — restart from the new size.
      offset = Math.min(offset, size);
      return;
    }
    const stream = createReadStream(file, { start: offset, end: size - 1, encoding: "utf8" });
    stream.on("data", (chunk) => { pending += chunk; });
    stream.on("end", () => {
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
      offset = size;
    });
  }

  try {
    watch(file, { persistent: true }, () => pump());
  } catch (err) {
    console.error(`serve-events: cannot watch ${file}: ${err?.message ?? err}`);
  }
}


tail(gemmaFile, (line) => broadcast("events", line));

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (!url.startsWith("/events")) {
    res.writeHead(404).end();
    return;
  }
  const channel = "events";
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`: connected to ${gemmaFile}\n\n`);
  channels.get(channel).add(res);
  req.on("close", () => channels.get(channel).delete(res));
});

server.listen(port, () => {
  console.error(`serve-events: tailing ${gemmaFile} → http://localhost:${port}/events`);
});
