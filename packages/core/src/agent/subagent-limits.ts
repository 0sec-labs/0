/** Separate team capacity from the number of simultaneous model requests. */
function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
export const subagentBatchLimit = () => positiveInteger("ZERO_SUBAGENT_MAX_FANOUT", 1024);
export const subagentWorkerLimit = () => positiveInteger("ZERO_SUBAGENT_MAX_WORKERS", 4096);
export const subagentConcurrency = () => positiveInteger("ZERO_SUBAGENT_CONCURRENCY", 32);
