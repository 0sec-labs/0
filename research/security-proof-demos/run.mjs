import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readResource, atomicPay, freshNonce, demos } from './model.mjs';

export async function proofEvidence() {
  const source = await readFile(new URL('./SecurityDemos.lean', import.meta.url));
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  try {
    const evidence = JSON.parse(await readFile(new URL('./verification.json', import.meta.url), 'utf8'));
    const names = ['cross_tenant_counterexample', 'tenant_isolation', 'stale_authorization_counterexample',
      'atomic_payment_conserves', 'atomic_payment_cannot_overspend', 'rollover_counterexample',
      'fresh_nonce_is_bounded', 'distinct_counters_have_distinct_nonces'];
    const allowed = new Set(['propext', 'Classical.choice', 'Quot.sound']);
    const completeReports = Array.isArray(evidence.axioms) && evidence.axioms.length === names.length && names.every(name =>
      evidence.axioms.filter(report => report?.theorem === `ZeroSecurityDemos.${name}`).length === 1 &&
      evidence.axioms.some(report => report?.theorem === `ZeroSecurityDemos.${name}` &&
        Array.isArray(report.axioms) && new Set(report.axioms).size === report.axioms.length &&
        report.axioms.every(axiom => allowed.has(axiom))));
    if (evidence.sourceSha256 !== sourceSha256 || evidence.toolchain !== 'leanprover/lean4:v4.35.0-rc4' ||
      evidence.status !== 'verified' || !['official-lean-playground', 'local-lean'].includes(evidence.method) ||
      evidence.errors !== 0 || !completeReports || !Number.isFinite(Date.parse(evidence.checkedAt)) ||
      typeof evidence.checkerOutput !== 'string' || !names.every(name => evidence.checkerOutput.includes(name))) {
      return { status: 'pending', reason: 'Proof evidence does not match the source/toolchain.', sourceSha256 };
    }
    // Evidence is a recorded checker result, not an attestation of JS equivalence.
    return { ...evidence, sourceSha256 };
  } catch {
    return { status: 'pending', reason: 'No matching Lean checker evidence recorded.', sourceSha256 };
  }
}

export function boundedChecks() {
  let tenantCases = 0, paymentCases = 0, nonceCases = 0;
  for (let actor = 0; actor <= 8; actor++) for (let owner = 0; owner <= 8; owner++) {
    // foxguard: ignore[js/no-hardcoded-secret] deterministic authorization test fixture, never an authentication credential.
    const secret = `private tenant ${owner}`;
    const response = readResource(actor, { tenant: owner, secret });
    if (actor !== owner) { assert.equal(response.status, 403); assert.notEqual(response.body, secret); }
    else { assert.equal(response.status, 200); assert.equal(response.body, secret); }
    tenantCases++;
  }
  // Two transitions exercise both acceptance and insufficient-funds rejection.
  for (let balance = 0; balance <= 20; balance++) for (let paid = 0; paid <= 5; paid++)
    for (let a = 0; a <= 20; a++) for (let b = 0; b <= 20; b++) {
      const first = atomicPay({ balance, paid }, a);
      const second = atomicPay(first, b);
      assert.equal(second.balance + second.paid, balance + paid);
      assert.ok(second.balance >= 0 && second.balance <= balance);
      assert.equal(second.paid - paid, (a <= balance ? a : 0) + (b <= first.balance ? b : 0));
      paymentCases++;
    }
  for (let limit = 0; limit <= 32; limit++) {
    const emitted = [];
    for (let counter = 0; counter <= 40; counter++) {
      const nonce = freshNonce(limit, counter);
      assert.equal(nonce, counter < limit ? counter : null);
      if (nonce !== null) { assert.ok(nonce < limit); emitted.push(nonce); }
      nonceCases++;
    }
    assert.equal(new Set(emitted).size, emitted.length);
  }
  const examples = demos();
  assert.equal(examples[1].buggy.at(-1).total, 17);
  assert.equal(examples[1].corrected.at(-1).total, 10);
  assert.equal(examples[2].buggy[0].nonce, examples[2].buggy[4].nonce);
  return { status: 'passed', tenantCases, paymentCases, nonceCases,
    scope: 'Bounded exhaustive JavaScript checks only; universal theorems concern the Lean model.' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify({ scope: 'Known bug classes in educational local models; no novel vulnerability claim.',
    proof: await proofEvidence(), checks: boundedChecks(), demos: demos() }, null, 2));
}
