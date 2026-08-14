import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { assetAdmitted, DEFAULT_EXCLUDED_ASSETS, excludedAssets } from './asset-exclusion';

afterEach(() => { delete process.env.MONEY_NOODLE_EXCLUDED_ASSETS; });

describe('asset exclusion', () => {
  it('withholds only XRP by default, the one asset clearing two standard errors on both tracks', () => {
    expect(DEFAULT_EXCLUDED_ASSETS).toEqual(['XRP']);
    expect(assetAdmitted('XRP')).toBe(false);
    for (const symbol of ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE']) {
      expect(assetAdmitted(symbol)).toBe(true);
    }
  });

  it('applies one list to both tracks, so the paper mirror cannot buy what live withholds', () => {
    // Deliberately no per-track argument: the exclusion is part of the policy, and paper runs the
    // policy live runs. Continuing to measure a withheld asset belongs in the evaluation lane.
    expect(excludedAssets()).toEqual(['XRP']);
    expect(assetAdmitted.length).toBe(1);
  });

  it('is case-insensitive, since a symbol casing difference must not silently re-admit an asset', () => {
    expect(assetAdmitted('xrp')).toBe(false);
    process.env.MONEY_NOODLE_EXCLUDED_ASSETS = 'sol';
    expect(assetAdmitted('SOL')).toBe(false);
  });

  it('can be reconfigured or emptied without a code change', () => {
    process.env.MONEY_NOODLE_EXCLUDED_ASSETS = 'SOL,ETH';
    expect(assetAdmitted('XRP')).toBe(true);
    expect(assetAdmitted('SOL')).toBe(false);
    process.env.MONEY_NOODLE_EXCLUDED_ASSETS = '';
    expect(assetAdmitted('XRP')).toBe(true);
  });
});
