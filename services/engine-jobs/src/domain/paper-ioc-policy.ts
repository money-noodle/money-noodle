import { boundedTakerLimit, type KalshiPriceRange, type PaperSide } from './paper-pricing.js';
import { venueFeeCents } from './paper-money.js';
import { paperIocPriceQuanta, type IocFillResult } from './paper-ioc.js';
/** Audited source structural constants, not current configuration or route authority. */
export const PAPER_FALLBACK_PRICE_MULTIPLIER = 1.25;
export const PAPER_FALLBACK_CUSHION_TICKS = 2;
export interface PaperFallbackQuote {
  contractId: string;
  side: PaperSide;
  observedAtMs: number;
  bid: number;
  ask: number;
  ranges?: KalshiPriceRange[];
}
export function requalifyPaperFallback(input: {
  contractId: string;
  side: PaperSide;
  quote: PaperFallbackQuote;
  nowMs: number;
  maximumQuoteAgeMs: number;
  probability: number;
  quantity: number;
  referenceMidpoint: number;
  finalMakerLimit: number;
  approvedMaximum: number;
  maximumEntryPrice: number;
}):
  | { allowed: false; reason: string }
  | { allowed: true; limit: number; tickSize: number; netEdge: number } {
  const refuse = (reason: string) => ({ allowed: false as const, reason });
  const q = input.quote;
  if (
    !q ||
    typeof input.contractId !== 'string' ||
    input.contractId.length < 1 ||
    input.contractId.length > 120 ||
    q.contractId !== input.contractId ||
    q.side !== input.side ||
    !['UP', 'DOWN'].includes(input.side) ||
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.maximumQuoteAgeMs) ||
    input.maximumQuoteAgeMs <= 0 ||
    !Number.isSafeInteger(q.observedAtMs) ||
    q.observedAtMs > input.nowMs ||
    input.nowMs - q.observedAtMs > input.maximumQuoteAgeMs
  )
    return refuse('exact-contract-quote-invalid');
  if (
    ![
      q.bid,
      q.ask,
      input.probability,
      input.quantity,
      input.referenceMidpoint,
      input.finalMakerLimit,
      input.approvedMaximum,
      input.maximumEntryPrice,
    ].every(Number.isFinite) ||
    q.bid <= 0 ||
    q.ask <= q.bid ||
    q.ask >= 1 ||
    input.probability < 0 ||
    input.probability > 1 ||
    input.quantity <= 0 ||
    input.quantity > 1000000 ||
    Math.abs(input.quantity * 100 - Math.round(input.quantity * 100)) > 1e-8 ||
    input.referenceMidpoint <= 0 ||
    input.referenceMidpoint >= 1 ||
    input.finalMakerLimit <= 0 ||
    input.finalMakerLimit >= 1 ||
    input.maximumEntryPrice <= 0 ||
    input.maximumEntryPrice >= 1 ||
    input.approvedMaximum <= 0 ||
    input.approvedMaximum >= 1
  )
    return refuse('fallback-terms-invalid');
  const ceiling = Math.min(
    input.maximumEntryPrice,
    input.finalMakerLimit * PAPER_FALLBACK_PRICE_MULTIPLIER,
    input.approvedMaximum,
  );
  let terms: { limit: number; tickSize: number } | null;
  try {
    terms = boundedTakerLimit({
      ask: q.ask,
      maximumPrice: ceiling,
      cushionTicks: PAPER_FALLBACK_CUSHION_TICKS,
      ...(q.ranges ? { ranges: q.ranges } : {}),
    });
  } catch {
    return refuse('venue-ladder-invalid');
  }
  if (!terms || terms.limit + 1e-9 < q.ask) return refuse('fallback-cap-exceeded');
  if ((q.bid + q.ask) / 2 + terms.tickSize + 1e-9 < input.referenceMidpoint)
    return refuse('fallback-midpoint-declined');
  const fee = venueFeeCents('kalshi', terms.limit * 100, input.quantity, 'taker');
  const netEdge = input.probability - terms.limit - fee / (input.quantity * 100);
  if (!(netEdge > 1e-12)) return refuse('fallback-edge-not-positive');
  return { allowed: true, ...terms, netEdge };
}
export type PaperIocAccountingPlan =
  | {
      status: 'rejected' | 'unfilled';
      releasedCents: number;
      noFillReason: 'data_unavailable' | 'pre_submit_quote_moved' | 'ioc_no_fill';
    }
  | {
      status: 'open';
      stakeCents: number;
      feeCents: number;
      releasedCents: number;
      filledCount: number;
      potentialPayoutCents: number;
    };
/** Caller applies one plan atomically/idempotently. This helper makes NO budget or order writes. */
export function paperIocAccountingPlan(
  reservationCents: number,
  result:
    | { kind: 'data-unavailable' }
    | { kind: 'quote-refused' }
    | { kind: 'observed'; fill: IocFillResult },
  requestedCount: number,
  authorizedMaximumPrice: number,
): PaperIocAccountingPlan {
  const maximumPrice = paperIocPriceQuanta(authorizedMaximumPrice) / 1000000;
  if (
    !Number.isFinite(requestedCount) ||
    requestedCount <= 0 ||
    requestedCount > 1000000 ||
    Math.abs(requestedCount - Math.round(requestedCount * 100) / 100) > 1e-12 ||
    !Number.isSafeInteger(reservationCents) ||
    reservationCents <= 0
  )
    throw new Error('Invalid IOC reservation.');
  if (result.kind === 'data-unavailable')
    return {
      status: 'rejected',
      releasedCents: reservationCents,
      noFillReason: 'data_unavailable',
    };
  if (result.kind === 'quote-refused')
    return {
      status: 'unfilled',
      releasedCents: reservationCents,
      noFillReason: 'pre_submit_quote_moved',
    };
  const f = result.fill;
  if (
    !f ||
    ![f.filledCount, f.averagePrice, f.cashCents].every(Number.isFinite) ||
    f.filledCount < 0 ||
    f.filledCount > requestedCount ||
    f.cashCents < 0 ||
    Math.abs(f.filledCount - Math.round(f.filledCount * 100) / 100) > 1e-12
  )
    throw new Error('Invalid IOC fill evidence.');
  if (f.filledCount === 0) {
    if (f.cashCents !== 0) throw new Error('Zero IOC fill carried cost.');
    return { status: 'unfilled', releasedCents: reservationCents, noFillReason: 'ioc_no_fill' };
  }
  if (
    f.averagePrice <= 0 ||
    f.averagePrice >= 1 ||
    f.averagePrice > maximumPrice + 1e-12 ||
    f.cashCents > f.filledCount * maximumPrice * 100 + f.filledCount * 1e-10 ||
    Math.abs(f.cashCents - f.filledCount * f.averagePrice * 100) > 1e-6
  )
    throw new Error('Inconsistent IOC cash evidence.');
  const feeCents = venueFeeCents('kalshi', f.averagePrice * 100, f.filledCount, 'taker'),
    stakeCents = Math.ceil(f.cashCents - 1e-9) + feeCents,
    potentialPayoutCents = Math.round(f.filledCount * 100);
  if (
    !Number.isSafeInteger(stakeCents) ||
    stakeCents > reservationCents ||
    !Number.isSafeInteger(potentialPayoutCents)
  )
    throw new Error('IOC fill exceeded reservation.');
  return {
    status: 'open',
    stakeCents,
    feeCents,
    releasedCents: reservationCents - stakeCents,
    filledCount: f.filledCount,
    potentialPayoutCents,
  };
}
