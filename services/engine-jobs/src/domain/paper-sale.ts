import { venueFeeCents, type PaperVenue } from './paper-money.js';
import type { PaperSide } from './paper-pricing.js';
import type { IocFillResult } from './paper-ioc.js';
export const PAPER_SALE_MODEL = 'paper-ioc-exit-depth-v1';
export interface PaperSaleIdentity {
  orderId: string;
  originalLedgerPosition: number | null;
  epoch: number;
  fundingId: string;
  contractId: string;
  side: PaperSide;
  venue: PaperVenue;
}
export interface PaperSalePosition {
  identity: PaperSaleIdentity;
  quantity: number;
  reservedStakeCents: number;
  actualStakeCents: number;
  actualPurchaseCents: number;
  actualFeeCents: number;
}
export type PaperSaleEvidence =
  | { kind: 'unavailable' }
  | {
      kind: 'observed';
      contractId: string;
      side: PaperSide;
      observedAtMs: number;
      fill: IocFillResult;
    };
export interface PaperSaleTerms {
  position: PaperSalePosition;
  evidence: PaperSaleEvidence;
  nowMs: number;
  maximumBookAgeMs: number;
  saleEventId: string;
}
export interface PaperSoldCost {
  quantity: number;
  reservedStakeCents: number;
  actualStakeCents: number;
  actualPurchaseCents: number;
  actualFeeCents: number;
  potentialPayoutCents: number;
  exitFeeCents: number;
  rawSaleProceedsCents: number;
  integerBudgetCreditCents: number;
  realizedDeltaCents: number;
  actualPnlCents: number;
}
export type PaperSalePlan =
  | { kind: 'deferred'; identity: PaperSaleIdentity; recordAttempt: false }
  | {
      kind: 'no-fill';
      identity: PaperSaleIdentity;
      recordAttempt: true;
      disableAutomaticRetry: true;
    }
  | {
      kind: 'sold';
      identity: PaperSaleIdentity;
      saleEventId: string;
      recordAttempt: true;
      disableAutomaticRetry: true;
      clearEntryPersistence: boolean;
      countsForReentryGeneration: boolean;
      sold: PaperSoldCost;
      remaining: (Omit<PaperSalePosition, 'identity'> & { potentialPayoutCents: number }) | null;
    };
const id = (s: string) => typeof s === 'string' && s.length > 0 && s.length <= 256;
const lattice = (q: number, venue: PaperVenue) =>
  Number.isFinite(q) &&
  q >= 0 &&
  q <= 1000000 &&
  Math.abs((venue === 'kalshi' ? q * 100 : q) - Math.round(venue === 'kalshi' ? q * 100 : q)) <=
    1e-8;
