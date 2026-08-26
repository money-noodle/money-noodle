import type { MarketId } from './types';

export interface CryptoAssetDescriptor {
  symbol: string;
  name: string;
  coinGeckoId: string;
  polymarketSlug?: string;
  krakenPair: string;
  krakenTickerKey: string;
  kalshi15mSeries?: string;
  kalshiHourlySeries: string;
}

/** Shared metadata is separate from market membership: adding an hourly subject must not widen the 15m venue loop. */
export const CRYPTO_ASSETS: readonly CryptoAssetDescriptor[] = [
  { symbol: 'BTC', name: 'Bitcoin', coinGeckoId: 'bitcoin', polymarketSlug: 'btc', krakenPair: 'XBTUSD', krakenTickerKey: 'XXBTZUSD', kalshi15mSeries: 'KXBTC15M', kalshiHourlySeries: 'KXBTC' },
  { symbol: 'ETH', name: 'Ethereum', coinGeckoId: 'ethereum', polymarketSlug: 'eth', krakenPair: 'ETHUSD', krakenTickerKey: 'XETHZUSD', kalshi15mSeries: 'KXETH15M', kalshiHourlySeries: 'KXETH' },
  { symbol: 'SOL', name: 'Solana', coinGeckoId: 'solana', polymarketSlug: 'sol', krakenPair: 'SOLUSD', krakenTickerKey: 'SOLUSD', kalshi15mSeries: 'KXSOL15M', kalshiHourlySeries: 'KXSOL' },
  { symbol: 'XRP', name: 'XRP', coinGeckoId: 'ripple', polymarketSlug: 'xrp', krakenPair: 'XRPUSD', krakenTickerKey: 'XXRPZUSD', kalshi15mSeries: 'KXXRP15M', kalshiHourlySeries: 'KXXRP' },
  { symbol: 'DOGE', name: 'Dogecoin', coinGeckoId: 'dogecoin', polymarketSlug: 'doge', krakenPair: 'DOGEUSD', krakenTickerKey: 'XDGUSD', kalshi15mSeries: 'KXDOGE15M', kalshiHourlySeries: 'KXDOGE' },
  { symbol: 'BNB', name: 'BNB', coinGeckoId: 'binancecoin', polymarketSlug: 'bnb', krakenPair: 'BNBUSD', krakenTickerKey: 'BNBUSD', kalshi15mSeries: 'KXBNB15M', kalshiHourlySeries: 'KXBNB' },
  { symbol: 'HYPE', name: 'Hyperliquid', coinGeckoId: 'hyperliquid', polymarketSlug: 'hype', krakenPair: 'HYPEUSD', krakenTickerKey: 'HYPEUSD', kalshi15mSeries: 'KXHYPE15M', kalshiHourlySeries: 'KXHYPE' },
  { symbol: 'TON', name: 'Toncoin', coinGeckoId: 'the-open-network', krakenPair: 'TONUSD', krakenTickerKey: 'TONUSD', kalshiHourlySeries: 'KXTON' },
  { symbol: 'NEAR', name: 'NEAR Protocol', coinGeckoId: 'near', krakenPair: 'NEARUSD', krakenTickerKey: 'NEARUSD', kalshiHourlySeries: 'KXNEAR' },
  { symbol: 'ZEC', name: 'Zcash', coinGeckoId: 'zcash', krakenPair: 'ZECUSD', krakenTickerKey: 'XZECZUSD', kalshiHourlySeries: 'KXZEC' },
];

const FIFTEEN_MINUTE_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']);

export function cryptoAssetsForMarket(marketId: Extract<MarketId, 'crypto-15m' | 'crypto-1h'>): readonly CryptoAssetDescriptor[] {
  return marketId === 'crypto-15m'
    ? CRYPTO_ASSETS.filter((asset) => FIFTEEN_MINUTE_SYMBOLS.has(asset.symbol))
    : CRYPTO_ASSETS;
}

export function cryptoAsset(symbol: string): CryptoAssetDescriptor | undefined {
  return CRYPTO_ASSETS.find((asset) => asset.symbol === symbol);
}
