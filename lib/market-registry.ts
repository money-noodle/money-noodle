import type { MarketDescriptor, MarketId, ProviderMarketCapability, TradingProviderId } from './types';

/**
 * The only market in production. Named rather than implied so a second market is an addition here plus a
 * calibration, not a rewrite of every budget, order, and summary that currently assumes 15-minute crypto.
 */
export const CRYPTO_15M: MarketId = 'crypto-15m';

/** Default carried by records written before markets were explicit, and by every current write. */
export const DEFAULT_MARKET_ID: MarketId = CRYPTO_15M;

export const MARKETS: MarketDescriptor[] = [
  {
    id: 'crypto-15m',
    name: 'Crypto 15-minute Up/Down',
    instrument: 'binary-event-contract',
    horizonSeconds: 900,
    settlementBasis: 'Settlement price versus the cycle-open reference for the same asset and window.',
    description: 'Binary Up/Down contracts on 15-minute crypto windows, compared across providers only when contract rules are exactly or approximately comparable.',
  },
];

export function marketDescriptor(marketId: MarketId): MarketDescriptor {
  const found = MARKETS.find((market) => market.id === marketId);
  // Unreachable for a typed MarketId; the throw keeps a malformed durable record from being treated as
  // a valid market rather than silently defaulting to the only one that exists.
  if (!found) throw new Error(`Unknown market ${marketId}.`);
  return found;
}

export function isMarketId(value: unknown): value is MarketId {
  return typeof value === 'string' && MARKETS.some((market) => market.id === value);
}

/** Durable records predating explicit markets belong to the market that existed when they were written. */
export function normalizeMarketId(value: unknown): MarketId {
  return isMarketId(value) ? value : DEFAULT_MARKET_ID;
}

/**
 * Per-(provider, market) capability. A provider absent from a market's list has no capability there at
 * all, which is the normal case: support is the exception that must be declared, never assumed.
 */
const CAPABILITIES: ProviderMarketCapability[] = [
  {
    providerId: 'polymarket', marketId: 'crypto-15m', marketData: true, paper: true, live: false,
    readiness: 'Public Gamma/CLOB reads and paper settlement are available; private live fill reconciliation is not promoted.',
  },
  {
    providerId: 'kalshi', marketId: 'crypto-15m', marketData: true, paper: true, live: true,
    readiness: 'Signed account, maker placement, cancellation, fills, positions, cash, and authoritative reconciliation are implemented.',
  },
  {
    providerId: 'crypto-com', marketId: 'crypto-15m', marketData: false, paper: false, live: false,
    readiness: 'Not viable: Strike Options has no programmatic interface, no order book, 5/20-minute rather than 15-minute durations, and settles on CDNA’s own index against a predetermined strike. Its API trades spot and perpetuals, which belong to a future market.',
  },
  {
    providerId: 'forecastex', marketId: 'crypto-15m', marketData: false, paper: false, live: false,
    readiness: 'Awaiting official exchange/broker API, eligibility, rules, fee, and account-lifecycle verification.',
  },
  {
    providerId: 'robinhood', marketId: 'crypto-15m', marketData: false, paper: false, live: false,
    readiness: 'Awaiting an official event-contract API with authoritative order, fill, position, and account support.',
  },
];

export function providerMarketCapabilities(providerId: TradingProviderId): ProviderMarketCapability[] {
  return CAPABILITIES.filter((item) => item.providerId === providerId).map((item) => ({ ...item }));
}

export function providerMarketCapability(providerId: TradingProviderId, marketId: MarketId): ProviderMarketCapability | undefined {
  const found = CAPABILITIES.find((item) => item.providerId === providerId && item.marketId === marketId);
  return found ? { ...found } : undefined;
}

/** Providers declared for a market, whether or not they are currently capable or enabled. */
export function marketProviders(marketId: MarketId): TradingProviderId[] {
  return CAPABILITIES.filter((item) => item.marketId === marketId).map((item) => item.providerId);
}

/**
 * Union across a provider's markets. Convenience for provider-level display only; a funding, paper, or
 * live decision must consult the specific (provider, market) pair instead.
 */
export function providerCapabilityUnion(providerId: TradingProviderId): { marketData: boolean; paper: boolean; live: boolean } {
  const own = CAPABILITIES.filter((item) => item.providerId === providerId);
  return {
    marketData: own.some((item) => item.marketData),
    paper: own.some((item) => item.paper),
    live: own.some((item) => item.live),
  };
}
