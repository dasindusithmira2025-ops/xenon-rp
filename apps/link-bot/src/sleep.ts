/** Sleep that resolves early (never rejects) when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Exponential backoff with full jitter: uniform in [0, min(max, initial * 2^attempt)). */
export function jitteredBackoff(
  attempt: number,
  backoff: { readonly initialMs: number; readonly maxMs: number },
  random: () => number,
): number {
  return Math.floor(random() * Math.min(backoff.maxMs, backoff.initialMs * 2 ** attempt));
}
