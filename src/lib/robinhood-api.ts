import 'server-only';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import type { AccountPosition, VenueAccount } from './types';

const BASE_URL = process.env.ROBINHOOD_BASE_URL?.trim() || 'https://trading.robinhood.com';
const TIMEOUT_MS = 10_000;

export function robinhoodCredentials(): { apiKey: string; privateKeyBase64: string } | undefined {
  const apiKey = process.env.ROBINHOOD_API_KEY?.trim();
  const privateKeyBase64 = process.env.ROBINHOOD_PRIVATE_KEY?.trim();
  return apiKey && privateKeyBase64 ? { apiKey, privateKeyBase64 } : undefined;
}

/**
 * Robinhood signs `apiKey + timestamp + path + method + body` with Ed25519. The message is a bare
 * concatenation, so the path must include its query string exactly as sent and the body must be the
 * exact serialized bytes — re-serializing after signing invalidates the signature.
 */
export function robinhoodSigningMessage(input: {
  apiKey: string; timestamp: number; path: string; method: string; body?: string;
}): string {
  return `${input.apiKey}${input.timestamp}${input.path}${input.method}${input.body ?? ''}`;
}

/**
 * Accepts a raw 32-byte Ed25519 seed in base64, which is what Robinhood's key generator emits, and wraps
 * it in the PKCS#8 structure node's crypto requires. Doing this by hand avoids asking the operator to
 * convert key formats, which is where a mis-signed request usually originates.
 */
export function robinhoodPrivateKey(privateKeyBase64: string) {
  const decoded = Buffer.from(privateKeyBase64, 'base64');
  // Some tools emit the 64-byte seed+public concatenation; Ed25519 only needs the leading 32-byte seed.
  const seed = decoded.length >= 32 ? decoded.subarray(0, 32) : decoded;
  if (seed.length !== 32) throw new Error('ROBINHOOD_PRIVATE_KEY must decode to at least a 32-byte Ed25519 seed.');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

export function robinhoodSignature(input: {
  apiKey: string; privateKeyBase64: string; timestamp: number; path: string; method: string; body?: string;
}): string {
  const message = robinhoodSigningMessage(input);
  return cryptoSign(null, Buffer.from(message, 'utf8'), robinhoodPrivateKey(input.privateKeyBase64)).toString('base64');
}

async function signedGet<T>(path: string): Promise<T> {
  const credentials = robinhoodCredentials();
  if (!credentials) throw new Error('Robinhood API credentials are not configured.');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = robinhoodSignature({ ...credentials, timestamp, path, method: 'GET' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET', signal: controller.signal,
      headers: {
        'x-api-key': credentials.apiKey,
        'x-timestamp': String(timestamp),
        'x-signature': signature,
        accept: 'application/json',
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Robinhood ${path} failed: ${response.status} ${text.slice(0, 160)}`);
    return JSON.parse(text) as T;
  } finally { clearTimeout(timer); }
}

interface RobinhoodAccount { account_number?: string; buying_power?: string; buying_power_currency?: string }
interface RobinhoodHoldings { results?: Array<{ asset_code?: string; total_quantity?: string; quantity_available_for_trading?: string }> }

/**
 * Read-only account snapshot. Deliberately no order path: Robinhood has no event-contract API and its
 * crypto trading is not a promoted capability, so placing an order from here would exceed what the
 * registry grants for every market.
 */
export async function getRobinhoodAccount(): Promise<VenueAccount> {
  if (!robinhoodCredentials()) {
    return {
      venue: 'robinhood', configured: false, connected: false, tradeAuthenticated: false,
      positions: [], openOrders: 0,
      error: 'Set ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY (base64 Ed25519 seed) to read this account.',
    };
  }
  try {
    const [account, holdings] = await Promise.all([
      signedGet<RobinhoodAccount>('/api/v1/crypto/trading/accounts/'),
      signedGet<RobinhoodHoldings>('/api/v1/crypto/trading/holdings/'),
    ]);
    const positions: AccountPosition[] = (holdings.results ?? [])
      .filter((item) => Number(item.total_quantity ?? 0) !== 0)
      .map((item) => ({
        venue: 'robinhood', id: item.asset_code ?? 'unknown', title: item.asset_code ?? 'unknown',
        side: 'spot', size: Number(item.total_quantity ?? 0), averagePrice: 0, currentPrice: 0,
        currentValue: 0, pnl: 0,
      }));
    return {
      venue: 'robinhood', configured: true, connected: true, tradeAuthenticated: false,
      balance: Number(account.buying_power ?? 0), positions, openOrders: 0,
    };
  } catch (error) {
    return {
      venue: 'robinhood', configured: true, connected: false, tradeAuthenticated: false,
      positions: [], openOrders: 0,
      error: error instanceof Error ? error.message : 'Robinhood connection failed',
    };
  }
}
