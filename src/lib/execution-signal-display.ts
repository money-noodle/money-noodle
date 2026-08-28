import type { ExecutionSignalReadiness } from './types';

export interface ExecutionSignalDisplay {
  label: string;
  detail: string;
  className: string;
}

/**
 * Pure bounded read model: labels describe state, while attempt ceilings stay in audit detail.
 *
 * One managed maker is followed only by bounded taker intents (DEC-20260827-02), so a missed maker either
 * still has a fallback authorized or the sequence is over. The retired episodes design also had the maker
 * collecting fresh snapshots toward a further attempt; those labels are gone with the behavior.
 */
export function executionSignalDisplay(readiness: ExecutionSignalReadiness | undefined): ExecutionSignalDisplay {
  const attempt = readiness?.liveAttempt;
  if (attempt) {
    if (attempt.status === 'open') return { label: 'filled · open', detail: `Live entry fill ${attempt.filledCount?.toFixed(2) ?? attempt.quantity.toFixed(2)} of ${attempt.quantity.toFixed(2)} contracts.`, className: 'border-live/35 bg-live/10 text-live' };
    if (attempt.status === 'pending_reservation') return { label: 'live order working', detail: 'A live entry is currently being managed.', className: 'border-live/35 bg-live/10 text-live' };
    if (attempt.status === 'uncertain') return { label: 'execution uncertain', detail: attempt.reason ?? 'Reservation retained until authoritative reconciliation completes.', className: 'border-warn/40 bg-warn/10 text-warn' };
    if (attempt.status === 'unfilled') {
      const baseDetail = attempt.reason ?? 'The entry completed without a fill; no money was spent.';
      if (attempt.requalificationState === 'checks_pending') return {
        label: 'maker missed · episode checks pending', detail: readiness?.portfolio?.reason ?? readiness?.reason ?? baseDetail,
        className: 'border-warn/30 text-warn',
      };
      if (attempt.noFillReason === 'pre_submit_quote_moved') return { label: 'quote moved · sequence ended', detail: baseDetail, className: 'border-muted-foreground/30 text-muted-foreground' };
      if (attempt.noFillReason === 'ioc_no_fill' || attempt.executedStyle === 'taker') return { label: 'taker IOC no fill · sequence ended', detail: baseDetail, className: 'border-muted-foreground/30 text-muted-foreground' };
      return { label: 'maker missed · sequence ended', detail: baseDetail, className: 'border-muted-foreground/30 text-muted-foreground' };
    }
    if (attempt.status === 'rejected') return { label: 'attempted · rejected', detail: attempt.reason ?? 'The live order was rejected before a fill.', className: 'border-warn/30 text-warn' };
    if (attempt.status === 'sold') return { label: 'closed · switched', detail: attempt.reason ?? 'The live position was closed.', className: 'border-muted-foreground/30 text-muted-foreground' };
    if (attempt.status === 'won') return { label: 'settled · won', detail: 'The live position won at settlement.', className: 'border-gain/30 text-gain' };
    if (attempt.status === 'lost') return { label: 'settled · lost', detail: 'The live position lost at settlement.', className: 'border-loss/30 text-loss' };
    return { label: 'settled · invalid', detail: attempt.reason ?? 'The venue invalidated the contract.', className: 'border-muted-foreground/30 text-muted-foreground' };
  }
  if (readiness?.eligible) return { label: 'confirmed · execution checks pending', detail: readiness.reason, className: 'border-data/25 text-data' };
  if (readiness?.reason.includes('final')) return { label: 'entry window closed', detail: readiness.reason, className: 'border-warn/25 text-warn' };
  if (readiness) {
    if (readiness.qualifyingSnapshots === 0) return { label: 'new edge signal · awaiting confirmation', detail: readiness.reason, className: 'border-warn/25 text-warn' };
    if (readiness.qualifyingSnapshots < readiness.requiredSnapshots) return {
      label: `confirming signal · ${readiness.qualifyingSnapshots} of ${readiness.requiredSnapshots}`,
      detail: `${readiness.reason} Requires ${readiness.requiredSnapshots} qualifying snapshots spanning ${readiness.requiredSpanMs / 1000}s.`,
      className: 'border-warn/25 text-warn',
    };
    return { label: 'signal confirmed · execution gate pending', detail: readiness.reason, className: 'border-warn/25 text-warn' };
  }
  return { label: 'checking execution', detail: 'Waiting for the execution ledger to refresh.', className: 'border-muted-foreground/30 text-muted-foreground' };
}
