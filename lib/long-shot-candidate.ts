import type { PositionSide } from './types';
import { CONTRACT_SLOT_SECONDS } from './feeds';
import { sideAskCents, sideBidCents, type ContractPathRecord } from './contract-path';

/**
 * Band-independent candidate summaries, derived from recorded contract paths.
 *
 * This exists so an operator can define a new `(entry range, exit)` band and see it measured immediately,
 * without re-reading months of paths and without any band ever being baked into storage — the failure
 * `lib/contract-path.ts` refuses for entry marks, applied to bands.
 *
 * Observation only. Nothing here may gate, size, price, or trade, and nothing that can do those things may
 * import it. Pure and I/O free. See docs/long-shot-policy-design.md §15a.
 */
export const LONG_SHOT_CANDIDATE_VERSION = 'long-shot-candidate-marks-v2';

/**
 * Cycle length, read from the module that owns slot math rather than written as 900 here — AGENTS §2
 * forbids recomputing a slot boundary inline.
 */
const CYCLE_SECONDS = CONTRACT_SLOT_SECONDS;

/**
 * Latest offset retained.
 *
 * The one deliberate limit in this structure. Keeping every offset would carry the whole cycle and cost
 * about 9.7 MB at retention against 7.4 MB here; keeping only the current entry window would cost 3.7 MB
 * but would freeze `minimumSecondsRemaining` at its present value, which is exactly the kind of baked-in
 * parameter this design exists to avoid — it has already moved once, and §7 says the evidence would
 * support widening it. At 600s every `minimumSecondsRemaining` of 300 or more stays answerable; going
 * wider than the first ten minutes needs re-collection.
 */
export const CANDIDATE_OFFSET_CAP_SECONDS = 600;

export interface CandidateMark {
  offsetSeconds: number;
  askCents: number;
  /** Highest owned-side bid reachable strictly after this offset. */
  peakBidAfterCents: number;
  /**
   * Lowest owned-side bid reachable strictly after this offset.
   *
   * The mirror of the peak, and what makes a stop-loss evaluable without committing to a level: a stop at
   * S would have fired exactly when this falls to or below S. Stored rather than a chosen stop for the
   * same reason no entry mark is stored — picking the level now would mean re-collecting to re-choose it.
   *
   * Ordering against the peak is deliberately not recorded, because the rule this serves holds to
   * settlement and has no take-profit: whether the trough came before or after the peak cannot change
   * whether the stop fired. A rule with both a stop and a target would need more than this.
   */
  troughBidAfterCents: number;
}

export interface LongShotCandidate {
  contractId: string;
  symbol: string;
  closesAt: string;
  side: PositionSide;
  /** Authoritative venue settlement. Absent until the window resolves; such rows cannot be graded. */
  settledSide?: PositionSide;
  marks: CandidateMark[];
}

/**
 * Every distinct ask this side showed, at its **earliest** offset, with the peak bid reachable after it.
 *
 * Earliest-per-distinct-ask is what makes an arbitrary band answerable: the first sample inside
 * `(low, high]` within any prefix of the cycle is the lowest-offset retained mark whose ask lands in range,
 * so one structure serves every band and every entry window without re-reading the path.
 *
 * **A running-minimum ladder is the wrong structure and was measured to be wrong.** It records only new
 * lows, but a side at 30¢ that rises to 42¢ enters `(40, 45]` on the way up and has no new low to record.
 * Checked against a direct path scan it disagreed on 55 of 77 bands, worst at the high bands. This form
 * reproduced the same scan on 89 of 89. Any change here must be re-checked the same way — the failure is
 * silent and produces entirely plausible numbers.
 */
