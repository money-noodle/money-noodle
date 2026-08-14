import { compareContractTargets, contractSettlementMetadata } from './contract-provenance';
import type {
  ContractComparabilityReport, ContractComparabilityRow, ContractProvenanceRecord, CyclePathPoint,
  CyclePathRecord, PositionSide, TrackedForecast, TradingVenue,
} from './types';

export const CONTRACT_COMPARABILITY_REPORT_VERSION = 'contract-comparability-v1';

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Time integral of sparse Kraken observations, with at most one observation interval extrapolated at either edge. */
export function settlementPathAverage(
  points: CyclePathPoint[],
  closesAt: string,
  windowSeconds: number,
  maximumEdgeGapSeconds = 20,
): number | undefined {
  const closeMs = Date.parse(closesAt);
  const startMs = closeMs - windowSeconds * 1_000;
  if (!Number.isFinite(closeMs) || !(windowSeconds > 0)) return undefined;
  const valid = points
    .map((point) => ({ time: Date.parse(point.at), price: point.price }))
    .filter((point) => Number.isFinite(point.time) && point.price > 0)
    .sort((a, b) => a.time - b.time);
  const before = [...valid].reverse().find((point) => point.time <= startMs);
  const afterStart = valid.find((point) => point.time >= startMs);
  const beforeClose = [...valid].reverse().find((point) => point.time <= closeMs);
  if (!afterStart || !beforeClose) return undefined;
  const startAnchor = before && startMs - before.time <= maximumEdgeGapSeconds * 1_000 ? before : afterStart;
  if (Math.abs(startAnchor.time - startMs) > maximumEdgeGapSeconds * 1_000
    || closeMs - beforeClose.time > maximumEdgeGapSeconds * 1_000) return undefined;
  const inside = valid.filter((point) => point.time > startMs && point.time < closeMs);
  const samples = [{ time: startMs, price: startAnchor.price }, ...inside, { time: closeMs, price: beforeClose.price }];
  let integral = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const duration = (samples[index].time - samples[index - 1].time) / 1_000;
    if (!(duration >= 0)) return undefined;
    integral += duration * (samples[index - 1].price + samples[index].price) / 2;
  }
  return integral / windowSeconds;
}

function contractRecord(
  forecast: TrackedForecast,
  venue: TradingVenue,
  registry: Map<string, ContractProvenanceRecord>,
): ContractProvenanceRecord | undefined {
  const reference = forecast.venueContracts?.[venue];
  return reference ? registry.get(reference.registryId) : undefined;
}

function venueOutcome(forecast: TrackedForecast, venue: TradingVenue, contractId: string): PositionSide | undefined {
  const outcome = forecast.venueOutcomes?.[venue];
  return outcome?.contractId === contractId ? outcome.outcome : undefined;
}

function reportRow(
  forecast: TrackedForecast,
  venue: TradingVenue,
  record: ContractProvenanceRecord,
  path: CyclePathRecord,
): ContractComparabilityRow {
  const metadata = contractSettlementMetadata(record);
  const window = metadata.settlementWindowSeconds;
  const average = window ? settlementPathAverage(path.points, forecast.closesAt, window) : undefined;
  const venueReference = record.referenceValue && record.referenceValue > 0 ? record.referenceValue : undefined;
  const threshold = venueReference ?? path.referencePrice;
  const proxyOutcome: PositionSide | undefined = average === undefined ? undefined : average >= threshold ? 'UP' : 'DOWN';
  const outcome = venueOutcome(forecast, venue, record.contractId);
  return {
    id: `${forecast.symbol}:${forecast.closesAt}:${venue}:${record.contractId}`,
    symbol: forecast.symbol, venue, contractId: record.contractId, closesAt: forecast.closesAt,
    settlementPriceMethod: metadata.settlementPriceMethod,
    referenceWindowSeconds: metadata.referenceWindowSeconds,
    settlementWindowSeconds: metadata.settlementWindowSeconds,
    krakenReferencePrice: path.referencePrice,
    venueReferencePrice: venueReference,
    referenceDriftPercent: venueReference === undefined ? undefined : (path.referencePrice / venueReference - 1) * 100,
    krakenSettlementAverage: average,
    proxyOutcome, venueOutcome: outcome,
    proxyAgreed: proxyOutcome && outcome ? proxyOutcome === outcome : undefined,
  };
}

