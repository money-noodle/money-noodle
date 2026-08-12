import { describe, expect, it } from 'vitest';
import { activePolicyManifest } from './policy-manifest';
import { BUY_POLICY_VERSION } from './prediction-policy';
import { tradingProviderRegistry } from './trading-provider-registry';
import type { TradingProviderConfiguration } from './types';

const configuration = (enabled: Array<'polymarket' | 'kalshi'>): TradingProviderConfiguration => {
  const at = '2026-08-12T00:00:00.000Z';
  const variant = {
    polymarket: 'polymarket-clob-contract-v1', kalshi: 'kalshi-15m-maker-v1',
    'crypto-com': 'crypto-com-event-contract-v1', forecastex: 'forecastex-contract-v1', robinhood: 'robinhood-event-contract-v1',
  } as const;
  return {
    version: 'trading-provider-config-v1', revision: 1, updatedAt: at, executionAuthority: 'provider-registry-v1', audit: [],
    providers: (Object.keys(variant) as Array<keyof typeof variant>).map((providerId) => ({
      providerId, researchEnabled: providerId === 'polymarket' || providerId === 'kalshi',
      paperEnabled: (providerId === 'polymarket' || providerId === 'kalshi') && enabled.includes(providerId),
      liveEnabled: providerId === 'kalshi' && enabled.includes('kalshi'), selectedVariantId: variant[providerId], updatedAt: at,
    })),
  };
};

describe('trading provider registry', () => {
  it('fails closed for planned providers and preserves independent Kalshi live enablement', () => {
    const providers = tradingProviderRegistry(configuration(['polymarket', 'kalshi']));
    expect(providers.map((provider) => provider.id)).toEqual(['polymarket', 'kalshi', 'crypto-com', 'forecastex', 'robinhood']);
    expect(providers.find((provider) => provider.id === 'kalshi')).toMatchObject({ paperEnabled: true, liveEnabled: true, adapterVersion: 'kalshi-adapter-v1' });
    expect(providers.find((provider) => provider.id === 'polymarket')).toMatchObject({ paperEnabled: true, liveEnabled: false });
    for (const id of ['crypto-com', 'forecastex', 'robinhood']) {
      expect(providers.find((provider) => provider.id === id)).toMatchObject({ implementation: 'planned', paperEnabled: false, liveEnabled: false });
    }
  });

  it('does not grant provider capability through a disabled legacy venue control', () => {
    const providers = tradingProviderRegistry(configuration(['polymarket']));
    expect(providers.find((provider) => provider.id === 'kalshi')).toMatchObject({ paperEnabled: false, liveEnabled: false });
  });

  it('publishes the active buy policy and immutable provider variant identities', () => {
    const providers = tradingProviderRegistry(configuration(['kalshi']));
    const manifest = activePolicyManifest(providers, 'Blend 0.4');
    expect(manifest.activeBuyPolicyVersion).toBe(BUY_POLICY_VERSION);
    expect(manifest.components.find((item) => item.kind === 'buy')?.details).toContainEqual({ label: 'Selected-side probability', value: '≥55%' });
    expect(manifest.components.find((item) => item.kind === 'provider')?.details).toHaveLength(5);
    expect(manifest.history[0]).toMatchObject({ version: BUY_POLICY_VERSION, status: 'active' });
  });
});
