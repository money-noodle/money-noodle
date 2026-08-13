import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  CRYPTO_15M, DEFAULT_MARKET_ID, MARKETS, isMarketId, marketDescriptor, marketProviders,
  normalizeMarketId, providerCapabilityUnion, providerMarketCapability, providerMarketCapabilities,
} from './market-registry';
import { tradingProviderRegistry } from './trading-provider-registry';
import { TRADING_PROVIDER_IDS } from './trading-provider-config-store';
import type { TradingProviderConfiguration } from './types';

function configuration(overrides: Partial<TradingProviderConfiguration['providers'][number]>[] = []): TradingProviderConfiguration {
  return {
    version: 'trading-provider-config-v1', revision: 1, updatedAt: '2026-08-13T00:00:00.000Z',
    executionAuthority: 'provider-registry-v1', audit: [],
    providers: TRADING_PROVIDER_IDS.map((providerId) => ({
      providerId, researchEnabled: true, paperEnabled: true, liveEnabled: true,
      selectedVariantId: `${providerId}-x`, updatedAt: '2026-08-13T00:00:00.000Z',
      ...overrides.find((item) => item.providerId === providerId),
    })),
  } as TradingProviderConfiguration;
}

describe('market registry', () => {
  it('declares exactly one market today, and names it rather than implying it', () => {
    expect(MARKETS.map((market) => market.id)).toEqual([CRYPTO_15M]);
    expect(DEFAULT_MARKET_ID).toBe(CRYPTO_15M);
    expect(marketDescriptor(CRYPTO_15M).horizonSeconds).toBe(900);
  });

  it('treats records written before markets were explicit as belonging to crypto-15m', () => {
    expect(normalizeMarketId(undefined)).toBe(CRYPTO_15M);
    expect(normalizeMarketId('not-a-market')).toBe(CRYPTO_15M);
    expect(normalizeMarketId(CRYPTO_15M)).toBe(CRYPTO_15M);
    expect(isMarketId('crypto-spot')).toBe(false);
  });

  it('declares capability per provider and market pair, not per provider', () => {
    expect(providerMarketCapability('kalshi', CRYPTO_15M)).toMatchObject({ marketData: true, paper: true, live: true });
    expect(providerMarketCapability('polymarket', CRYPTO_15M)).toMatchObject({ paper: true, live: false });
    expect(marketProviders(CRYPTO_15M)).toEqual(TRADING_PROVIDER_IDS);
  });

  it('keeps Crypto.com incapable on crypto-15m and explains why', () => {
    const capability = providerMarketCapability('crypto-com', CRYPTO_15M);
    expect(capability).toMatchObject({ marketData: false, paper: false, live: false });
    // The verified reason must travel with the flag; a disabled control should never be unexplained.
    expect(capability!.readiness).toMatch(/no programmatic interface|not viable/i);
  });

  it('exposes an unmodifiable view so a caller cannot mutate declared capability', () => {
    const [capability] = providerMarketCapabilities('kalshi');
    capability.live = false;
    expect(providerMarketCapability('kalshi', CRYPTO_15M)!.live).toBe(true);
  });
});

describe('provider registry capability derivation', () => {
  it('derives provider capability from the market registry instead of a second table', () => {
    const registry = tradingProviderRegistry(configuration());
    for (const provider of registry) {
      expect(provider.capabilities).toEqual(providerCapabilityUnion(provider.id));
      expect(provider.marketCapabilities).toEqual(providerMarketCapabilities(provider.id));
    }
  });

  it('still fails closed for a provider that configuration tries to enable beyond its capability', () => {
    const registry = tradingProviderRegistry(configuration());
    const cryptoCom = registry.find((provider) => provider.id === 'crypto-com')!;
    expect(cryptoCom.researchEnabled).toBe(false);
    expect(cryptoCom.paperEnabled).toBe(false);
    expect(cryptoCom.liveEnabled).toBe(false);
    const polymarket = registry.find((provider) => provider.id === 'polymarket')!;
    expect(polymarket.paperEnabled).toBe(true);
    expect(polymarket.liveEnabled).toBe(false);
  });
});
