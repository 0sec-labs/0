import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism, freemem } from "node:os";

export interface WorkerAdmissionLimits {
  maxActive: number;
  memoryMb: number;
  cpus: number;
  maxQueued: number;
}

export interface WorkerAdmissionRequest {
  memoryMb: number;
  cpus: number;
  timeoutMs: number;
}

export interface WorkerOutcome {
  timedOut: boolean;
  error?: string;
  cleanupFailed?: boolean;
}

interface Waiter {
  request: WorkerAdmissionRequest;
  start(): void;
  cancel(reason: unknown): void;
}

function positive(value: number, name: string, integer = true): number {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`invalid worker ${name}: expected a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

/** Per-process reservations; backend teardown must finish before execute resolves. */
export class WorkerAdmission {
  private readonly limits: WorkerAdmissionLimits;
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private readonly queue: Waiter[] = [];
  private active = 0;
  private memoryMb = 0;
  private cpus = 0;
  private stopped?: Error;

  constructor(limits: WorkerAdmissionLimits) {
    this.limits = {
      maxActive: positive(limits.maxActive, "maxActive"),
      maxQueued: positive(limits.maxQueued, "maxQueued"),
      memoryMb: positive(limits.memoryMb, "memoryMb"),
      cpus: positive(limits.cpus, "cpus", false),
    };
  }

  async run<T extends WorkerOutcome>(
    request: WorkerAdmissionRequest,
    external: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.stopped) throw this.stopped;
    // Copy caller-owned inputs: a queued reservation cannot change its weight.
    request = {
      memoryMb: positive(request.memoryMb, "memoryMb"),
      cpus: positive(request.cpus, "cpus", false),
      timeoutMs: positive(request.timeoutMs, "timeoutMs"),
    };
    if (request.timeoutMs > 2_147_483_647) throw new Error("worker timeout exceeds timer range");
    if (request.memoryMb > this.limits.memoryMb || request.cpus > this.limits.cpus) {
      throw new Error("worker request exceeds admission resource budget");
    }
    external?.throwIfAborted();
    const nested = this.context.getStore()?.active === true;
    if (nested && !this.fits(request)) throw new Error("nested worker has insufficient admission capacity");
    const immediate = nested || (this.queue.length === 0 && this.fits(request));
    if (!immediate && this.queue.length >= this.limits.maxQueued) throw new Error("worker admission queue full");

    const expiresAt = performance.now() + request.timeoutMs;
    const deadline = new AbortController();
    const signal = external ? AbortSignal.any([external, deadline.signal]) : deadline.signal;
    const timeoutError = new DOMException("worker admission deadline exceeded", "TimeoutError");
    const timer = setTimeout(() => deadline.abort(timeoutError), request.timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => waiter.cancel(signal.reason);
      const detach = () => signal.removeEventListener("abort", onAbort);
      const waiter: Waiter = {
        request,
        cancel: (reason) => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          detach();
          clearTimeout(timer);
          reject(reason);
          this.drain();
        },
        start: () => {
          detach();
          if (signal.aborted || performance.now() >= expiresAt) {
            waiter.cancel(signal.aborted ? signal.reason : timeoutError);
            return;
          }
          this.active++;
          this.memoryMb += request.memoryMb;
          this.cpus += request.cpus;
          const lease = { active: true };
          void this.context.run(lease, async () => {
            let retainReservation = false;
            try {
              const outcome = await execute(signal);
              retainReservation = outcome.cleanupFailed === true;
              if (retainReservation) {
                this.stopped ??= new Error("worker admission stopped after unconfirmed cleanup; recover retained workers before restarting the controller");
                while (this.queue.length) this.queue[0]!.cancel(this.stopped);
              }
              resolve(signal.aborted && signal.reason?.name === "TimeoutError" ? { ...outcome, timedOut: true } : outcome);
            } catch (error) {
              reject(error);
            } finally {
              lease.active = false;
              clearTimeout(timer);
              if (!retainReservation) {
                this.active--;
                this.memoryMb -= request.memoryMb;
                this.cpus -= request.cpus;
              }
              this.drain();
            }
          });
        },
      };
      if (immediate) waiter.start();
      else {
        this.queue.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private fits(request: WorkerAdmissionRequest): boolean {
    return this.active < this.limits.maxActive
      && this.memoryMb + request.memoryMb <= this.limits.memoryMb
      && this.cpus + request.cpus <= this.limits.cpus;
  }

  private drain(): void {
    // FIFO roots: do not bypass a larger waiter with a smaller one.
    while (!this.stopped && this.queue.length && this.fits(this.queue[0]!.request)) {
      this.queue.shift()!.start();
    }
  }
}

function defaultLimits(): WorkerAdmissionLimits {
  const override = (name: string, fallback: number, integer = true): number => {
    const value = process.env[name];
    return value === undefined ? fallback : positive(Number(value), name, integer);
  };
  const available = typeof process.availableMemory === "function" ? process.availableMemory() : freemem();
  return {
    maxActive: override("0SEC_WORKER_MAX_ACTIVE", 4),
    maxQueued: override("0SEC_WORKER_MAX_QUEUED", 64),
    memoryMb: override("0SEC_WORKER_MEMORY_MB", Math.max(32, Math.min(8192, Math.floor(available / 2 / 1048576)))),
    cpus: override("0SEC_WORKER_CPUS", availableParallelism(), false),
  };
}

let admission: WorkerAdmission | undefined;

export function withWorkerAdmission<T extends WorkerOutcome>(
  request: WorkerAdmissionRequest,
  signal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return (admission ??= new WorkerAdmission(defaultLimits())).run(request, signal, execute);
}
