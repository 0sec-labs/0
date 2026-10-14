#!/usr/bin/env node
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// No target arguments: all network sockets bind or connect to 127.0.0.1 only.
const home = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'zero-owned-https-replay-'));
const servers = [];
const traces = [];
const ticket = randomUUID();
const body = JSON.stringify({ ticket, operation: 'increment-owned-counter' });
const config = `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`;
let accepted = 0;

async function start(node, mode, used) {
  const server = https.createServer({
    key: readFileSync(join(scratch, 'key.pem')),
    cert: readFileSync(join(scratch, 'cert.pem')),
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
  }, (req, res) => {
    if (req.method !== 'POST' || req.url !== '/consume') {
      res.writeHead(404).end(); return;
    }
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024) req.destroy();
    });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(data); } catch { res.writeHead(400).end(); return; }
      if (input.ticket !== ticket || input.operation !== 'increment-owned-counter') {
        res.writeHead(403).end(); return;
      }
      // No await between check and consume. The shared Set is atomic within
      // this single-process fixture, NOT a production distributed datastore.
      const replay = used.has(input.ticket);
      if (!replay) { used.add(input.ticket); accepted++; }
      const event = {
        mode, node, event: replay ? 'rejected-replay' : 'accepted',
        protocol: req.socket.getProtocol(), request: 'owned-ticket-1',
        status: replay ? 409 : 200,
      };
      traces.push(event);
      res.writeHead(event.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(event));
    });
  });
  server.requestTimeout = 5000;
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function send(port) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port, path: '/consume', method: 'POST',
      ca: readFileSync(join(scratch, 'cert.pem')), rejectUnauthorized: true,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('localhost request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

try {
  writeFileSync(join(scratch, 'cert.cnf'), config, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', '1', '-config', join(scratch, 'cert.cnf'),
    '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')],
    { stdio: 'ignore', timeout: 15000 });
  const localA = await start('a', 'local-caches', new Set());
  const localB = await start('b', 'local-caches', new Set());
  const vulnerable = await Promise.all([send(localA), send(localB)]);
  assert.deepEqual(vulnerable.map(r => r.status), [200, 200]);
  assert.equal((await send(localA)).status, 409);
  assert.equal(accepted, 2);

  accepted = 0;
  const shared = new Set();
  const fixedA = await start('a', 'shared-consume', shared);
  const fixedB = await start('b', 'shared-consume', shared);
  const fixed = await Promise.all([send(fixedA), send(fixedB)]);
  assert.deepEqual(fixed.map(r => r.status).sort(), [200, 409]);
  assert.equal((await send(fixedA)).status, 409);
  assert.equal((await send(fixedB)).status, 409);
  assert.equal(accepted, 1);
  assert.ok(traces.every(event => event.protocol === 'TLSv1.3'));

  const result = {
    schemaVersion: 1, status: 'passed', scope: 'owned-localhost-fixture',
    transport: 'TLSv1.3 HTTPS after handshake; NOT TLS 0-RTT',
    assumptions: ['one valid bearer ticket', 'two logical nodes',
      'no expiry, cache eviction, restart or persistence',
      'shared consume is synchronous within one Node process'],
    localCacheAccepted: 2, sharedConsumeAccepted: 1, traces,
  };
  writeFileSync(join(home, 'https-replay-trace.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
  rmSync(scratch, { recursive: true, force: true });
}
