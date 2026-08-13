import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { assetAdmitted, DEFAULT_LIVE_EXCLUDED_ASSETS, excludedAssets } from './asset-exclusion';

afterEach(() => {
  delete process.env.MONEY_NOODLE_LIVE_EXCLUDED_ASSETS;
  delete process.env.MONEY_NOODLE_PAPER_EXCLUDED_ASSETS;
});

describe('asset exclusion', () => {
  it('withholds only XRP by default, the one asset clearing two standard errors on both tracks', () => {
    expect(DEFAULT_LIVE_EXCLUDED_ASSETS).toEqual(['XRP']);
    expect(assetAdmitted('XRP', 'live')).toBe(false);
    for (const symbol of ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE']) {
      expect(assetAdmitted(symbol, 'live')).toBe(true);
    }
  });

  it('keeps paper trading the excluded asset, so measurement continues after real money stops', () => {
    expect(assetAdmitted('XRP', 'paper')).toBe(true);
    expect(excludedAssets('paper')).toEqual([]);
  });

  it('defaults an unspecified mode to live, so a forgotten argument cannot loosen the gate', () => {
    expect(assetAdmitted('XRP')).toBe(false);
  });

  it('is case-insensitive, since a symbol casing difference must not silently re-admit an asset', () => {
    expect(assetAdmitted('xrp', 'live')).toBe(false);
    process.env.MONEY_NOODLE_LIVE_EXCLUDED_ASSETS = 'sol';
    expect(assetAdmitted('SOL', 'live')).toBe(false);
  });

  it('can be reconfigured or emptied without a code change', () => {
    process.env.MONEY_NOODLE_LIVE_EXCLUDED_ASSETS = 'SOL,ETH';
    expect(assetAdmitted('XRP', 'live')).toBe(true);
    expect(assetAdmitted('SOL', 'live')).toBe(false);
    process.env.MONEY_NOODLE_LIVE_EXCLUDED_ASSETS = '';
    expect(assetAdmitted('XRP', 'live')).toBe(true);
  });

  it('lets paper exclusions be set independently when wanted', () => {
    process.env.MONEY_NOODLE_PAPER_EXCLUDED_ASSETS = 'XRP';
    expect(assetAdmitted('XRP', 'paper')).toBe(false);
    expect(assetAdmitted('XRP', 'live')).toBe(false);
  });
});
