import { describe, expect, it } from 'vitest';
import {
  migrateLegacyVenueAuthority, normalizeTradingProviderConfiguration, updateTradingProviderConfiguration,
} from './trading-provider-config-store';

describe('durable trading-provider configuration', () => {
  it('normalizes all providers and fails closed for unsupported capabilities', () => {
    const configuration = normalizeTradingProviderConfiguration({
      executionAuthority: 'provider-registry-v1',
      providers: [{
        providerId: 'robinhood', researchEnabled: true, paperEnabled: true, liveEnabled: true,
        selectedVariantId: 'malicious-variant', updatedAt: '2026-08-12T00:00:00.000Z',
      }],
    });
    expect(configuration.providers).toHaveLength(5);
    expect(configuration.providers.find((item) => item.providerId === 'robinhood')).toMatchObject({
      researchEnabled: false, paperEnabled: false, liveEnabled: false,
      selectedVariantId: 'robinhood-event-contract-v1',
    });
  });

  it('migrates the legacy Budget authority exactly once without enabling another provider', () => {
    const stored = normalizeTradingProviderConfiguration({});
    const { configuration, changed } = migrateLegacyVenueAuthority(stored, ['kalshi'], '2026-08-12T01:00:00.000Z');
    expect(changed).toBe(true);
    expect(configuration.executionAuthority).toBe('provider-registry-v1');
    expect(configuration.providers.find((item) => item.providerId === 'kalshi')).toMatchObject({ paperEnabled: true, liveEnabled: true });
    expect(configuration.providers.find((item) => item.providerId === 'polymarket')).toMatchObject({ paperEnabled: false, liveEnabled: false });
    expect(configuration.providers.find((item) => item.providerId === 'crypto-com')).toMatchObject({ paperEnabled: false, liveEnabled: false });
    expect(configuration.audit.some((item) => item.action === 'migrated')).toBe(true);
    const twice = migrateLegacyVenueAuthority(configuration, ['polymarket'], '2026-08-12T02:00:00.000Z');
    expect(twice.changed).toBe(false);
    expect(twice.configuration.providers.find((item) => item.providerId === 'kalshi')?.liveEnabled).toBe(true);
  });

  it('rejects unsupported live capabilities before persistence', async () => {
    await expect(updateTradingProviderConfiguration({
      providerId: 'robinhood', liveEnabled: true, reason: 'test',
    }, ['kalshi'])).rejects.toThrow('robinhood live trading is not implemented or promoted');
  });
});
