#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const home = dirname(fileURLToPath(import.meta.url));
const prefix = '/opt/homebrew/opt/openssl@3';
const openssl = join(prefix, 'bin/openssl');
const scratch = mkdtempSync(join(tmpdir(), 'zero-owned-early-data-'));
const output = join(home, 'result.json');
let result;
try {
  if (!existsSync(openssl)) throw new Error('Required Homebrew OpenSSL 3 executable absent');
  const version = execFileSync(openssl, ['version'], { encoding: 'utf8', timeout: 5000 }).trim();
  execFileSync('clang', ['-Wall', '-Wextra', '-Werror', '-O2',
    `-I${prefix}/include`, `-L${prefix}/lib`, `-Wl,-rpath,${prefix}/lib`,
    join(home, 'replay.c'), '-lssl', '-lcrypto', '-o', join(scratch, 'replay')],
    { encoding: 'utf8', timeout: 20000 });
  const conf = `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`;
  writeFileSync(join(scratch, 'cert.cnf'), conf, { mode: 0o600 });
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', join(scratch, 'cert.cnf'), '-keyout', join(scratch, 'key.pem'),
    '-out', join(scratch, 'cert.pem')], { stdio: 'ignore', timeout: 10000 });
  const runs = [];
  for (const mode of ['anti-replay', 'disabled-control']) {
    const stdout = execFileSync(join(scratch, 'replay'),
      [join(scratch, 'cert.pem'), join(scratch, 'key.pem'), mode],
      { encoding: 'utf8', timeout: 15000 });
    const events = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.length, 6);
    const servers = events.filter(event => event.side === 'server').sort((a,b) => a.connection-b.connection);
    const clients = events.filter(event => event.side === 'client').sort((a,b) => a.connection-b.connection);
    const expected = mode === 'anti-replay' ? ['not-sent', 'accepted', 'rejected'] : ['not-sent', 'accepted', 'accepted'];
    assert.deepEqual(servers.map(e => e.earlyData), expected);
    assert.deepEqual(clients.map(e => e.earlyData), expected);
    assert.deepEqual(servers.map(e => e.acceptedBytes), mode === 'anti-replay' ? [0, 23, 0] : [0, 23, 23]);
    assert.deepEqual(clients.map(e => e.resumed), mode === 'anti-replay' ? [false, true, false] : [false, true, true]);
    assert.ok(events.every(e => e.protocol === 'TLSv1.3'));
    assert.ok(clients.every(e => e.certificateVerified));
    runs.push({ mode, status: 'passed', events });
  }
  result = { schemaVersion: 1, status: 'passed', version,
    scope: 'owned-localhost-TLS1.3-early-data-calibration',
    finding: 'Known replay behavior under intentionally disabled protection; not a new TLS break',
    replay: 'Same original TLS session duplicated for each attempt; newly issued tickets are not reused',
    rejection: 'Default anti-replay rejects repeated early data but successfully falls back to full handshake',
    payloadBytes: 23, runs };
} catch (error) {
  result = { schemaVersion: 1, status: 'inconclusive', reason: error.message };
  process.exitCode = 2;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
