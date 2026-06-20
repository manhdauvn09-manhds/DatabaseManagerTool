/** Exponential backoff with jitter for retrying transient failures. */

export interface BackoffOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterFraction?: number;
}

const DEFAULT_OPTIONS: Required<BackoffOptions> = {
  maxAttempts: 5,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  jitterFraction: 0.1
};

/** Add random jitter to reduce thundering herd. */
function applyJitter(delayMs: number, jitterFraction: number): number {
  const jitterRange = delayMs * jitterFraction;
  return delayMs + Math.random() * jitterRange - jitterFraction * delayMs / 2;
}

/** Retry fn with exponential backoff on transient errors (ECONNREFUSED, ETIMEDOUT, etc). */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {}
): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs, jitterFraction } = {
    ...DEFAULT_OPTIONS,
    ...opts
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      // Retry only on transient errors.
      const isTransient =
        /^ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|timeout|temporarily unavailable/i.test(
          lastError.message
        );

      if (!isTransient || attempt === maxAttempts - 1) {
        throw lastError;
      }

      // Calculate delay with exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms (capped at maxDelayMs)
      const exponentialDelay = Math.min(
        initialDelayMs * Math.pow(2, attempt),
        maxDelayMs
      );
      const delay = Math.round(applyJitter(exponentialDelay, jitterFraction));

      // Sleep before retry
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Unknown error in exponential backoff");
}
