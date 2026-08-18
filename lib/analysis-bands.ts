import { bandEntry, type LongShotCandidate } from './long-shot-candidate';

/**
 * Operator-defined analysis bands, and the measurement of one band against recorded candidates.
 *
 * **These are analysis bands, never entry bands.** They describe a hypothesis being screened, not a rule
 * being run. AGENTS §5.5 governs: retroactive screening may filter an idea and may never promote one, so
 * nothing that can price, size, gate, or trade may import this module — `lib/analysis-bands.test.ts`
 * asserts that, and the day someone wires a good-looking band into `entryMarkCents` the build breaks
 * rather than the desk changing behaviour.
 *
 * Pure and I/O free. See docs/long-shot-policy-design.md §15a.
 */
export const ANALYSIS_BANDS_VERSION = 'long-shot-analysis-bands-v1';

/** Bounds the grid and, more importantly, the multiple-comparison budget the surface has to display. */
export const MAX_ANALYSIS_BANDS = 20;

export interface AnalysisBand {
  /** Stable identity across saves, so a band's history survives reordering and relabelling. */
  id: string;
  label: string;
  /** Entry qualifies on `(entryLowCents, entryHighCents]` — exclusive low, inclusive high. */
  entryLowCents: number;
  entryHighCents: number;
  exitCents: number;
}

