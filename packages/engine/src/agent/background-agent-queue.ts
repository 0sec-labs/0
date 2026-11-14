interface QueuedAgentRun {
  start(): void;
}

/** Bounds executing agent runs; agents waiting for another turn hold no slot. */
export class BackgroundAgentQueue {
  readonly #limit: number;
  #active = 0;
  readonly #pending: QueuedAgentRun[] = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Background agent concurrency must be a positive safe integer.");
    }
    this.#limit = limit;
  }

  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const abort = () => {
        const index = this.#pending.indexOf(job);
        if (index === -1) return;
        this.#pending.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const job: QueuedAgentRun = {
        start: () => {
          signal.removeEventListener("abort", abort);
          this.#active++;
          // Catch task failures here rather than creating an ignored rejecting
          // promise with finally(). Active cancellation remains task-owned.
          void (async () => {
            try {
              resolve(await task());
            } catch (error) {
              reject(error);
            } finally {
              this.#active--;
              this.#drain();
            }
          })();
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.push(job);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#pending.length > 0) {
      this.#pending.shift()!.start();
    }
  }
}
