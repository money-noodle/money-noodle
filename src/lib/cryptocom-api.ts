import 'server-only';
import { createHmac } from 'node:crypto';
import type { AccountPosition, VenueAccount } from './types';

const BASE_URL = process.env.CRYPTOCOM_BASE_URL?.trim() || 'https://api.crypto.com/exchange/v1';
const TIMEOUT_MS = 10_000;

interface CryptoComEnvelope<T> { id: number; code: number; method: string; result?: T; message?: string }

export function cryptoComCredentials(): { apiKey: string; apiSecret: string } | undefined {
  const apiKey = process.env.CRYPTOCOM_API_KEY?.trim();
  const apiSecret = process.env.CRYPTOCOM_API_SECRET?.trim();
  return apiKey && apiSecret ? { apiKey, apiSecret } : undefined;
}

/**
 * Crypto.com signs a concatenation, not JSON, so parameter order is part of the signature. Keys must be
 * sorted and nested objects flattened in that same order, or the venue rejects an otherwise valid
 * request. Kept pure and exported so it can be tested without credentials or a network call.
 */
export function cryptoComParameterString(params: Record<string, unknown>): string {
  return Object.keys(params).sort().map((key) => {
    const value = params[key];
    if (value === null || value === undefined) return key;
    if (Array.isArray(value) || typeof value === 'object') return key + JSON.stringify(value);
    return key + String(value);
  }).join('');
}

export function cryptoComSignature(input: {
  method: string; id: number; apiKey: string; apiSecret: string; nonce: number; params?: Record<string, unknown>;
}): string {
  const { method, id, apiKey, apiSecret, nonce, params = {} } = input;
  const payload = `${method}${id}${apiKey}${cryptoComParameterString(params)}${nonce}`;
  return createHmac('sha256', apiSecret).update(payload).digest('hex');
}

async function signedRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const credentials = cryptoComCredentials();
  if (!credentials) throw new Error('Crypto.com API credentials are not configured.');
  const id = Date.now();
  const nonce = Date.now();
  const body = {
    id, method, api_key: credentials.apiKey, params, nonce,
    sig: cryptoComSignature({ method, id, apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, nonce, params }),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/${method}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const envelope = await response.json() as CryptoComEnvelope<T>;
    // A non-zero `code` accompanies HTTP 200, so status alone is not success.
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`Crypto.com ${method} failed: ${envelope.message ?? `code ${envelope.code}`}`);
    }
    return envelope.result as T;
  } finally { clearTimeout(timer); }
}

interface BalanceResult {
  data?: Array<{
    total_available_balance?: string; total_cash_balance?: string;
    position_balances?: Array<{ instrument_name?: string; quantity?: string; market_value?: string }>;
  }>;
}

/**
 * Read-only account snapshot. No order placement path exists in this module at all: `crypto-15m` has no
 * Crypto.com execution route, and spot/perpetual trading is not a promoted capability, so a trading
 * function here would be a capability the registry does not grant.
 */
export async function getCryptoComAccount(): Promise<VenueAccount> {
  if (!cryptoComCredentials()) {
    return {
      venue: 'crypto-com', configured: false, connected: false, tradeAuthenticated: false,
      positions: [], openOrders: 0,
      error: 'Set CRYPTOCOM_API_KEY and CRYPTOCOM_API_SECRET to read this account.',
    };
  }
  try {
    const result = await signedRequest<BalanceResult>('private/user-balance');
    const account = result.data?.[0];
    const positions: AccountPosition[] = (account?.position_balances ?? [])
      .filter((item) => Number(item.quantity ?? 0) !== 0)
      .map((item) => ({
        venue: 'crypto-com', id: item.instrument_name ?? 'unknown', title: item.instrument_name ?? 'unknown',
        side: 'spot', size: Number(item.quantity ?? 0), averagePrice: 0, currentPrice: 0,
        currentValue: Number(item.market_value ?? 0), pnl: 0,
      }));
    return {
      venue: 'crypto-com', configured: true, connected: true,
      // Read access only. Trading remains ungranted, so this is never a trade-authenticated account.
      tradeAuthenticated: false,
      balance: Number(account?.total_available_balance ?? account?.total_cash_balance ?? 0),
      positions, openOrders: 0,
    };
  } catch (error) {
    return {
      venue: 'crypto-com', configured: true, connected: false, tradeAuthenticated: false,
      positions: [], openOrders: 0,
      error: error instanceof Error ? error.message : 'Crypto.com connection failed',
    };
  }
}
