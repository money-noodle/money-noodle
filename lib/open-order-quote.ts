import type { PaperOrder } from './types';

export interface OpenOrderVenueQuote {
  bid: number;
  ask: number;
  observedAt: string;
  source: 'position' | 'execution';
}

type QuoteOrder = Pick<PaperOrder, 'entryExecutionObservations' | 'positionObservations'>;

/**
 * Latest valid owned-side venue quote already captured by the execution engine.
 *
 * This is presentation only: it performs no fetch and cannot feed a displayed value back into execution.
 * Position observations normally win because they continue for the life of a fill; execution observations
 * cover a managed order before its first open-position cycle.
 */
export function latestOpenOrderVenueQuote(order: QuoteOrder): OpenOrderVenueQuote | undefined {
  let latest: OpenOrderVenueQuote | undefined;
  const consider = (observedAt: string, bid: number | undefined, ask: number | undefined, source: OpenOrderVenueQuote['source']) => {
    const observedMs = Date.parse(observedAt);
    if (typeof bid !== 'number' || typeof ask !== 'number' || !Number.isFinite(observedMs)
      || !Number.isFinite(bid) || !Number.isFinite(ask)
      || !(bid > 0) || !(ask > 0) || bid > 1 || ask > 1 || bid - ask > 1e-9) return;
    if (!latest || observedMs >= Date.parse(latest.observedAt)) latest = { bid, ask, observedAt, source };
  };

  for (const observation of order.entryExecutionObservations ?? []) {
    consider(observation.at, observation.selectedBid, observation.selectedAsk, 'execution');
  }
  for (const observation of order.positionObservations ?? []) {
    consider(observation.at, observation.selectedBid, observation.selectedAsk, 'position');
  }
  return latest;
}
