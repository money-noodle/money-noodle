import 'server-only';

import { cryptoAssetsForMarket, type CryptoAssetDescriptor } from './asset-registry';
import { realizedVolatility } from './basis-model';
import { createContractProvenance } from './contract-provenance';
import {
  HOURLY_THRESHOLD_MARKET_DATA_VERSION, HOURLY_THRESHOLD_MODEL_VERSION,
  hourlyThresholdProbability, selectCurrentHourlyThresholdGroup,
  type KalshiThresholdMarketRow,
} from './hourly-threshold-market';
import type { HourlyThresholdMarket, HourlyThresholdMarketsResponse } from './types';

const REQUEST_TIMEOUT_MS = 4_000;
const CACHE_MS = 60_000;
const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
let cached: { expiresAt: number; response: HourlyThresholdMarketsResponse } | undefined;
let inFlight: Promise<HourlyThresholdMarketsResponse> | undefined;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.2 hourly-research' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).hostname}`);
  return response.json() as Promise<T>;
}

async function fetchThresholdRows(asset: CryptoAssetDescriptor, nowMs: number): Promise<KalshiThresholdMarketRow[]> {
  const url = new URL(`${KALSHI_BASE_URL}/markets`);
  url.searchParams.set('limit', '1000');
  url.searchParams.set('status', 'open');
  url.searchParams.set('series_ticker', asset.kalshiHourlySeries);
  url.searchParams.set('min_close_ts', String(Math.floor(nowMs / 1_000)));
  url.searchParams.set('max_close_ts', String(Math.floor(nowMs / 1_000) + 3_600));
  const payload = await fetchJson<{ markets?: KalshiThresholdMarketRow[]; cursor?: string }>(url.toString());
  if (payload.cursor) throw new Error('Hourly listing exceeded the bounded 1,000-row page.');
  return Array.isArray(payload.markets) ? payload.markets : [];
}

async function fetchHourlyPriceSeries(asset: CryptoAssetDescriptor): Promise<{
  currentPrice: number;
  volatilityPerSecond: number;
  volatilitySamples: number;
} | undefined> {
  const payload = await fetchJson<{
    error?: string[];
    result?: Record<string, Array<Array<number | string>> | number>;
  }>(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(asset.krakenPair)}&interval=1`);
  if (payload.error?.length || !payload.result) return undefined;
  const rows = Object.entries(payload.result).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1];
  if (!Array.isArray(rows)) return undefined;
  const closes = rows.slice(-121).map((row) => Number(row[4])).filter((price) => Number.isFinite(price) && price > 0);
  const currentPrice = closes.at(-1);
  const volatility = realizedVolatility(closes, 60);
  if (!currentPrice || !volatility) return undefined;
  return { currentPrice, volatilityPerSecond: volatility.perSecond, volatilitySamples: volatility.samples };
}

async function buildMarket(asset: CryptoAssetDescriptor, nowMs: number, capturedAt: string): Promise<HourlyThresholdMarket> {
  let rows: KalshiThresholdMarketRow[];
  try {
    rows = await fetchThresholdRows(asset, nowMs);
  } catch (error) {
    return {
      marketId: 'crypto-1h', providerId: 'kalshi', symbol: asset.symbol, name: asset.name,
      marketDataAvailable: false, candidates: [],
      unavailableReason: error instanceof Error ? error.message : 'Kalshi hourly listing unavailable.',
    };
  }
  const group = selectCurrentHourlyThresholdGroup(rows, nowMs);
  if (!group.candidates.length) return {
    marketId: 'crypto-1h', providerId: 'kalshi', symbol: asset.symbol, name: asset.name,
    marketDataAvailable: false, openAt: group.openAt, closesAt: group.closesAt,
    candidates: [], unavailableReason: group.unavailableReason,
  };

  const price = await fetchHourlyPriceSeries(asset).catch(() => undefined);
  const secondsRemaining = group.closesAt ? Math.max(0, (Date.parse(group.closesAt) - nowMs) / 1_000) : 0;
  const candidates = group.candidates.map((item) => {
    const marketUrl = `https://kalshi.com/markets/${asset.kalshiHourlySeries.toLowerCase()}`;
    const contract = createContractProvenance({
      venue: 'kalshi', contractId: item.ticker, marketUrl, closesAt: group.closesAt!, capturedAt,
      rulesSource: `${KALSHI_BASE_URL}/markets/${item.ticker}`,
      rulesText: item.rulesText,
      referenceSource: 'CF Benchmarks RTI 60-second simple average', referenceValue: item.strike,
      settlementWindowSeconds: 60, comparability: 'exact',
    });
    const modelProbabilityYes = price ? hourlyThresholdProbability({
      direction: item.direction, strike: item.strike, currentPrice: price.currentPrice,
      secondsRemaining, volatilityPerSecond: price.volatilityPerSecond,
    }) : undefined;
    return {
      direction: item.direction, displaySide: item.displaySide, ticker: item.ticker,
      strike: item.strike, relation: item.relation, label: item.label,
      yesBid: item.yesBid, yesAsk: item.yesAsk, noBid: item.noBid, noAsk: item.noAsk,
      modelProbabilityYes,
      modelMinusAsk: modelProbabilityYes !== undefined && item.yesAsk !== undefined
        ? modelProbabilityYes - item.yesAsk : undefined,
      modelUnavailableReason: modelProbabilityYes === undefined ? 'Kraken one-minute volatility unavailable.' : undefined,
      rulesFingerprint: contract.rulesFingerprint,
      marketUrl,
    };
  });
  return {
    marketId: 'crypto-1h', providerId: 'kalshi', symbol: asset.symbol, name: asset.name,
    marketDataAvailable: group.complete, openAt: group.openAt, closesAt: group.closesAt,
    currentPrice: price?.currentPrice, volatilityPerSecond: price?.volatilityPerSecond,
    volatilitySamples: price?.volatilitySamples,
    candidates,
    unavailableReason: group.unavailableReason,
  };
}

async function buildHourlyThresholdMarkets(nowMs = Date.now()): Promise<HourlyThresholdMarketsResponse> {
  const generatedAt = new Date(nowMs).toISOString();
  const markets = await Promise.all(
    cryptoAssetsForMarket('crypto-1h').map((asset) => buildMarket(asset, nowMs, generatedAt)),
  );
  return {
    generatedAt,
    expiresAt: new Date(nowMs + CACHE_MS).toISOString(),
    marketId: 'crypto-1h', providerId: 'kalshi',
    marketDataVersion: HOURLY_THRESHOLD_MARKET_DATA_VERSION,
    modelVersion: HOURLY_THRESHOLD_MODEL_VERSION,
    capability: { marketData: true, paper: false, live: false },
    markets,
  };
}

/** Process-memory cache only: H1 has no durable writer and stateless hosts remain safe. */
export async function getHourlyThresholdMarkets(force = false): Promise<HourlyThresholdMarketsResponse> {
  const nowMs = Date.now();
  if (!force && cached && cached.expiresAt > nowMs) return cached.response;
  if (inFlight) return inFlight;
  const operation = buildHourlyThresholdMarkets(nowMs).then((response) => {
    cached = { expiresAt: Date.parse(response.expiresAt), response };
    return response;
  }).finally(() => { if (inFlight === operation) inFlight = undefined; });
  inFlight = operation;
  return operation;
}
