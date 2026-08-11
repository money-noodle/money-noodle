import { describe, expect, it } from 'vitest';
import { ASSETS, kalshiSeriesTicker, selectAlignedKalshiMarket, type KalshiMarket } from './feeds';

describe('Kalshi 15-minute series discovery', () => {
  it('derives a series for every dashboard asset, including BNB and HYPE', () => {
    const series = Object.fromEntries(ASSETS.map((asset) => [asset.symbol, kalshiSeriesTicker(asset.symbol)]));
    expect(series.BNB).toBe('KXBNB15M');
    expect(series.HYPE).toBe('KXHYPE15M');
    expect(Object.keys(series)).toHaveLength(ASSETS.length);
  });

  it('rejects a still-active prior-window market at the settlement boundary', () => {
    const row = (ticker: string, close_time: string): KalshiMarket => ({
      ticker, close_time, status: 'active', yes_bid_dollars: '0.4', yes_ask_dollars: '0.5',
      no_bid_dollars: '0.5', no_ask_dollars: '0.6', last_price_dollars: '0.45',
      liquidity_dollars: '10', volume_fp: '10',
    });
    const now = Date.parse('2026-01-01T00:15:01Z');
    const selected = selectAlignedKalshiMarket([
      row('PRIOR', '2026-01-01T00:15:00Z'),
      row('CURRENT', '2026-01-01T00:30:00Z'),
    ], now);
    expect(selected?.ticker).toBe('CURRENT');
  });

  it('fails closed when no Kalshi close aligns with the active quarter-hour window', () => {
    const now = Date.parse('2026-01-01T00:15:01Z');
    const offCycle = {
      ticker: 'OFF', close_time: '2026-01-01T00:31:00Z', status: 'active',
      yes_bid_dollars: '0.4', yes_ask_dollars: '0.5', no_bid_dollars: '0.5', no_ask_dollars: '0.6',
      last_price_dollars: '0.45', liquidity_dollars: '10', volume_fp: '10',
    } satisfies KalshiMarket;
    expect(selectAlignedKalshiMarket([offCycle], now)).toBeUndefined();
  });
});