export function candidateMarks(record: ContractPathRecord, side: PositionSide): CandidateMark[] {
  const points = [...record.points].sort((left, right) => left.offsetSeconds - right.offsetSeconds);
  // Suffix extrema, so the peak and trough after each offset are one backward pass rather than a scan per
  // sample.
  const peakAfter = new Array<number>(points.length).fill(Number.NEGATIVE_INFINITY);
  const troughAfter = new Array<number>(points.length).fill(Number.POSITIVE_INFINITY);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    peakAfter[index] = Math.max(sideBidCents(points[index + 1], side), peakAfter[index + 1]);
    troughAfter[index] = Math.min(sideBidCents(points[index + 1], side), troughAfter[index + 1]);
  }

  const seen = new Set<number>();
  const marks: CandidateMark[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point.offsetSeconds > CANDIDATE_OFFSET_CAP_SECONDS) break;
    const askCents = sideAskCents(point, side);
    // Fail closed on a missing quote rather than recording a zero, which would read as a free contract.
    if (!(askCents > 0) || seen.has(askCents)) continue;
    // The last sample of a window has nothing after it, so it can never be an entry.
    if (!Number.isFinite(peakAfter[index])) continue;
    seen.add(askCents);
    marks.push({
      offsetSeconds: point.offsetSeconds, askCents,
      peakBidAfterCents: peakAfter[index], troughBidAfterCents: troughAfter[index],
    });
  }
  return marks;
}

export function candidatesFromPath(
  record: ContractPathRecord,
  settledSide?: PositionSide,
): LongShotCandidate[] {
  const candidates: LongShotCandidate[] = [];
  for (const side of ['UP', 'DOWN'] as const) {
    const marks = candidateMarks(record, side);
    if (!marks.length) continue;
    candidates.push({
      contractId: record.contractId, symbol: record.symbol, closesAt: record.closesAt, side, settledSide, marks,
    });
  }
  return candidates;
}

/**
 * The entry this band would have taken on one candidate, or null.
 *
 * `minimumSecondsRemaining` is applied here rather than at collection, so the entry window stays a query.
 */
export function bandEntry(
  candidate: LongShotCandidate,
  band: { entryLowCents: number; entryHighCents: number },
  minimumSecondsRemaining: number,
): CandidateMark | null {
  let best: CandidateMark | null = null;
  for (const mark of candidate.marks) {
    if (mark.askCents <= band.entryLowCents || mark.askCents > band.entryHighCents) continue;
    if (CYCLE_SECONDS - mark.offsetSeconds < minimumSecondsRemaining) continue;
    if (!best || mark.offsetSeconds < best.offsetSeconds) best = mark;
  }
  return best;
}

/** Compact wire form: `[contractId, symbol, closesAt, side, settledSide, [[offset, ask, peak, trough], …]]`. */
export function encodeCandidate(candidate: LongShotCandidate): unknown[] {
  return [
    candidate.contractId, candidate.symbol, candidate.closesAt, candidate.side, candidate.settledSide ?? null,
    candidate.marks.map((mark) => [mark.offsetSeconds, mark.askCents, mark.peakBidAfterCents, mark.troughBidAfterCents]),
  ];
}

export function decodeCandidate(encoded: unknown): LongShotCandidate | null {
  if (!Array.isArray(encoded) || encoded.length < 6) return null;
  const [contractId, symbol, closesAt, side, settledSide, rawMarks] = encoded;
  if (typeof contractId !== 'string' || typeof symbol !== 'string' || typeof closesAt !== 'string') return null;
  if (side !== 'UP' && side !== 'DOWN') return null;
  if (!Number.isFinite(Date.parse(closesAt)) || !Array.isArray(rawMarks)) return null;
  const marks: CandidateMark[] = [];
  for (const raw of rawMarks) {
    // v1 rows carry no trough. They are dropped rather than defaulted: a missing trough read as 0 would
    // fire every stop, and read as 100 would fire none — both silently wrong.
    if (!Array.isArray(raw) || raw.length < 4) continue;
    const [offsetSeconds, askCents, peakBidAfterCents, troughBidAfterCents] = raw.map(Number);
    if (![offsetSeconds, askCents, peakBidAfterCents, troughBidAfterCents].every(Number.isFinite)) continue;
    marks.push({ offsetSeconds, askCents, peakBidAfterCents, troughBidAfterCents });
  }
  if (!marks.length) return null;
  return {
    contractId, symbol, closesAt, side,
    settledSide: settledSide === 'UP' || settledSide === 'DOWN' ? settledSide : undefined,
    marks,
  };
}
