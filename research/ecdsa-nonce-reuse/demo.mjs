/** Deliberately broken local signer. No production inputs or external targets. */
import { randomBytes, createHash, createPublicKey, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// NIST P-256 domain parameters. All scalar/field loops have fixed finite bounds.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const G = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};
const mod = (x, m) => ((x % m) + m) % m;
function assert(ok, message) { if (!ok) throw new Error(message); }
function inverse(x, m) {
  let a = mod(x, m), b = m, u = 1n, v = 0n;
  for (let i = 0; i < 1024 && a !== 0n; i++) {
    const q = b / a;
    [b, a] = [a, b - q * a];
    [v, u] = [u, v - q * u];
  }
  assert(a === 0n && b === 1n, 'noninvertible value or iteration bound');
  return mod(v, m);
}
function onCurve(q) { return q === null || mod(q.y*q.y - (q.x*q.x*q.x + A*q.x + B), P) === 0n; }
function add(q, t) {
  if (q === null) return t;
  if (t === null) return q;
  if (q.x === t.x && mod(q.y + t.y, P) === 0n) return null;
  const slope = q.x === t.x
    ? mod((3n*q.x*q.x + A) * inverse(2n*q.y, P), P)
    : mod((t.y-q.y) * inverse(t.x-q.x, P), P);
  const x = mod(slope*slope - q.x - t.x, P);
  return { x, y: mod(slope*(q.x-x)-q.y, P) };
}
function multiply(scalar, point = G) {
  assert(scalar >= 0n && scalar <= N, 'scalar outside hard-coded bounds');
  let result = null, current = point;
  for (let i = 0; i < 256; i++) {
    if ((scalar & 1n) !== 0n) result = add(result, current);
    current = add(current, current);
    scalar >>= 1n;
  }
  return result;
}
function sampleScalar() {
  for (let i = 0; i < 128; i++) {
    const s = BigInt('0x' + randomBytes(32).toString('hex'));
    if (s > 0n && s < N) return s;
  }
  throw new Error('random scalar sampling bound exceeded');
}
const bytes = x => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');
const digest = message => BigInt('0x' + createHash('sha256').update(message).digest('hex'));
function brokenSign(message, d, nonce) {
  const q = multiply(nonce);
  assert(q !== null, 'infinity nonce point');
  const r = mod(q.x, N);
  const s = mod(inverse(nonce, N) * (digest(message) + r*d), N);
  assert(r !== 0n && s !== 0n, 'degenerate signature; rerun demo');
  return { r, s };
}
const signatureBytes = ({r, s}) => Buffer.concat([bytes(r), bytes(s)]);
assert(onCurve(G) && multiply(N) === null, 'P-256 domain sanity checks failed');
assert(multiply(1n)?.x === G.x && onCurve(multiply(2n)), 'point arithmetic sanity checks failed');

// These secrets are generated for this process only and are never serialized.
const privateScalar = sampleScalar();
const reusedNonce = sampleScalar();
const publicPoint = multiply(privateScalar);
assert(publicPoint !== null && onCurve(publicPoint), 'invalid public point');
const publicJwk = {
  kty: 'EC', crv: 'P-256',
  x: bytes(publicPoint.x).toString('base64url'),
  y: bytes(publicPoint.y).toString('base64url'),
};
const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
const firstMessage = 'Owned local demo: authorize transaction A';
const secondMessage = 'Owned local demo: authorize transaction B';
const freshMessage = 'Owned local demo: unauthorized transaction C';
const first = brokenSign(firstMessage, privateScalar, reusedNonce);
const second = brokenSign(secondMessage, privateScalar, reusedNonce);
assert(first.r === second.r && first.s !== second.s, 'nonce-reuse prerequisites absent');

// Recovery uses only PUBLIC message hashes and signatures from this point.
const recoveredNonce = mod((digest(firstMessage)-digest(secondMessage)) * inverse(first.s-second.s, N), N);
const recoveredScalar = mod((first.s*recoveredNonce-digest(firstMessage)) * inverse(first.r, N), N);
const recoveredPoint = multiply(recoveredScalar);
const forged = brokenSign(freshMessage, recoveredScalar, sampleScalar());
const independentVerify = (message, sig) => verify('sha256', Buffer.from(message),
  { key: publicKey, dsaEncoding: 'ieee-p1363' }, signatureBytes(sig));
const checks = {
  firstSignatureVerifiedByNodeOpenSSL: independentVerify(firstMessage, first),
  secondSignatureVerifiedByNodeOpenSSL: independentVerify(secondMessage, second),
  recoveredPublicKeyMatchesOriginal: recoveredPoint?.x === publicPoint.x && recoveredPoint?.y === publicPoint.y,
  freshForgeryVerifiedByOriginalNodeOpenSSLPublicKey: independentVerify(freshMessage, forged),
  modifiedMessageRejected: !independentVerify(freshMessage + ' modified', forged),
};
assert(Object.values(checks).every(Boolean), 'independent demo validation failed');
const result = {
  schemaVersion: 1,
  scope: 'Known ECDSA nonce-reuse vulnerability in deliberately broken local signer; not a P-256 or TLS break.',
  verifier: `Node ${process.version} / OpenSSL ${process.versions.openssl}; SHA-256; IEEE P1363`,
  curve: 'P-256', checks, publicJwk,
  publicArtifacts: [
    [firstMessage, first], [secondMessage, second], [freshMessage, forged],
  ].map(([message, sig]) => ({message, signatureP1363Hex: signatureBytes(sig).toString('hex')})),
};
const output = new URL('./result.json', import.meta.url);
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({scope: result.scope, verifier: result.verifier, checks}, null, 2));
