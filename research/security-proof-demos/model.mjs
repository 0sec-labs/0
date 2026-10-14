// Small executable models; no network targets or cryptography involved.
export function authorize(actorTenant, resourceTenant) {
  return actorTenant === resourceTenant;
}
export function readResource(actorTenant, resource) {
  return authorize(actorTenant, resource.tenant) ? { status: 200, body: resource.secret }
    : { status: 403, body: 'Forbidden' };
}
export function staleCommit(snapshot, current, amount) {
  return { balance: Math.max(0, snapshot - amount), paid: current.paid + amount };
}
export function atomicPay(current, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid amount');
  return amount <= current.balance
    ? { balance: current.balance - amount, paid: current.paid + amount }
    : { ...current };
}
export function freshNonce(limit, counter) {
  return counter < limit ? counter : null;
}
export function demos() {
  const initial = { balance: 10, paid: 0 };
  const staleFirst = staleCommit(initial.balance, initial, 7);
  const staleSecond = staleCommit(initial.balance, staleFirst, 7);
  const atomicFirst = atomicPay(initial, 7);
  const atomicSecond = atomicPay(atomicFirst, 7);
  return [
    {
      id: 'tenant', title: 'A login is not tenant authorization',
      claim: 'An accepted access requires matching tenant ownership.',
      buggy: [{ step: 'User from tenant 1 logs in', actorTenant: 1 },
        { step: 'GET resource owned by tenant 2; login-only guard accepts', accepted: true }],
      corrected: [{ step: 'Compare actor tenant 1 with resource tenant 2',
        accepted: authorize(1, 2), response: readResource(1, { tenant: 2, secret: 'Tenant 2 secret' }) }],
      assumption: 'Tenant ownership and the actor identity are trusted and stable during the check.'
    },
    {
      id: 'balance', title: 'Two requests spend one stale balance',
      claim: 'Each atomic payment preserves balance + paid.',
      buggy: [{ step: 'Two requests both read balance 10', ...initial },
        { step: 'First stale commit pays 7', ...staleFirst },
        { step: 'Second stale commit pays 7', ...staleSecond, total: 17 }],
      corrected: [{ step: 'Atomic first payment pays 7', ...atomicFirst },
        { step: 'Atomic second payment rejects insufficient funds', ...atomicSecond, total: 10 }],
      assumption: 'Transitions are atomic and sequential; integers stay in the safe range. A database implementation requires a transaction or conditional update.'
    },
    {
      id: 'nonce', title: 'A finite nonce counter wraps',
      claim: 'Distinct accepted counter positions give distinct nonces before exhaustion.',
      buggy: Array.from({ length: 5 }, (_, counter) => ({ counter, nonce: counter % 4,
        step: counter === 4 ? 'Wrap repeats nonce 0' : 'Emit finite-counter nonce' })),
      corrected: Array.from({ length: 5 }, (_, counter) => ({ counter, nonce: freshNonce(4, counter),
        step: counter === 4 ? 'Exhausted: reject and require a new key / nonce domain' : 'Emit fresh nonce' })),
      assumption: 'The counter is persistent, never reset under the same key, and incremented atomically. This proves uniqueness in the model, not encryption security.'
    }
  ];
}
