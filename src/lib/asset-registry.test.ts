import { describe, expect, it } from 'vitest';
import { CRYPTO_ASSETS, cryptoAsset, cryptoAssetsForMarket } from './asset-registry';

describe('market-specific crypto asset membership', () => {
  it('adds hourly subjects without widening the funded 15m venue loop', () => {
    expect(cryptoAssetsForMarket('crypto-15m').map((asset) => asset.symbol))
      .toEqual(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']);
    expect(cryptoAssetsForMarket('crypto-1h').map((asset) => asset.symbol))
      .toEqual(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'TON', 'NEAR', 'ZEC']);
  });

  it('owns exact provider/reference mappings once', () => {
    expect(CRYPTO_ASSETS).toHaveLength(10);
    expect(cryptoAsset('XRP')).toMatchObject({ kalshi15mSeries: 'KXXRP15M', kalshiHourlySeries: 'KXXRP' });
    expect(cryptoAsset('TON')).toMatchObject({ krakenPair: 'TONUSD', kalshiHourlySeries: 'KXTON' });
    expect(cryptoAsset('UNKNOWN')).toBeUndefined();
  });
});
