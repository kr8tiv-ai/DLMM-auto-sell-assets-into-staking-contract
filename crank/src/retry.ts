/**
 * Exponential backoff retry utility with jitter.
 *
 * Retries the provided async function on any error, doubling the delay
 * each attempt (capped at maxDelayMs) with random jitter.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the initial call) */
  maxRetries: number;
  /** Base delay in milliseconds before first retry */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds */
  maxDelayMs: number;
  /** Optional sleep function for testing */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Execute `fn` with exponential backoff retry.
 *
 * @returns The result of `fn` on the first successful call
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      if (attempt === opts.maxRetries) {
        break;
      }

      // Exponential backoff: baseDelay * 2^attempt, capped at maxDelay
      const expDelay = opts.baseDelayMs * Math.pow(2, attempt);
      const capped = Math.min(expDelay, opts.maxDelayMs);
      // Add jitter: random value between 0 and capped delay
      const jitter = Math.random() * capped;
      const delay = Math.floor(capped + jitter);

      await sleep(delay);
    }
  }

  throw lastError;
}
