export interface SubmissionQueuePort {
  run<T>(task: () => Promise<T>, options: { allowQueue: boolean; signal?: AbortSignal }): Promise<T>;
}

export class SubmissionQueueFullError extends Error {
  constructor() {
    super('The private submission queue is full.');
    this.name = 'SubmissionQueueFullError';
  }
}

interface PendingTask {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Process-local admission queue. It retains only closures while a request is
 * active and releases them immediately; it never persists request material.
 */
export class BoundedSubmissionQueue implements SubmissionQueuePort {
  private inFlight = 0;
  private readonly pending: PendingTask[] = [];

  constructor(
    private readonly maxInFlight: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) {
      throw new Error('Submission concurrency must be a positive integer.');
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new Error('Submission queue length must be a non-negative integer.');
    }
  }

  run<T>(task: () => Promise<T>, options: { allowQueue: boolean; signal?: AbortSignal }): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    if (this.inFlight < this.maxInFlight) return this.start(task);
    if (!options.allowQueue || this.pending.length >= this.maxQueued) {
      return Promise.reject(new SubmissionQueueFullError());
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask = {
        task,
        resolve: (value) => resolve(value as T),
        reject,
        signal: options.signal,
      };
      if (options.signal) {
        pending.onAbort = () => {
          const index = this.pending.indexOf(pending);
          if (index === -1) return;
          this.pending.splice(index, 1);
          reject(abortReason(options.signal!));
        };
        options.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending.push(pending);
    });
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
      this.startNext();
    }
  }

  private startNext(): void {
    for (;;) {
      const next = this.pending.shift();
      if (!next) return;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(abortReason(next.signal));
        continue;
      }
      void this.start(next.task).then(next.resolve, next.reject);
      return;
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Request aborted.', 'AbortError');
}
