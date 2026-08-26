import { describe, expect, it } from 'vitest';
import { adapterSupports, assertAdapterCapability, type TradingProviderAdapter } from './trading-provider-adapter';

const adapter: TradingProviderAdapter = {
  providerId: 'crypto-com', adapterVersion: 'test-read-v1', capabilities: new Set(['market-data']),
  async listContracts() { return []; },
  async getQuote() { return null; },
  async getOutcome() { return null; },
};

describe('normalized trading-provider adapter', () => {
  it('exposes explicit capabilities instead of inferring live readiness from reads', () => {
    expect(adapterSupports(adapter, 'market-data')).toBe(true);
    expect(adapterSupports(adapter, 'live-order')).toBe(false);
    expect(() => assertAdapterCapability(adapter, 'live-order')).toThrow('crypto-com adapter test-read-v1 does not support live-order');
  });
});
