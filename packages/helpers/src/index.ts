export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  retryable(err: unknown): false | { afterMs?: number };
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  random?(): number;
  signal?: AbortSignal;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    attempts = 4,
    baseMs = 500,
    maxMs = 30000,
    retryable,
    sleep = defaultSleep,
    random = Math.random,
    signal,
  } = options;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn(attempt);
    } catch (err) {
      const verdict = retryable(err);
      if (verdict === false || attempt >= attempts) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await sleep(Math.min(maxMs, Math.max(random() * backoff, verdict.afterMs ?? 0)), signal);
    }
  }
}