/** No writes. Parent+sale event identity must acquire genuine store provenance and atomic fencing. */
export function planPaperSale(input: PaperSaleTerms): PaperSalePlan {
  const p = input.position,
    i = p.identity;
  if (
    !i ||
    !id(i.orderId) ||
    !id(i.fundingId) ||
    !id(i.contractId) ||
    !['UP', 'DOWN'].includes(i.side) ||
    !['kalshi', 'polymarket'].includes(i.venue) ||
    !Number.isSafeInteger(i.epoch) ||
    i.epoch < 1 ||
    (i.originalLedgerPosition !== null &&
      (!Number.isSafeInteger(i.originalLedgerPosition) || i.originalLedgerPosition < 0)) ||
    !id(input.saleEventId) ||
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.maximumBookAgeMs) ||
    input.maximumBookAgeMs <= 0
  )
    throw new Error('Invalid explicit sale identity/clock.');
  if (
    !lattice(p.quantity, i.venue) ||
    p.quantity <= 0 ||
    !Number.isSafeInteger(p.reservedStakeCents) ||
    p.reservedStakeCents <= 0 ||
    p.reservedStakeCents > 1000000 ||
    ![p.actualStakeCents, p.actualPurchaseCents, p.actualFeeCents].every(Number.isFinite) ||
    p.actualStakeCents <= 0 ||
    p.actualPurchaseCents < 0 ||
    p.actualFeeCents < 0 ||
    Math.abs(p.actualStakeCents - p.actualPurchaseCents - p.actualFeeCents) > 1e-6 ||
    Math.ceil(p.actualStakeCents - 1e-9) !== p.reservedStakeCents
  )
    throw new Error('Inconsistent sale cost planes.');
  if (input.evidence.kind === 'unavailable')
    return { kind: 'deferred', identity: { ...i }, recordAttempt: false };
  const e = input.evidence,
    f = e.fill;
  if (
    e.contractId !== i.contractId ||
    e.side !== i.side ||
    !Number.isSafeInteger(e.observedAtMs) ||
    e.observedAtMs > input.nowMs ||
    input.nowMs - e.observedAtMs > input.maximumBookAgeMs ||
    !f ||
    !lattice(f.filledCount, i.venue) ||
    f.filledCount > p.quantity ||
    !Number.isFinite(f.cashCents) ||
    f.cashCents < 0 ||
    !Number.isFinite(f.averagePrice)
  )
    throw new Error('Invalid exact-contract sale evidence.');
  if (f.filledCount === 0) {
    if (f.cashCents !== 0) throw new Error('Zero sale fill carried proceeds.');
    return {
      kind: 'no-fill',
      identity: { ...i },
      recordAttempt: true,
      disableAutomaticRetry: true,
    };
  }
  if (
    f.averagePrice <= 0 ||
    f.averagePrice >= 1 ||
    Math.abs(f.cashCents - f.filledCount * f.averagePrice * 100) > 1e-6
  )
    throw new Error('Inconsistent gross sale proceeds.');
  const ratio = f.filledCount / p.quantity,
    partial = f.filledCount + 1e-8 < p.quantity;
  const exitFeeCents = venueFeeCents(i.venue, f.averagePrice * 100, f.filledCount, 'taker'),
    rawSaleProceedsCents = f.cashCents - exitFeeCents,
    integerBudgetCreditCents = Math.max(0, Math.floor(rawSaleProceedsCents + 1e-9));
  const remainingActualStake = partial ? p.actualStakeCents - p.actualStakeCents * ratio : 0,
    remainingReserved = partial ? Math.ceil(remainingActualStake - 1e-9) : 0,
    releasedStake = p.reservedStakeCents - remainingReserved;
  if (
    !Number.isSafeInteger(integerBudgetCreditCents) ||
    !Number.isSafeInteger(remainingReserved) ||
    remainingReserved < 0 ||
    releasedStake < 0
  )
    throw new Error('Unsafe sale conservation.');
  const sold: PaperSoldCost = {
    quantity: f.filledCount,
    reservedStakeCents: releasedStake,
    actualStakeCents: p.actualStakeCents * ratio,
    actualPurchaseCents: p.actualPurchaseCents * ratio,
    actualFeeCents: p.actualFeeCents * ratio,
    potentialPayoutCents: Math.round(f.filledCount * 100),
    exitFeeCents,
    rawSaleProceedsCents,
    integerBudgetCreditCents,
    realizedDeltaCents: integerBudgetCreditCents - releasedStake,
    actualPnlCents: rawSaleProceedsCents - p.actualStakeCents * ratio,
  };
  const remaining = partial
    ? {
        quantity: Number((p.quantity - f.filledCount).toFixed(2)),
        reservedStakeCents: remainingReserved,
        actualStakeCents: remainingActualStake,
        actualPurchaseCents: p.actualPurchaseCents * (1 - ratio),
        actualFeeCents: p.actualFeeCents * (1 - ratio),
        potentialPayoutCents: Math.round((p.quantity - f.filledCount) * 100),
      }
    : null;
  return {
    kind: 'sold',
    identity: { ...i },
    saleEventId: input.saleEventId,
    recordAttempt: true,
    disableAutomaticRetry: true,
    clearEntryPersistence: !partial,
    countsForReentryGeneration: !partial,
    sold,
    remaining,
  };
}
