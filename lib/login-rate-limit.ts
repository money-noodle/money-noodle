/**
 * Failed-login throttling for the one endpoint that stands between the internet and a control plane that
 * arms real-money trading.
 *
 * Two independent controls, because they fail differently:
 *
 * 1. A fixed delay on every failure. This needs no shared state, so it survives serverless instance
 *    fan-out and IP rotation — the two ways a counter-based limiter is defeated. It is the control that
 *    actually bounds guessing throughput.
 * 2. A per-IP lockout after a short burst. Cheap, and stops the common single-source case outright.
 *
 * The counter is per-process by design. On a stateless host each warm instance keeps its own, so the
 * lockout is weaker there while the delay is unaffected. Treat the delay as the guarantee and the
 * lockout as an optimisation, never the reverse.
 */

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Applied to every rejected attempt, including ones already locked out. */
export const FAILURE_DELAY_MS = 1_000;
/** Bounded so an attacker rotating source addresses cannot grow this map without limit. */
export const MAX_TRACKED_CLIENTS = 10_000;

interface ClientState { failures: number; firstFailureAt: number; lockedUntil: number }

const clients = new Map<string, ClientState>();

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remainingAttempts: number;
}

function evictIfFull(now: number): void {
  if (clients.size < MAX_TRACKED_CLIENTS) return;
  // Drop entries that can no longer matter first; only then fall back to oldest-first eviction.
  for (const [key, state] of clients) {
    if (state.lockedUntil <= now && now - state.firstFailureAt > WINDOW_MS) clients.delete(key);
  }
  while (clients.size >= MAX_TRACKED_CLIENTS) {
    const oldest = clients.keys().next();
    if (oldest.done) break;
    clients.delete(oldest.value);
  }
}

export function loginAttemptAllowed(client: string, now = Date.now()): RateLimitDecision {
  const state = clients.get(client);
  if (!state) return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_FAILURES };
  if (state.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000), remainingAttempts: 0 };
  }
  // A window that has fully elapsed is forgiven, so an honest operator is never permanently penalised.
  if (now - state.firstFailureAt > WINDOW_MS) {
    clients.delete(client);
    return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_FAILURES };
  }
  return { allowed: true, retryAfterSeconds: 0, remainingAttempts: Math.max(0, MAX_FAILURES - state.failures) };
}

export function recordLoginFailure(client: string, now = Date.now()): RateLimitDecision {
  evictIfFull(now);
  const existing = clients.get(client);
  const state: ClientState = !existing || now - existing.firstFailureAt > WINDOW_MS
    ? { failures: 0, firstFailureAt: now, lockedUntil: 0 }
    : existing;
  state.failures += 1;
  if (state.failures >= MAX_FAILURES) state.lockedUntil = now + LOCKOUT_MS;
  clients.set(client, state);
  return state.lockedUntil > now
    ? { allowed: false, retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000), remainingAttempts: 0 }
    : { allowed: true, retryAfterSeconds: 0, remainingAttempts: Math.max(0, MAX_FAILURES - state.failures) };
}

/** A correct password clears the record, so a successful operator is not throttled by earlier typos. */
export function clearLoginFailures(client: string): void {
  clients.delete(client);
}

/**
 * Client identity for throttling. `x-forwarded-for` is trustworthy only because a platform edge sets it;
 * a client can present any value, which is precisely why the fixed delay rather than this key is what
 * bounds throughput. The left-most entry is the original client per the header's convention.
 */
export function loginClientKey(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Test-only reset; production has no reason to discard throttling state. */
export function resetLoginRateLimit(): void {
  clients.clear();
}
