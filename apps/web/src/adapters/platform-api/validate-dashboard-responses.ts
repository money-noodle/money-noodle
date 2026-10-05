// Is this answer the contract this site was generated against?
//
// The generated client gives static types; it does not check what arrived at runtime.
// These guards do, and deliberately at one level: the envelope, the discriminators the
// contract declares constant, the containers each view iterates, and the few figures a
// view would be wrong to render as a dash because they are the record's whole point.
//
// Everything deeper is read defensively at render time, where an absent or unusable
// leaf becomes a dash rather than a thrown render. That split is the proportionate one:
// a response that is not this contract is refused whole, and a response that is this
// contract but is missing an optional figure shows the figure as missing.
//
// `schemaVersion` is part of this: a future major version is refused rather than
// half-rendered, exactly as the status card already refuses one.

import type {
  HourlyThresholdMarkets,
  MarketOverview,
  PaperBudget,
  PaperPerformance,
  PaperPerformanceSummary,
} from '@money-noodle/platform-api-client';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const FEED_STATES = new Set(['fresh', 'stale', 'unavailable']);
const MARKET_FEEDS = [
  'spot',
  'polymarketQuotes',
  'kalshiQuotes',
  'referencePrices',
  'longHistory',
  'news',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): boolean {
  return typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

function isFinitePart(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The two members every response in this contract carries. */
function hasEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.schemaVersion === '1' &&
    typeof value.requestId === 'string' &&
    REQUEST_ID.test(value.requestId)
  );
}

/** A durable read-model record: published, and from the durable source. */
function isDurableRecord(value: unknown): value is Record<string, unknown> {
  return hasEnvelope(value) && value.durable === true;
}

function isFeedState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.state === 'string' &&
    FEED_STATES.has(value.state) &&
    isFinitePart(value.ageSeconds) &&
    (value.fetchedAt === undefined || isInstant(value.fetchedAt)) &&
    // A value is present exactly when the feed has one to publish.
    (value.state !== 'unavailable' || value.fetchedAt === undefined || isInstant(value.fetchedAt))
  );
}

export function isPaperBudget(value: unknown): value is PaperBudget {
  return (
    isDurableRecord(value) &&
    isInstant(value.sourceUpdatedAt) &&
    typeof value.running === 'boolean' &&
    typeof value.depleted === 'boolean' &&
    // The balances are the record. A record that cannot state them is not one.
    ['startingCents', 'availableCents', 'equityCents', 'reservedCents', 'realizedPnlCents'].every(
      (key) => isFinitePart(value[key]),
    ) &&
    Array.isArray(value.recentExecutions)
  );
}

export function isPaperPerformanceSummary(value: unknown): value is PaperPerformanceSummary {
  return (
    isDurableRecord(value) &&
    isInstant(value.generatedAt) &&
    isInstant(value.sourceUpdatedAt) &&
    isRecord(value.summary) &&
    isRecord(value.paperRecord) &&
    value.paperRecord.mode === 'paper'
  );
}

export function isPaperPerformance(value: unknown): value is PaperPerformance {
  return (
    isDurableRecord(value) &&
    isInstant(value.generatedAt) &&
    isInstant(value.sourceUpdatedAt) &&
    isRecord(value.summary) &&
    isRecord(value.paperRecord) &&
    value.paperRecord.mode === 'paper' &&
    Array.isArray(value.paperProviderRecords) &&
    Array.isArray(value.paperEpochs) &&
    Array.isArray(value.forecasts)
  );
}

export function isMarketOverview(value: unknown): value is MarketOverview {
  return (
    hasEnvelope(value) &&
    value.marketId === 'crypto-15m' &&
    isInstant(value.generatedAt) &&
    isRecord(value.feeds) &&
    // Every feed states its own freshness, so a response missing one of them cannot be
    // shown: a figure with no freshness beside it is the thing this page exists to avoid.
    MARKET_FEEDS.every((feed) => isFeedState((value.feeds as Record<string, unknown>)[feed])) &&
    Array.isArray(value.assets) &&
    Array.isArray(value.headlines)
  );
}

export function isHourlyThresholdMarkets(value: unknown): value is HourlyThresholdMarkets {
  return (
    hasEnvelope(value) &&
    value.marketId === 'crypto-1h' &&
    value.providerId === 'kalshi' &&
    isInstant(value.generatedAt) &&
    typeof value.referenceSource === 'string' &&
    isRecord(value.capability) &&
    // Observation only. A response claiming any other capability is refused rather than
    // rendered: this site has no signed-in area and no funded authority to present.
    value.capability.marketData === true &&
    value.capability.paper === false &&
    value.capability.live === false &&
    Array.isArray(value.markets)
  );
}
