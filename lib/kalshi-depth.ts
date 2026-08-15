import 'server-only';
import { parseKalshiOrderBook } from './order-book-depth';
import type { BinaryOrderBook } from './types';

const books = new Map<string, BinaryOrderBook>();
const inFlight = new Map<string, Promise<void>>();
const FRESH_MS = 10_000;

/** Exact public depth read for execution simulation. Unlike `observeKalshiOrderBook`, this is awaited. */
export async function fetchKalshiOrderBookNow(ticker: string): Promise<BinaryOrderBook | undefined> {
  const base = (process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const response = await fetch(`${base}/markets/${encodeURIComponent(ticker)}/orderbook?depth=20`, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.2 local-research' },
    signal: AbortSignal.timeout(2_500), cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Kalshi order book returned ${response.status}.`);
  const parsed = parseKalshiOrderBook(await response.json(), new Date().toISOString());
  if (parsed) books.set(ticker, parsed);
  return parsed;
}

/**
 * Returns the latest fresh depth immediately and refreshes in the background when needed.
 * It never awaits on a dashboard calculation, order-management poll, or exit decision.
 */
export function observeKalshiOrderBook(ticker: string, nowMs = Date.now()): BinaryOrderBook | undefined {
  const current = books.get(ticker);
  if ((!current || nowMs - Date.parse(current.observedAt) > FRESH_MS) && !inFlight.has(ticker)) {
    const request = fetchKalshiOrderBookNow(ticker)
      .catch(() => undefined).then(() => undefined).finally(() => { inFlight.delete(ticker); });
    inFlight.set(ticker, request);
  }
  return current && nowMs - Date.parse(current.observedAt) <= 30_000 ? current : undefined;
}
