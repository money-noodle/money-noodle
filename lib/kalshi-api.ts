import 'server-only';
import { readFile } from 'node:fs/promises';
import { signKalshiRequest } from './kalshi-signing';

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
export async function kalshiRequest<T>(path: string, init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error('Kalshi API key ID is missing');
  const method = init.method ?? 'GET';
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
  if (!response.ok) {
    const error = body.error ?? body;
    const detail = [error.code, error.message, error.details].filter(Boolean).join(' · ');
    throw new Error(detail || `Kalshi ${method} ${path} returned ${response.status}`);
  }
  return body;
}
