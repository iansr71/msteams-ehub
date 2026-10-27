import { ExtractionFailure } from './errors.js';

export type Clock = () => number;

/**
 * Cooperative time limit. Extractors call `check()` between units of work (pages, slides,
 * archive entries, batches of XML events). This bounds total work but cannot interrupt a single
 * long synchronous parser call; see docs/extraction.md "Timeouts".
 */
export class Deadline {
  readonly #expiresAt: number;
  readonly #clock: Clock;

  constructor(timeoutMs: number, clock: Clock = Date.now) {
    this.#clock = clock;
    this.#expiresAt = clock() + timeoutMs;
  }

  get remainingMs(): number {
    return Math.max(0, this.#expiresAt - this.#clock());
  }

  get expired(): boolean {
    return this.#clock() >= this.#expiresAt;
  }

  check(): void {
    if (this.expired) {
      throw new ExtractionFailure('timeout', 'Extraction exceeded its time limit.');
    }
  }
}

/**
 * Rejects with a timeout failure if `work` has not settled by the deadline, and aborts
 * `controller` so the extractor can release resources. The work promise is left to settle
 * on its own; its result is ignored.
 */
export async function runWithDeadline<T>(
  work: Promise<T>,
  deadline: Deadline,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting: abort listeners may reject `work` synchronously, and whichever
      // promise settles first wins the race. The outcome must be "timeout", not the side effect.
      reject(new ExtractionFailure('timeout', 'Extraction exceeded its time limit.'));
      controller.abort();
    }, deadline.remainingMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // Prevent an unhandled rejection if the work fails after the timeout already won.
    work.catch(() => undefined);
  }
}
