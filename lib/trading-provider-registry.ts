import { productionMarketCapability, providerMarketCapabilities } from './market-registry';
import type { TradingProviderConfiguration, TradingProviderDescriptor, TradingProviderId, TradingProviderVariant } from './types';

const variant = (
  id: string,
  providerId: TradingProviderId,
  name: string,
  status: TradingProviderVariant['status'],
  description: string,
): TradingProviderVariant => ({
  id,
  providerId,
  name,
  status,
  forecastModelVersion: 'Blend 0.4',
  description,
});

/** Capability is not declared here: it lives once in the market registry, per (provider, market) pair. */
const DEFINITIONS: Array<Omit<TradingProviderDescriptor, 'researchEnabled' | 'paperEnabled' | 'liveEnabled' | 'selectedVariantId' | 'configurationUpdatedAt' | 'capabilities' | 'marketCapabilities'>> = [
  {
    id: 'polymarket', name: 'Polymarket', implementation: 'read-paper', adapterVersion: 'polymarket-adapter-v1',
    readiness: 'Public Gamma/CLOB reads and paper settlement are available; private live fill reconciliation is not promoted.',
    variants: [variant('polymarket-clob-contract-v1', 'polymarket', 'CLOB contract semantics v1', 'active', 'Exact outcome-token books, proportional fee estimate, whole-contract paper sizing, and Polymarket-specific resolution.')],
  },
  {
    id: 'kalshi', name: 'Kalshi', implementation: 'live', adapterVersion: 'kalshi-adapter-v1',
    readiness: 'Signed account, maker placement, cancellation, fills, positions, cash, and authoritative reconciliation are implemented.',
    variants: [variant('kalshi-15m-maker-v1', 'kalshi', '15-minute managed maker v1', 'active', 'Kalshi ticker semantics, fractional quantity, quadratic fee model, managed post-only maker execution, and exact Kalshi settlement.')],
  },
  {
    id: 'crypto-com', name: 'Crypto.com', implementation: 'planned', adapterVersion: 'unimplemented',
    readiness: 'Event contracts verified not viable: Strike Options has no programmatic interface, no order book, and non-comparable settlement. The supported spot/perpetual API belongs to a future market.',
    variants: [variant('crypto-com-event-contract-v1', 'crypto-com', 'Event contract semantics v1', 'planned', 'Placeholder identity for official contract rules, fees, quote normalization, paper fills, and reconciliation after API verification.')],
  },
  {
    id: 'forecastex', name: 'ForecastEx', implementation: 'planned', adapterVersion: 'unimplemented',
    readiness: 'Awaiting official exchange/broker API, eligibility, rules, fee, and account-lifecycle verification.',
    variants: [variant('forecastex-contract-v1', 'forecastex', 'Exchange contract semantics v1', 'planned', 'Placeholder identity for ForecastEx contract and authorized-broker normalization after official interface verification.')],
  },
  {
    id: 'robinhood', name: 'Robinhood', implementation: 'planned', adapterVersion: 'unimplemented',
    readiness: 'Awaiting an official event-contract API with authoritative order, fill, position, and account support.',
    variants: [variant('robinhood-event-contract-v1', 'robinhood', 'Broker event contract semantics v1', 'planned', 'Placeholder identity for Robinhood event-contract rules and execution after official API verification.')],
  },
];

/**
 * Capability registry joined to durable configuration. The store already projects the legacy Budget
 * authority; this layer intersects requested state with implemented capability one more time so
 * unsupported providers cannot be enabled by malformed or future configuration.
 */
export function tradingProviderRegistry(configuration: TradingProviderConfiguration): TradingProviderDescriptor[] {
  const configured = new Map(configuration.providers.map((item) => [item.providerId, item]));
  return DEFINITIONS.map((provider) => {
    const state = configured.get(provider.id);
    const selectedVariantId = provider.variants.some((item) => item.id === state?.selectedVariantId)
      ? state!.selectedVariantId : provider.variants[0].id;
    // Gated by the production market, not a union: every consumer of these provider-level flags operates
    // on crypto-15m, so a capability earned on another market must not unlock them here. Per-market
    // decisions read `marketCapabilities`.
    const capabilities = productionMarketCapability(provider.id);
    return {
      ...provider,
      capabilities,
      marketCapabilities: providerMarketCapabilities(provider.id),
      researchEnabled: capabilities.marketData && state?.researchEnabled === true,
      paperEnabled: capabilities.paper && state?.paperEnabled === true,
      liveEnabled: capabilities.live && state?.liveEnabled === true,
      selectedVariantId,
      configurationUpdatedAt: state?.updatedAt ?? configuration.updatedAt,
      variants: provider.variants.map((item) => ({ ...item })),
    };
  });
}
