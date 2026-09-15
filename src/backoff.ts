/**
 * Exponential backoff with full jitter (Phase 7 / Issue #8).
 *
 * Schedule math from architecture §6.6 / ADR-0010:
 *
 *   delay = min(capMs, baseMs * 2^backoffAttempts) * random(0, 1)
 *
 * `random` is injectable so tests are deterministic (no real sleeps anywhere
 * in the library). `nextAttemptAt = now + delay` is persisted by the engine
 * on `SUBMITTING → NEEDS_RETRY` so restarts neither lose nor double-fire
 * retries.
 *
 * Defaults (ADR-0010, frozen for 1.x): `baseMs = 1_000`, `capMs = 60_000`.
 */

/** Default backoff base (ADR-0010 #4). */
export const BACKOFF_BASE_MS = 1_000;
/** Default backoff cap (ADR-0010 #5). */
export const BACKOFF_CAP_MS = 60_000;

/** Options for `computeBackoffDelay` / `nextAttemptTime`. */
export type BackoffOptions = {
  /** Base delay in ms (default `BACKOFF_BASE_MS`). */
  baseMs?: number | undefined;
  /** Cap on the un-jittered delay in ms (default `BACKOFF_CAP_MS`). */
  capMs?: number | undefined;
  /**
   * Uniform random source producing values in `[0, 1)`. Injected for
   * determinism; defaults to `Math.random`.
   */
  random?: (() => number) | undefined;
};

/** Clamp an options object to concrete values. */
function resolveOptions(options: BackoffOptions = {}): {
  baseMs: number;
  capMs: number;
  random: () => number;
} {
  const baseMs = options.baseMs ?? BACKOFF_BASE_MS;
  const capMs = options.capMs ?? BACKOFF_CAP_MS;
  if (!Number.isInteger(baseMs) || baseMs <= 0) {
    throw new RangeError('backoff.baseMs must be a positive integer');
  }
  if (!Number.isInteger(capMs) || capMs <= 0) {
    throw new RangeError('backoff.capMs must be a positive integer');
  }
  if (capMs < baseMs) {
    throw new RangeError('backoff.capMs must be >= backoff.baseMs');
  }
  return { baseMs, capMs, random: options.random ?? Math.random };
}

/**
 * The un-jittered exponential component: `min(capMs, baseMs * 2^attempts)`.
 * `attempts` (consecutive transient failures) is capped internally at 32 so
 * `2^attempts` can never overflow into `Infinity`.
 */
export function expBackoffCeiling(attempts: number, options: BackoffOptions = {}): number {
  const { baseMs, capMs } = resolveOptions(options);
  const n = Math.max(0, Math.floor(attempts));
  const exp = Math.min(n, 32);
  return Math.min(capMs, baseMs * 2 ** exp);
}

/**
 * Full-jitter delay for the given number of consecutive transient failures:
 * `min(cap, base * 2^attempts) * random(0,1)` (architecture §6.6).
 *
 * The result is in `[0, ceiling)` — bounded by the cap in expectation and
 * always (any jitter draw ≤ the ceiling). Monotone growth holds in
 * expectation, not per draw (that is the point of full jitter).
 */
export function computeBackoffDelay(attempts: number, options: BackoffOptions = {}): number {
  const { random } = resolveOptions(options);
  const ceiling = expBackoffCeiling(attempts, options);
  return ceiling * random();
}

/**
 * The persisted scheduler gate for a retried entry:
 * `nextAttemptAt = now + computeBackoffDelay(backoffAttempts, options)`.
 */
export function nextAttemptTime(now: number, backoffAttempts: number, options: BackoffOptions = {}): number {
  return now + computeBackoffDelay(backoffAttempts, options);
}
