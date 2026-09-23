// The hosted gateway admits four requests per organization. Share the client
// budget across audits and nested workers using the same endpoint/credential,
// rather than giving every spawn_agents batch its own network allowance.
const MAX_IN_FLIGHT = 4;
type Release = () => void;
interface Waiter { grant: () => void }
interface Queue { active: number; waiting: Waiter[] }
const endpoints = new Map<string, Map<string, Queue>>();

/** Hold until the full response is consumed, not merely until headers arrive. */
export function acquireHostedRequestSlot(endpoint: string, token: string, signal?: AbortSignal): Promise<Release> {
  signal?.throwIfAborted();
  let accounts = endpoints.get(endpoint);
  if (!accounts) endpoints.set(endpoint, accounts = new Map());
  let queue = accounts.get(token);
  if (!queue) accounts.set(token, queue = { active: 0, waiting: [] });
  const accountQueues = accounts;
  const current = queue;
  return new Promise<Release>((resolve, reject) => {
    const abort = () => {
      const index = current.waiting.indexOf(waiter);
      if (index !== -1) current.waiting.splice(index, 1);
      reject(signal!.reason);
    };
    const waiter: Waiter = { grant: () => {
      signal?.removeEventListener("abort", abort);
      current.active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        current.active--;
        const next = current.waiting.shift();
        if (next) next.grant();
        else if (current.active === 0) {
          accountQueues.delete(token);
          if (accountQueues.size === 0) endpoints.delete(endpoint);
        }
      });
    } };
    if (current.active < MAX_IN_FLIGHT) waiter.grant();
    else {
      current.waiting.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}
