import 'server-only';

/**
 * Paper fill calibration: a versioned, bounded parameter held by the independent paper maker queue
 * simulation so it can reproduce the venue's real fill frequency without ever reading a live fill.
 *
 * The one tunable models cancellation/fifo advance: how much of the *initial displayed* queue ahead
 * is cleared by predecessor cancellations and shared priority before aggressive prints arrive. The
 * default is exact-current behavior (queueClearFraction=0). A non-zero value is adopted only by an
 * explicit, recorded manual act with held-out evidence (SPEC §12.5, AGENTS.md §5.5); it is never
 * read from a live order on any entry row.
 */
export const PAPER_FILL_CALIBRATION_VERSION = 'paper-fill-calibration-v1' as const;

export interface PaperFillCalibration {
  version: typeof PAPER_FILL_CALIBRATION_VERSION;
  /** Fraction of the initial displayed queue ahead treated as cancelled / FIFO-advanced. [0, 0.5) */
  queueClearFraction: number;
  /** Identity of the paper execution cohort this calibration was validated under. */
  appliedToPaperExecution: string;
  /** Durable provenance recorded manually at adoption. */
  heldOutWindows: number;
  adoptedAt: string;
  reason: string;
}

export const PAPER_FILL_QUEUE_CLEAR_MAX = 0.5;

export function isPaperFillCalibration(input: unknown): input is PaperFillCalibration {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Partial<PaperFillCalibration>;
  const optional = (
    typeof candidate.appliedToPaperExecution === 'string' || typeof candidate.appliedToPaperExecution === 'undefined'
  ) && (
    typeof candidate.heldOutWindows === 'number' || typeof candidate.heldOutWindows === 'undefined'
  ) && (
    typeof candidate.adoptedAt === 'string' || typeof candidate.adoptedAt === 'undefined'
  ) && (
    typeof candidate.reason === 'string' || typeof candidate.reason === 'undefined'
  );
  return candidate.version === PAPER_FILL_CALIBRATION_VERSION
    && typeof candidate.queueClearFraction === 'number'
    && Number.isFinite(candidate.queueClearFraction)
    && candidate.queueClearFraction >= 0
    && candidate.queueClearFraction < PAPER_FILL_QUEUE_CLEAR_MAX
    && optional;
}

/**
 * Applies the queue-clear fraction to a displayed initial queue ahead. Pure and exact: rounds toward
 * zero with the standard 1e-9 epsilon so a value landing on a float-representation edge stays below
 * the cap and never negative or non-finite.
 */
export function effectiveInitialQueueAhead(displayedAhead: number | undefined, fraction: number): number | undefined {
  if (displayedAhead === undefined || !Number.isFinite(displayedAhead) || displayedAhead < 0) return undefined;
  // The neutral fraction must reproduce the exact upstream value for any incoming displayed-ahead
  // (including sub-unit proxies) rather than flooring it, so a zero calibration can never alter v5.
  if (fraction !== 0 && isSafeQueueClearFractionForNumber(fraction)) {
    const residual = Math.max(0, displayedAhead * (1 - fraction));
    return Math.floor(residual + 1e-9);
  }
  return displayedAhead;
}

function isSafeQueueClearFractionForNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < PAPER_FILL_QUEUE_CLEAR_MAX;
}

/** Bounded, monotonic no-op when no calibration is configured (fraction === 0). */
export function isNeutralCalibration(calibration: PaperFillCalibration | undefined): boolean {
  return calibration === undefined || calibration.queueClearFraction === 0;
}