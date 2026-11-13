// The restored baseline, reconciled before the forecast lane records anything.
//
// The restore job loads the v1 archive inside one transaction and reconciles it there
// (`application/restore.ts`), but nothing re-checked that baseline afterwards. A
// scheduled recording run is the first thing that writes to the same database, so the
// reduced #243 acceptance asks for the baseline to be reconciled BEFORE the first
// recording, with the excluded paper balances and orders proved unchanged.
//
// Every fact this needs is already persisted: migration 0002 gives every restored row a
// `restore_run_id` that references `engine.restore_run`, and 0005's overlay row carries
// either `origin_run_id` (a cycle recorded it) or `origin_restore_run_id` (it was adopted
// from a restored forecast row), never both. So the baseline is derivable by counting,
// with no new table, column, grant or migration: a restored table whose total row count
// exceeds the count attributable to the baseline run has rows the restore did not put
// there, which is exactly the divergence an operator must see before recording begins.
//
// This module is pure: no store, no clock, no environment. It decides; the adapter reads
// and the application refuses.

/** One restored table, as counted in the store. */
export interface ForecastBaselineTable {
  /** Every row in the table right now. */
  readonly total: number;
  /** Rows carrying the baseline restore run's id. */
  readonly attributedToBaseline: number;
}

/** A completed restore run, identified the way `engine.restore_run` identifies one. */
export interface ForecastBaselineRun {
  readonly runId: string;
  readonly manifestDigest: string;
  readonly schemaVersion: string;
}

export interface ForecastBaselineSnapshot {
  /** Restore runs with `completed_at` set. Exactly one is the baseline. */
  readonly completedRuns: readonly ForecastBaselineRun[];
  /** Restore runs that opened and never completed; a partial load is not a baseline. */
  readonly openRuns: number;
  /** `engine.ledger_state` — the restored paper balances. */
  readonly ledgerState: ForecastBaselineTable;
  /** `engine.ledger_order` — the restored paper orders. */
  readonly ledgerOrders: ForecastBaselineTable;
  /** `engine.forecast_row` — the restored forecast rows. */
  readonly forecastRows: ForecastBaselineTable;
  /** 0005's overlay, split by origin. */
  readonly cycleRows: {
    /** Adopted from a restored forecast row (`origin_restore_run_id` set). */
    readonly adoptedFromBaseline: number;
    /** Recorded by a cycle run (`origin_run_id` set). */
    readonly recordedByRuns: number;
  };
}

/** Fixed codes, in the order `evaluateForecastBaseline` reports them. Each one names a
 * state an operator has to resolve before a recording run may write. */
export const FORECAST_BASELINE_DIVERGENCES = [
  /** The snapshot is not a snapshot: a missing field, a non-integer or a negative count.
   * Nothing is believed from a malformed read. */
  'baseline-malformed',
  /** No restore run has completed, so there is no baseline to record against. */
  'baseline-missing',
  /** More than one restore run completed; which one is the baseline is not this job's
   * choice to make. */
  'baseline-ambiguous',
  /** A restore run opened and never completed. A partial load may have left rows behind,
   * so the baseline is not trustworthy even when another run did complete. */
  'baseline-incomplete',
  /** `engine.ledger_state` holds rows the baseline restore did not load: the excluded
   * paper balances are not unchanged. */
  'paper-state-changed',
  /** `engine.ledger_order` holds rows the baseline restore did not load. */
  'paper-orders-changed',
  /** `engine.forecast_row` holds rows the baseline restore did not load. */
  'forecast-baseline-changed',
  /** More overlay rows claim to be adopted from the baseline than the baseline has
   * forecast rows, so the adoption cannot be a faithful copy of it. */
  'baseline-adoption-exceeds-restored',
] as const;
export type ForecastBaselineDivergence = (typeof FORECAST_BASELINE_DIVERGENCES)[number];

export type ForecastBaselineDecision =
  | {
      readonly kind: 'reconciled';
      readonly baseline: ForecastBaselineRun;
      /** Overlay rows already recorded by a cycle run. Zero before the first recording
       * run; non-zero afterwards, which is not a divergence. */
      readonly recordedByRuns: number;
    }
  | { readonly kind: 'refused'; readonly divergences: readonly ForecastBaselineDivergence[] };

const count = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const table = (value: unknown): value is ForecastBaselineTable =>
  typeof value === 'object' &&
  value !== null &&
  count((value as ForecastBaselineTable).total) &&
  count((value as ForecastBaselineTable).attributedToBaseline);
const run = (value: unknown): value is ForecastBaselineRun => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as ForecastBaselineRun;
  return (
    [candidate.runId, candidate.manifestDigest, candidate.schemaVersion] as readonly unknown[]
  ).every((field) => typeof field === 'string' && field.length > 0 && field.trim() === field);
};

/**
 * Decide whether the restored baseline reconciles. Collects every divergence rather than
 * returning the first, so one refusal names everything an operator has to look at, and
 * fails closed on anything it cannot read. Never throws.
 */
export function evaluateForecastBaseline(snapshot: unknown): ForecastBaselineDecision {
  const refused = (
    ...divergences: readonly ForecastBaselineDivergence[]
  ): ForecastBaselineDecision => ({ divergences, kind: 'refused' });
  if (typeof snapshot !== 'object' || snapshot === null) return refused('baseline-malformed');
  const value = snapshot as ForecastBaselineSnapshot;
  if (
    !Array.isArray(value.completedRuns) ||
    !value.completedRuns.every(run) ||
    !count(value.openRuns) ||
    !table(value.ledgerState) ||
    !table(value.ledgerOrders) ||
    !table(value.forecastRows) ||
    typeof value.cycleRows !== 'object' ||
    value.cycleRows === null ||
    !count(value.cycleRows.adoptedFromBaseline) ||
    !count(value.cycleRows.recordedByRuns)
  )
    return refused('baseline-malformed');

  const divergences: ForecastBaselineDivergence[] = [];
  if (value.completedRuns.length === 0) divergences.push('baseline-missing');
  if (value.completedRuns.length > 1) divergences.push('baseline-ambiguous');
  if (value.openRuns > 0) divergences.push('baseline-incomplete');
  // A restored table may hold only what the baseline run loaded. `total` below
  // `attributedToBaseline` is impossible from one read, so the comparison is inequality
  // rather than `>`: either direction means the counts do not describe one baseline.
  if (value.ledgerState.total !== value.ledgerState.attributedToBaseline)
    divergences.push('paper-state-changed');
  if (value.ledgerOrders.total !== value.ledgerOrders.attributedToBaseline)
    divergences.push('paper-orders-changed');
  if (value.forecastRows.total !== value.forecastRows.attributedToBaseline)
    divergences.push('forecast-baseline-changed');
  if (value.cycleRows.adoptedFromBaseline > value.forecastRows.attributedToBaseline)
    divergences.push('baseline-adoption-exceeds-restored');
  if (divergences.length > 0) return refused(...divergences);
  return {
    baseline: value.completedRuns[0]!,
    kind: 'reconciled',
    recordedByRuns: value.cycleRows.recordedByRuns,
  };
}
