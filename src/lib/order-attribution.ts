import { normalizeMarketId } from './market-registry';
import type { ExecutionMode, PaperOrder, TradeTrackRecord } from './types';

export const UNATTRIBUTED_ORDER_IDENTITY = 'unattributed';

export interface OrderAttribution {
  mode: ExecutionMode;
  providerId: string;
  providerVariantId: string;
  marketId: string;
  forecastModelVersion: string;
  buyPolicyVersion: string;
  executionPolicyVersion: string;
}

export interface AttributedTradeRecord {
  attribution: OrderAttribution;
  record: TradeTrackRecord;
}

export interface OrderAttributionFilters {
  modes: string[];
  providerIds: string[];
  providerVariantIds: string[];
  marketIds: string[];
  forecastModelVersions: string[];
  buyPolicyVersions: string[];
  executionPolicyVersions: string[];
}

export type OrderAttributionFilterKey = keyof OrderAttributionFilters;
export interface OrderAttributionFacetValue { value: string; count: number }
export type OrderAttributionFacets = Record<OrderAttributionFilterKey, OrderAttributionFacetValue[]>;

export const EMPTY_ORDER_ATTRIBUTION_FILTERS: OrderAttributionFilters = {
  modes: [], providerIds: [], providerVariantIds: [], marketIds: [], forecastModelVersions: [],
  buyPolicyVersions: [], executionPolicyVersions: [],
};

const QUERY_FIELDS: Array<{ parameter: string; key: OrderAttributionFilterKey }> = [
  { parameter: 'mode', key: 'modes' },
  { parameter: 'provider', key: 'providerIds' },
  { parameter: 'variant', key: 'providerVariantIds' },
  { parameter: 'market', key: 'marketIds' },
  { parameter: 'forecast', key: 'forecastModelVersions' },
  { parameter: 'buyPolicy', key: 'buyPolicyVersions' },
  { parameter: 'executionPolicy', key: 'executionPolicyVersions' },
];

const present = (value: string | undefined): string => value?.trim() || UNATTRIBUTED_ORDER_IDENTITY;

/** Pure issuance identity. Missing non-inferable history stays explicit rather than becoming current policy. */
export function orderAttribution(order: PaperOrder): OrderAttribution {
  return {
    mode: order.executionMode,
    providerId: order.providerId ?? order.entryDecision?.providerId ?? order.venue,
    providerVariantId: present(order.providerVariantId ?? order.entryDecision?.providerVariantId),
    marketId: normalizeMarketId(order.marketId),
    forecastModelVersion: present(order.entryDecision?.forecastModelVersion),
    buyPolicyVersion: present(order.entryDecision?.policyVersion),
    executionPolicyVersion: present(
      order.entryDecision?.executionPolicyVersion ?? order.entryExecutionDecision?.policyVersion,
    ),
  };
}

function selected(values: string[], value: string): boolean {
  return values.length === 0 || values.includes(value);
}

/** OR inside a dimension; AND across dimensions. */
export function orderMatchesAttribution(order: PaperOrder, filters: OrderAttributionFilters): boolean {
  const identity = orderAttribution(order);
  return selected(filters.modes, identity.mode)
    && selected(filters.providerIds, identity.providerId)
    && selected(filters.providerVariantIds, identity.providerVariantId)
    && selected(filters.marketIds, identity.marketId)
    && selected(filters.forecastModelVersions, identity.forecastModelVersion)
    && selected(filters.buyPolicyVersions, identity.buyPolicyVersion)
    && selected(filters.executionPolicyVersions, identity.executionPolicyVersion);
}

const facetValue = (attribution: OrderAttribution, key: OrderAttributionFilterKey): string => {
  switch (key) {
    case 'modes': return attribution.mode;
    case 'providerIds': return attribution.providerId;
    case 'providerVariantIds': return attribution.providerVariantId;
    case 'marketIds': return attribution.marketId;
    case 'forecastModelVersions': return attribution.forecastModelVersion;
    case 'buyPolicyVersions': return attribution.buyPolicyVersion;
    case 'executionPolicyVersions': return attribution.executionPolicyVersion;
  }
};

/** Facets describe the complete supplied population, before the current selection narrows it. */
export function buildOrderAttributionFacets(orders: PaperOrder[]): OrderAttributionFacets {
  const counts = Object.fromEntries(
    Object.keys(EMPTY_ORDER_ATTRIBUTION_FILTERS).map((key) => [key, new Map<string, number>()]),
  ) as Record<OrderAttributionFilterKey, Map<string, number>>;
  for (const order of orders) {
    const attribution = orderAttribution(order);
    for (const key of Object.keys(counts) as OrderAttributionFilterKey[]) {
      const value = facetValue(attribution, key);
      counts[key].set(value, (counts[key].get(value) ?? 0) + 1);
    }
  }
  return Object.fromEntries((Object.keys(counts) as OrderAttributionFilterKey[]).map((key) => [key,
    [...counts[key]].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  ])) as OrderAttributionFacets;
}

function queryValues(search: URLSearchParams, parameter: string): string[] {
  const values = search.getAll(parameter).flatMap((value) => value.split(','))
    .map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => value.length > 160) || values.length > 20) {
    throw new Error(`Invalid ${parameter} attribution filter.`);
  }
  return [...new Set(values)];
}

export function parseOrderAttributionFilters(search: URLSearchParams): OrderAttributionFilters {
  const filters = { ...EMPTY_ORDER_ATTRIBUTION_FILTERS };
  for (const { parameter, key } of QUERY_FIELDS) filters[key] = queryValues(search, parameter);
  if (filters.modes.some((mode) => mode !== 'live' && mode !== 'paper')) {
    throw new Error('Invalid mode attribution filter.');
  }
  return filters;
}

export function unknownOrderAttributionFilters(
  filters: OrderAttributionFilters,
  facets: OrderAttributionFacets,
): Array<{ key: OrderAttributionFilterKey; value: string }> {
  return (Object.keys(filters) as OrderAttributionFilterKey[]).flatMap((key) => {
    const available = new Set(facets[key].map((item) => item.value));
    return filters[key].filter((value) => !available.has(value)).map((value) => ({ key, value }));
  });
}

export function orderAttributionSearchParams(filters: OrderAttributionFilters): URLSearchParams {
  const search = new URLSearchParams();
  for (const { parameter, key } of QUERY_FIELDS) {
    if (filters[key].length) search.set(parameter, filters[key].join(','));
  }
  return search;
}