export interface AnalysisBandResult {
  band: AnalysisBand;
  /** Candidates whose ask entered the band inside the entry window. */
  candidates: number;
  /** Independent settlement windows, which is the unit uncertainty is read at. */
  windows: number;
  /** Candidates whose owned-side bid later reached the exit. A floor at the sampling cadence. */
  touched: number;
  touchRate: number | null;
  /** Touch rate this band needs to break even if a miss paid zero. */
  breakEvenRate: number | null;
  /** touchRate / breakEvenRate. Above 1.00 pays under that pessimistic accounting. */
  ratio: number | null;
  /** Return per $1 staked with misses graded at settlement, clustered on the settlement window. */
  meanReturn: number | null;
  standardError: number | null;
  /** Candidates whose window has not resolved, so they cannot be graded. Counted, never treated as zero. */
  ungraded: number;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/**
 * Validates and normalises one band, or explains why it cannot be used.
 *
 * Rejects rather than repairs an inverted or out-of-range band: silently widening what an operator typed
 * would attribute results to a band they did not define.
 */
export function normaliseBand(input: Partial<AnalysisBand>, index: number): { band: AnalysisBand } | { error: string } {
  const label = String(input.label ?? '').trim();
  if (!label) return { error: `Band ${index + 1} needs a label.` };
  if (label.length > 40) return { error: `Band "${label.slice(0, 20)}…" has a label longer than 40 characters.` };

  const entryLowCents = Math.floor(Number(input.entryLowCents));
  const entryHighCents = Math.floor(Number(input.entryHighCents));
  const exitCents = Math.floor(Number(input.exitCents));
  if (![entryLowCents, entryHighCents, exitCents].every(Number.isFinite)) {
    return { error: `Band "${label}" needs whole-cent entry and exit prices.` };
  }
  if (entryLowCents < 0 || entryLowCents >= entryHighCents) {
    return { error: `Band "${label}" needs its entry low below its entry high.` };
  }
  if (entryHighCents > 99) return { error: `Band "${label}" cannot enter above 99¢.` };
  // At or below the entry there is no round trip to measure, only a loss.
  if (exitCents <= entryHighCents) return { error: `Band "${label}" needs an exit above its entry high.` };
  if (exitCents > 99) return { error: `Band "${label}" cannot exit above 99¢.` };

  return {
    band: {
      id: String(input.id ?? '').trim() || `band-${entryLowCents}-${entryHighCents}-${exitCents}`,
      label,
      entryLowCents: clamp(entryLowCents, 0, 98),
      entryHighCents: clamp(entryHighCents, 1, 99),
      exitCents: clamp(exitCents, 2, 99),
    },
  };
}

export function normaliseBands(input: unknown): { bands: AnalysisBand[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'Expected a list of bands.' };
  if (input.length > MAX_ANALYSIS_BANDS) {
    return { error: `At most ${MAX_ANALYSIS_BANDS} bands; every extra band is another comparison to correct for.` };
  }
  const bands: AnalysisBand[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const result = normaliseBand((raw ?? {}) as Partial<AnalysisBand>, index);
    if ('error' in result) return result;
    // Overlapping bands are allowed — they are distinct hypotheses, not a partition — but an exact
    // duplicate is a double-count of one hypothesis rather than a second one.
    const key = `${result.band.entryLowCents}:${result.band.entryHighCents}:${result.band.exitCents}`;
    if (seen.has(key)) return { error: `Band "${result.band.label}" duplicates another band exactly.` };
    seen.add(key);
    bands.push(result.band);
  }
  return { bands };
}

function clustered(rows: Array<{ key: string; value: number }>): { mean: number | null; standardError: number | null; windows: number } {
  const windows = new Map<string, number[]>();
  for (const row of rows) windows.set(row.key, [...(windows.get(row.key) ?? []), row.value]);
  const perWindow = [...windows.values()]
    .map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  if (!perWindow.length) return { mean: null, standardError: null, windows: 0 };
  const mean = perWindow.reduce((sum, value) => sum + value, 0) / perWindow.length;
  return {
    mean,
    standardError: perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
      : null,
    windows: perWindow.length,
  };
}

export interface BandEvaluationOptions {
  ticketCents: number;
  minimumSecondsRemaining: number;
  /** `estimatePaperFill`, injected so this module stays free of `server-only` and never forks the sizing. */
  fill: (stakeLimitCents: number, askPrice: number) => { quantity: number; stakeCents: number } | null;
  /** `venueFeeCents` at the taker schedule, matching how the exit actually executes. */
  exitFeeCents: (priceCents: number, quantity: number) => number;
}

/**
 * Measures one band over recorded candidates.
 *
 * Returns are clustered on the settlement window — contracts sharing a close share one coin flip, so
 * scoring them as independent trials manufactures significance (AGENTS §5.1). A miss is graded at its
 * actual settlement rather than as a total loss: with no fallback exit a position that misses simply
 * settles, so pricing it at zero sets a harder bar than the strategy faces.
 */
export function evaluateBand(
  candidates: LongShotCandidate[],
  band: AnalysisBand,
  options: BandEvaluationOptions,
): AnalysisBandResult {
  let count = 0;
  let touched = 0;
  let breakEvenSum = 0;
  let ungraded = 0;
  const returns: Array<{ key: string; value: number }> = [];

  for (const candidate of candidates) {
    const entry = bandEntry(candidate, band, options.minimumSecondsRemaining);
    if (!entry) continue;
    const sized = options.fill(options.ticketCents, entry.askCents / 100);
    if (!sized) continue;
    const proceedsCents = sized.quantity * band.exitCents - options.exitFeeCents(band.exitCents, sized.quantity);
    if (!(proceedsCents > 0)) continue;

    count += 1;
    breakEvenSum += sized.stakeCents / proceedsCents;
    const reached = entry.peakBidAfterCents >= band.exitCents;
    if (reached) touched += 1;

    // **Settlement gates the return for touches too, not only for misses.** A touch is priced from the
    // exit alone and needs no outcome, while a miss cannot be priced without one — so admitting touches
    // from unsettled windows while dropping misses from them fills the average with winners. Measured on
    // the live data that read +767% per $1 on a band whose ratio was 0.86. The whole candidate is held
    // back until its window resolves, which keeps the graded cohort an unbiased sample of the band.
    if (!candidate.settledSide) { ungraded += 1; continue; }

    const value = reached
      ? (proceedsCents - sized.stakeCents) / sized.stakeCents
      : ((candidate.settledSide === candidate.side ? sized.quantity * 100 : 0) - sized.stakeCents) / sized.stakeCents;
    returns.push({ key: candidate.closesAt, value });
  }

  const stats = clustered(returns);
  const touchRate = count ? touched / count : null;
  const breakEvenRate = count ? breakEvenSum / count : null;
  return {
    band,
    candidates: count,
    windows: stats.windows,
    touched,
    touchRate,
    breakEvenRate,
    ratio: touchRate !== null && breakEvenRate ? touchRate / breakEvenRate : null,
    meanReturn: stats.mean,
    standardError: stats.standardError,
    ungraded,
  };
}
