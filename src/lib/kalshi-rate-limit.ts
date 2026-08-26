/**
 * Rate-limit state for Kalshi reads. Pure and I/O free.
 *
 * Kalshi's basic tier refills 200 read tokens per second against a 600-token bucket, at 10 tokens per
 * request: 20 requests a second sustained, 60 in a burst.
 *
 * The reason this exists rather than being left to ordinary error handling: a 429 from Kalshi carries
 * **no `Retry-After` and no `X-RateLimit-*` headers**. It arrives as a bare non-OK response, which every
 * polling path in this app already catches and treats as a transient quote failure. Without an explicit
 * check, exceeding the limit looks exactly like a flaky venue — polling silently stops returning prices
 * on an open position and nothing says why.
 */
export const KALSHI_RATE_LIMIT_STATUS = 429;

/** Doubling from a quarter of a second, capped. Beyond a few seconds the poll itself is the retry. */
const BASE_BACKOFF_MS = 250;
const MAXIMUM_BACKOFF_MS = 8_000;

export interface RateLimitState {
  /** Consecutive rate-limited responses. Reset by any success. */
  strikes: number;
  /** Epoch milliseconds before which no request should be attempted. */
  pausedUntilMs: number;
  lastLimitedAtMs?: number;
}

export const initialRateLimitState = (): RateLimitState => ({ strikes: 0, pausedUntilMs: 0 });

/**
 * Backoff with jitter.
 *
 * Jitter is not decoration here. Every caller backs off from the same venue at the same moment, so a
 * fixed delay would retry them in a synchronised burst and re-trip the limit — the classic thundering
 * herd. Randomising across the window spreads the retry out.
 */
export function rateLimitBackoffMs(strikes: number, random = Math.random): number {
  const exponential = Math.min(MAXIMUM_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, strikes - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

export function recordRateLimited(state: RateLimitState, nowMs = Date.now(), random = Math.random): RateLimitState {
  const strikes = state.strikes + 1;
  return { strikes, pausedUntilMs: nowMs + rateLimitBackoffMs(strikes, random), lastLimitedAtMs: nowMs };
}

/** Any success clears the pause outright: the budget refills continuously, so one good read proves room. */
export function recordRateLimitSuccess(state: RateLimitState): RateLimitState {
  return state.strikes === 0 && state.pausedUntilMs === 0
    ? state
    : { strikes: 0, pausedUntilMs: 0, lastLimitedAtMs: state.lastLimitedAtMs };
}

export function rateLimitPaused(state: RateLimitState, nowMs = Date.now()): boolean {
  return nowMs < state.pausedUntilMs;
}

export function isRateLimited(status: number): boolean {
  return status === KALSHI_RATE_LIMIT_STATUS;
}

/** Distinguishable in a log and in a catch, so a breach is never mistaken for a flaky venue. */
export class KalshiRateLimitError extends Error {
  readonly status = KALSHI_RATE_LIMIT_STATUS;
  constructor(path: string) {
    super(`Kalshi rate limit reached on ${path}. No Retry-After is provided; backing off.`);
    this.name = 'KalshiRateLimitError';
  }
}
