import 'server-only';
import { readFile } from 'node:fs/promises';
import { signKalshiRequest } from './kalshi-signing';
import {
  KalshiRateLimitError, initialRateLimitState, isRateLimited, rateLimitBackoffMs, rateLimitPaused,
  recordRateLimitSuccess, recordRateLimited, type RateLimitState,
} from './kalshi-rate-limit';

export function kalshiBaseUrl(): string {
  return process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2';
}

export function kalshiEnvironment(): 'demo' | 'production' {
  return kalshiBaseUrl().toLowerCase().includes('demo') ? 'demo' : 'production';
}

export function kalshiConfigured(): boolean {
  return Boolean(process.env.KALSHI_API_KEY_ID && (process.env.KALSHI_PRIVATE_KEY || process.env.KALSHI_PRIVATE_KEY_PATH));
}

async function kalshiPrivateKey(): Promise<string> {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (process.env.KALSHI_PRIVATE_KEY_PATH) return readFile(process.env.KALSHI_PRIVATE_KEY_PATH, 'utf8');
  throw new Error('Kalshi private key is missing');
}

/**
 * Signed Kalshi request. The signature covers timestamp, method, and path only, so the body is sent
 * unsigned exactly as the venue expects.
 */
/**
 * Read and write budgets are separate buckets at Kalshi, so they back off separately: a burst of quote
 * reads must not delay an order, and a busy order path must not stall reconciliation.
 */
let signedReadLimit = initialRateLimitState();
let signedWriteLimit = initialRateLimitState();

export function kalshiSignedRateLimitState(): { read: RateLimitState; write: RateLimitState } {
  return { read: signedReadLimit, write: signedWriteLimit };
}

/** Total attempts for a rate-limited request. Bounded so a caller cannot block behind an endless retry. */
const RATE_LIMIT_ATTEMPTS = 3;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Signed Kalshi request. Never cached — an account read must be authoritative and an order must reach the
 * venue — but a rate-limited attempt is retried.
 *
 * Retrying a write is safe **only** for an explicit 429, and the distinction is the whole point: a 429 is
 * the venue refusing the request before it was processed, so no order can exist. A timeout or a dropped
 * connection is the opposite — the order may well have been created — and those keep the existing
 * uncertain-state path that retains the reservation and reconciles authoritatively. `client_order_id`
 * gives idempotency as a second line of defence.
 *
 * Without this a 429 fell into the generic error branch, where the long-shot entry path could not tell it
 * from a malformed order and would safety-suspend the desk over a request the venue simply declined.
 */
export async function kalshiRequest<T>(path: string, init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error('Kalshi API key ID is missing');
  const method = init.method ?? 'GET';
  const writing = method !== 'GET';
  for (let attempt = 1; ; attempt += 1) {
    const limit = writing ? signedWriteLimit : signedReadLimit;
    if (rateLimitPaused(limit)) {
      if (attempt >= RATE_LIMIT_ATTEMPTS) throw new KalshiRateLimitError(`${method} ${path}`);
      await sleep(Math.max(0, limit.pausedUntilMs - Date.now()));
    }
    try {
      return await signedAttempt<T>(path, init, method, keyId, writing);
    } catch (error) {
      if (!(error instanceof KalshiRateLimitError) || attempt >= RATE_LIMIT_ATTEMPTS) throw error;
      await sleep(rateLimitBackoffMs(attempt));
    }
  }
}

async function signedAttempt<T>(
  path: string, init: { body?: unknown; timeoutMs?: number }, method: 'GET' | 'POST' | 'DELETE',
  keyId: string, writing: boolean,
): Promise<T> {
  const timestamp = Date.now().toString();
  const signature = signKalshiRequest(timestamp, method, `/trade-api/v2${path}`, await kalshiPrivateKey());
  const response = await fetch(`${kalshiBaseUrl().replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'KALSHI-ACCESS-KEY': keyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    cache: 'no-store',
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as T & { code?: string; message?: string; details?: string; error?: { code?: string; message?: string; details?: string } } : ({} as T & { code?: string; message?: string; details?: string; error?: { code?: string; message?: string; details?: string } });
  if (isRateLimited(response.status)) {
    if (writing) signedWriteLimit = recordRateLimited(signedWriteLimit);
    else signedReadLimit = recordRateLimited(signedReadLimit);
    console.error(`Kalshi rate limit on ${method} ${path}; the request was refused, so no order was created.`);
    throw new KalshiRateLimitError(`${method} ${path}`);
  }
  if (!response.ok) {
    const error = body.error ?? body;
    const detail = [error.code, error.message, error.details].filter(Boolean).join(' · ');
    throw new Error(detail || `Kalshi ${method} ${path} returned ${response.status}`);
  }
  if (writing) signedWriteLimit = recordRateLimitSuccess(signedWriteLimit);
  else signedReadLimit = recordRateLimitSuccess(signedReadLimit);
  return body;
}