/**
 * Pure observation-only report. Repeated 15-second forecasts collapse to one asset/window and paired
 * venue outcomes collapse to independent settlement timestamps where the headline says "windows".
 */
export function buildContractComparabilityReport(
  forecasts: TrackedForecast[],
  paths: CyclePathRecord[],
  records: ContractProvenanceRecord[],
): ContractComparabilityReport {
  const registry = new Map(records.map((record) => [record.registryId, record]));
  const pathMap = new Map(paths.map((path) => [`${path.symbol}:${path.closesAt}`, path]));
  const assetWindows = new Map<string, TrackedForecast>();
  for (const forecast of [...forecasts].sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))) {
    const key = `${forecast.symbol}:${forecast.closesAt}`;
    const existing = assetWindows.get(key);
    if (!existing || Object.keys(forecast.venueOutcomes ?? {}).length > Object.keys(existing.venueOutcomes ?? {}).length) assetWindows.set(key, forecast);
  }

  const rows: ContractComparabilityRow[] = [];
  let latestPair: { poly: ContractProvenanceRecord; kalshi: ContractProvenanceRecord; close: number } | undefined;
  const pairedCloses = new Set<string>();
  let pairedAssetWindows = 0;
  let disagreements = 0;
  for (const forecast of assetWindows.values()) {
    const path = pathMap.get(`${forecast.symbol}:${forecast.closesAt}`);
    const poly = contractRecord(forecast, 'polymarket', registry);
    const kalshi = contractRecord(forecast, 'kalshi', registry);
    if (poly && kalshi && (!latestPair || Date.parse(forecast.closesAt) > latestPair.close)) latestPair = { poly, kalshi, close: Date.parse(forecast.closesAt) };
    const polyOutcome = poly ? venueOutcome(forecast, 'polymarket', poly.contractId) : undefined;
    const kalshiOutcome = kalshi ? venueOutcome(forecast, 'kalshi', kalshi.contractId) : undefined;
    if (polyOutcome && kalshiOutcome) {
      pairedCloses.add(forecast.closesAt);
      pairedAssetWindows += 1;
      if (polyOutcome !== kalshiOutcome) disagreements += 1;
    }
    if (!path) continue;
    if (poly) rows.push(reportRow(forecast, 'polymarket', poly, path));
    if (kalshi) rows.push(reportRow(forecast, 'kalshi', kalshi, path));
  }

  const venues = (['polymarket', 'kalshi'] as TradingVenue[]).map((venue) => {
    const selected = rows.filter((row) => row.venue === venue);
    const drift = selected.flatMap((row) => Number.isFinite(row.referenceDriftPercent) ? [row.referenceDriftPercent!] : []);
    const proxy = selected.filter((row) => row.proxyAgreed !== undefined);
    return {
      venue, contracts: selected.length,
      metadataContracts: selected.filter((row) => row.settlementPriceMethod !== 'unknown' && row.settlementWindowSeconds !== undefined).length,
      resolvedWindows: new Set(selected.filter((row) => row.venueOutcome).map((row) => row.closesAt)).size,
      directReferenceDriftSamples: drift.length,
      meanReferenceDriftPercent: mean(drift),
      meanAbsoluteReferenceDriftPercent: mean(drift.map(Math.abs)),
      maximumAbsoluteReferenceDriftPercent: drift.length ? Math.max(...drift.map(Math.abs)) : null,
      proxyOutcomeSamples: proxy.length,
      proxyOutcomeAgreement: proxy.length ? proxy.filter((row) => row.proxyAgreed).length / proxy.length : null,
    };
  });
  return {
    version: CONTRACT_COMPARABILITY_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    comparison: compareContractTargets(latestPair?.poly, latestPair?.kalshi),
    totalContracts: rows.length,
    metadataContracts: rows.filter((row) => row.settlementPriceMethod !== 'unknown' && row.settlementWindowSeconds !== undefined).length,
    pairedOutcomeWindows: pairedCloses.size,
    pairedOutcomeAssetWindows: pairedAssetWindows,
    venueOutcomeDisagreements: disagreements,
    venues,
    recent: [...rows].sort((a, b) => Date.parse(b.closesAt) - Date.parse(a.closesAt)).slice(0, 30),
    productionChanged: false,
  };
}
